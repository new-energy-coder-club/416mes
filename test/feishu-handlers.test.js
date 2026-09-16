/**
 * Vercel 云端接口契约测试（api/feishu/*.js）
 *
 * 这些 handler 是网页端与飞书之间的唯一通道，但它们此前**完全没有测试**：
 * 只有 lib/feishu-api.js 被测，handler 里的参数校验一旦写窄（例如强制要求 qty），
 * 前端的 delta 写入就会整条路断掉，而且只在真机上才暴露。
 *
 * 不需要飞书凭据、不联网：mock 顶替 open.feishu.cn。
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

/* ---------- 最小 mock 飞书（与 feishu-api.test.js 同构，只实现用到的接口） ---------- */
function startMock() {
  const tables = {
    tblMAT: { rows: [{ '物料码': 'A-1', '库存数量': 10 }], ids: ['rec_1'] },
    tblTXN: { rows: [], ids: [] },
    tblWIP: { rows: [], ids: [] }
  };
  const fieldTypes = {
    tblMAT: [{ name: '物料码', type: 1 }, { name: '库存数量', type: 2 }, { name: '最后更新时间', type: 1002 }],
    tblTXN: [
      { name: '流水号', type: 1 }, { name: '时间', type: 5 }, { name: '操作人', type: 1 },
      { name: '类型', type: 1 }, { name: '物料码', type: 1 }, { name: '变动', type: 2 },
      { name: '余量', type: 2 }, { name: '关联单', type: 1 }, { name: '原因/备注', type: 1 },
      { name: '操作ID', type: 1 }
    ],
    // 「类型」在**生产**里是单选，选项是全名（'LL 领料'）。之前这里写成普通文本、
    // 值也写短码 'LL'，于是「拿短码去 filter 单选列」这个 bug 在测试里根本显不出来。
    tblWIP: [{ name: '工单号', type: 1 }, { name: '类型', type: 3, options: ['LL 领料', 'BH 补货', 'JH 拣货', 'TL 退料'] }]
  };
  let idSeq = 100;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url.pathname.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 't' });
      const fm = url.pathname.match(/\/tables\/([^/]+)\/fields$/);
      if (fm) return json({ code: 0, data: { items: (fieldTypes[fm[1]] || []).map(f => ({ field_name: f.name, type: f.type })) } });
      const m = url.pathname.match(/\/tables\/([^/]+)\/records(\/[^/]+)?$/);
      if (!m) return json({ code: 404, msg: 'not found' });
      const t = tables[m[1]];
      if (!t) return json({ code: 1254005, msg: 'table not found' });
      const KNOWN = ['', 'search', 'batch_create', 'batch_delete', 'batch_update'];
      const sub = (m[2] || '').replace('/', '');
      const recId = (sub && KNOWN.indexOf(sub) < 0) ? sub : null;
      const action = recId ? 'get' : sub;
      const withIds = () => t.rows.map((r, i) => ({ record_id: t.ids[i], fields: r }));

      if (action === 'get') {
        const i = t.ids.indexOf(recId);
        if (i < 0) return json({ code: 1254004, msg: 'not found' });
        return json({ code: 0, data: { record: { record_id: recId, fields: t.rows[i] } } });
      }
      if (!action) return json({ code: 0, data: { items: withIds(), has_more: false } });
      if (action === 'search') {
        const b = JSON.parse(body || '{}');
        let rows = withIds();
        if (b.filter && b.filter.conditions) {
          rows = rows.filter(r => b.filter.conditions.every(c => {
            const v = r.fields[c.field_name];
            if (c.operator === 'is') return (c.value || []).some(x => String(x) === String(v == null ? '' : v));
            return true;
          }));
        }
        const total = rows.length;
        const size = Math.min(parseInt(url.searchParams.get('page_size') || '500', 10) || 500, 500);
        const off = parseInt(url.searchParams.get('page_token') || '0', 10) || 0;
        return json({ code: 0, data: { items: rows.slice(off, off + size), total, has_more: off + size < total } });
      }
      if (action === 'batch_create') {
        const b = JSON.parse(body || '{}');
        const made = (b.records || []).map(r => { t.rows.push(r.fields); const id = 'new_' + (++idSeq); t.ids.push(id); return { record_id: id }; });
        return json({ code: 0, data: { records: made } });
      }
      if (action === 'batch_update') {
        const b = JSON.parse(body || '{}');
        (b.records || []).forEach(r => { const i = t.ids.indexOf(r.record_id); if (i >= 0) Object.assign(t.rows[i], r.fields); });
        return json({ code: 0, data: { records: (b.records || []).map(r => ({ record_id: r.record_id })) } });
      }
      if (action === 'batch_delete') {
        const b = JSON.parse(body || '{}');
        const want = new Set(b.records || []);
        const keep = [], keepIds = [];
        t.rows.forEach((r, i) => { if (want.has(t.ids[i])) return; keep.push(r); keepIds.push(t.ids[i]); });
        t.rows.length = 0; keep.forEach(r => t.rows.push(r));
        t.ids.length = 0; keepIds.forEach(x => t.ids.push(x));
        return json({ code: 0, data: { records: [] } });
      }
      json({ code: 404, msg: 'unhandled ' + action });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, tables })));
}

/** 造一个极简的 req/res，够 handler 用 */
function fakeReq(method, url, payload) {
  const raw = payload === undefined ? '' : JSON.stringify(payload);
  const req = new (require('node:stream').Readable)({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  req.push(raw);
  req.push(null);
  return req;
}
function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.ended = true; return this; },
    end() { this.ended = true; return this; }
  };
  return res;
}

function loadHandler(relPath, port) {
  const keys = Object.keys(require.cache).filter(k => k.includes('feishu-api.js') || k.includes('/api/feishu/'));
  keys.forEach(k => delete require.cache[k]);
  process.env.FEISHU_HOST = 'http://127.0.0.1:' + port;
  process.env.FEISHU_APP_ID = 'cli_fake';
  process.env.FEISHU_APP_SECRET = 'secret_fake';
  process.env.FEISHU_BASE_TOKEN = 'BASE_FAKE';
  process.env.FEISHU_TABLES = JSON.stringify({ materials: 'tblMAT', transactions: 'tblTXN', workorders: 'tblWIP' });
  return require('../' + relPath);
}
function cleanupEnv() {
  ['FEISHU_HOST', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BASE_TOKEN', 'FEISHU_TABLES'].forEach(k => delete process.env[k]);
  Object.keys(require.cache).filter(k => k.includes('feishu-api.js') || k.includes('/api/feishu/')).forEach(k => delete require.cache[k]);
}

/* ================= /api/feishu/stock ================= */

test('接口 stock【Phase0·核心】只给 delta 也必须能写（前端离线重放走的就是这条路）', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const stock = loadHandler('api/feishu/stock.js', mock.port);
  const res = fakeRes();
  await stock(fakeReq('POST', '/api/feishu/stock', { matCode: 'A-1', delta: -3, opId: 'op-1' }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 7, '10 − 3');
  assert.equal(mock.tables.tblTXN.rows.length, 1);
  assert.equal(mock.tables.tblTXN.rows[0]['操作ID'], 'op-1', '幂等键必须真的落到飞书列里');
});

test('接口 stock：qty 和 delta 都不给 → 400，且绝不写数据', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const stock = loadHandler('api/feishu/stock.js', mock.port);
  const res = fakeRes();
  await stock(fakeReq('POST', '/api/feishu/stock', { matCode: 'A-1' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /qty 或 delta/);
  assert.equal(mock.tables.tblTXN.rows.length, 0);
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 10);
});

test('接口 stock：非 POST 拒绝（405）', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const stock = loadHandler('api/feishu/stock.js', mock.port);
  const res = fakeRes();
  await stock(fakeReq('GET', '/api/feishu/stock'), res);
  assert.equal(res.statusCode, 405);
});

/* ================= /api/feishu/nextcode ================= */

test('接口 nextcode：GET 取号，只读返回 next（调用方传内部短码 LL）', async (t) => {
  const mock = await startMock();
  // 生产里这一列存的是单选选项全名 'LL 领料'，不是短码
  mock.tables.tblWIP.rows.push({ '工单号': 'LL20260915004', '类型': 'LL 领料' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const nextcode = loadHandler('api/feishu/nextcode.js', mock.port);
  const res = fakeRes();
  await nextcode(fakeReq('GET', '/api/feishu/nextcode?prefix=LL20260915&type=LL'), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.max, 4, '短码 LL 必须被换算成选项名「LL 领料」才查得到 —— 否则 max 恒为 0，跨设备防撞号形同虚设');
  assert.equal(res.body.next, 5);
});

test('接口 nextcode【P6 回归】传单选选项全名也要能查到（两种写法都支持）', async (t) => {
  const mock = await startMock();
  mock.tables.tblWIP.rows.push({ '工单号': 'BH20260915007', '类型': 'BH 补货' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const nextcode = loadHandler('api/feishu/nextcode.js', mock.port);
  const res = fakeRes();
  await nextcode(fakeReq('GET', '/api/feishu/nextcode?prefix=BH20260915&type=' + encodeURIComponent('BH 补货')), res);
  assert.equal(res.body.max, 7);
});

test('接口 nextcode【P6 关键】另一台设备建过单时，本机必须能取到更大的号', async (t) => {
  const mock = await startMock();
  // 本机计数器是 0（换浏览器/新设备），飞书里已经有 12 张当天的 LL 单
  mock.tables.tblWIP.rows.push({ '工单号': 'LL20260915012', '类型': 'LL 领料' });
  mock.tables.tblWIP.rows.push({ '工单号': 'LL20260915003', '类型': 'LL 领料' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const nextcode = loadHandler('api/feishu/nextcode.js', mock.port);
  const res = fakeRes();
  await nextcode(fakeReq('GET', '/api/feishu/nextcode?prefix=LL20260915&type=LL'), res);
  assert.equal(res.body.max, 12, '必须取飞书里的当天最大号');
  assert.equal(res.body.next, 13, '取到 1 就会和已有工单撞号，而工单按业务键 upsert → 两张单互相覆盖');
});

test('接口 nextcode：缺 prefix → 400；非 GET/POST → 405', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const nextcode = loadHandler('api/feishu/nextcode.js', mock.port);
  const r1 = fakeRes();
  await nextcode(fakeReq('GET', '/api/feishu/nextcode'), r1);
  assert.equal(r1.statusCode, 400);
  const r2 = fakeRes();
  await nextcode(fakeReq('DELETE', '/api/feishu/nextcode'), r2);
  assert.equal(r2.statusCode, 405);
});

/* ================= /api/feishu/upsert（回归） ================= */

test('接口 upsert：按业务键写入并回读一致（回归，确认 handler 没被 Phase0 改动弄坏）', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const upsert = loadHandler('api/feishu/upsert.js', mock.port);
  const res = fakeRes();
  // A-1 在 mock 里已存在（库存 10）→ 走更新分支 → 库存数量必须**不被 upsert 改**
  await upsert(fakeReq('POST', '/api/feishu/upsert', { table: 'materials', records: [{ code: 'A-1', qty: 42 }] }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 10,
    'P4：已存在物料的库存数量只能由库存直写/账本改，upsert 一律忽略（否则绕过账本覆盖并发改动）');
  assert.ok((res.body.dropped || []).some(d => /库存数量/.test(d)), '被忽略的字段要如实回报');

  // 但**新建**物料时期初库存要能随建档写入（全新物料没有账本，期初只能从建档带进来）
  const res2 = fakeRes();
  await upsert(fakeReq('POST', '/api/feishu/upsert', { table: 'materials', records: [{ code: 'ZZ-NEW-1', qty: 7 }] }), res2);
  assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
  const nu = mock.tables.tblMAT.rows.find(r => r['物料码'] === 'ZZ-NEW-1');
  assert.ok(nu, '新物料应被创建');
  assert.equal(nu['库存数量'], 7, '新建时 qty 就是它的期初库存，必须保留');
  // 清掉哨兵，别把假数据留在 mock 里影响别的断言
  mock.tables.tblMAT.rows = mock.tables.tblMAT.rows.filter(r => r['物料码'] !== 'ZZ-NEW-1');
});

/* ================= mode=sync：探测+拉取合并 ================= */

test('接口 incremental[mode=sync]：零变化时只探测，不返回任何内容行', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const inc = loadHandler('api/feishu/incremental.js', mock.port);
  const now = Date.now();
  const res = fakeRes();
  await inc(fakeReq('POST', '/api/feishu/incremental', {
    mode: 'sync',
    watermarks: { materials: { ts: now, total: 1 }, transactions: { ts: now, total: 0 }, workorders: { ts: now, total: 0 } }
  }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 0, '零变化不该返回任何行');
  assert.deepEqual(res.body.changed, [], '零变化不该判定任何表变了');
  assert.ok(res.body.probe, '仍要返回探测报告，便于健康面板显示耗时');
  assert.equal(typeof res.body.probe.timing.totalMs, 'number');
});

test('接口 incremental[mode=sync]：探测到变化就顺手拉回来，一次调用搞定', async (t) => {
  const mock = await startMock();
  mock.tables.tblMAT.rows[0]['最后更新时间'] = Date.now();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const inc = loadHandler('api/feishu/incremental.js', mock.port);
  const res = fakeRes();
  await inc(fakeReq('POST', '/api/feishu/incremental', {
    mode: 'sync',
    watermarks: { materials: { ts: 1, seen: [], total: 1 } }
  }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.changed.indexOf('materials') >= 0, '水位很旧 → 应判定 materials 变了');
  assert.ok((res.body.changes.materials || []).length > 0, '应把变化的行一并带回');
  assert.ok(res.body.watermarks.materials.ts > 1, '水位要前进');
  assert.equal(typeof res.body.probe.timing.probeMs, 'number');
  assert.equal(typeof res.body.probe.timing.pullMs, 'number');
});
