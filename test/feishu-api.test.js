/**
 * 飞书云端接口（lib/feishu-api.js + api/feishu/*）集成测试
 *
 * 用本地 mock 顶替 open.feishu.cn，验证真实代码路径：
 *   鉴权 → 分页读表 → 字段映射 → 库存直写（改物料行 + 追加流水）→ 错误分支
 *
 * 不需要任何飞书凭据、不联网。
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

/* ---------- mock 飞书：只实现用到的几个接口 ---------- */
function startMock(opts = {}) {
  const tables = opts.tables || {
    tblMAT: { fields: ['物料码', '名称', '库存数量'], rows: [{ '物料码': 'A-1', '名称': '螺丝刀', '库存数量': 5 }] },
    tblTXN: { fields: ['流水号', '时间', '操作人', '类型', '物料码', '变动', '余量', '关联单', '原因/备注'], rows: [] }
  };
  const calls = { created: [], updated: [], deny: false, denyOn: opts.denyOn || null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        if (opts.badAuth) return json({ code: 10003, msg: 'app_id or app_secret invalid' });
        return json({ code: 0, tenant_access_token: 't-fake' });
      }
      // 表 ID 从路径里取：.../tables/<id>/records[...]
      const m = url.pathname.match(/\/tables\/([^/]+)\/records(\/[a-z_]+)?/);
      if (!m) return json({ code: 404, msg: 'not found' });
      const tableId = m[1];
      const action = (m[2] || '').replace('/', '');
      const t = tables[tableId];
      if (!t) return json({ code: 1254005, msg: 'table not found: ' + tableId });

      // 权限注入
      if (calls.denyOn && calls.denyOn === action) return json({ code: 99991672, msg: 'Forbidden: no permission' });
      if (action === 'batch_update') calls.denyOn = calls.denyOn || null;

      if (!action) {   // 列表
        return json({ code: 0, data: {
          items: t.rows.map((r, i) => ({ record_id: 'rec_' + i, fields: r })),
          has_more: false
        } });
      }
      if (action === 'batch_create') {
        if (opts.denyWrite) return json({ code: 99991672, msg: 'Forbidden: no permission to write' });
        const b = JSON.parse(body || '{}');
        (b.records || []).forEach(r => { calls.created.push(r.fields); t.rows.push(r.fields); });
        return json({ code: 0, data: { records: (b.records || []).map((_, i) => ({ record_id: 'new_' + i })) } });
      }
      if (action === 'batch_update') {
        if (opts.denyWrite) return json({ code: 99991672, msg: 'Forbidden: no permission to write' });
        const b = JSON.parse(body || '{}');
        (b.records || []).forEach(r => {
          calls.updated.push(r);
          const idx = parseInt(String(r.record_id).replace('rec_', ''), 10);
          if (t.rows[idx]) Object.assign(t.rows[idx], r.fields);
        });
        return json({ code: 0, data: { records: (b.records || []).map((_, i) => ({ record_id: 'u_' + i })) } });
      }
      json({ code: 404, msg: 'unhandled action ' + action });
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, tables, calls });
    });
  });
}

/** 每个用例都在干净的模块缓存下加载 lib，并指向 mock */
function loadLib(port, env = {}) {
  const keys = Object.keys(require.cache).filter(k => k.includes('feishu-api.js'));
  keys.forEach(k => delete require.cache[k]);
  process.env.FEISHU_HOST = 'http://127.0.0.1:' + port;
  process.env.FEISHU_APP_ID = 'cli_fake';
  process.env.FEISHU_APP_SECRET = 'secret_fake';
  process.env.FEISHU_BASE_TOKEN = 'BASE_FAKE';
  process.env.FEISHU_TABLES = JSON.stringify({ materials: 'tblMAT', transactions: 'tblTXN' });
  Object.assign(process.env, env);
  return require('../lib/feishu-api.js');
}
function cleanupEnv() {
  ['FEISHU_HOST', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BASE_TOKEN', 'FEISHU_TABLES']
    .forEach(k => delete process.env[k]);
  Object.keys(require.cache).filter(k => k.includes('feishu-api.js')).forEach(k => delete require.cache[k]);
}

/* ================= 读 ================= */

test('飞书读：pullState 组装出正确的 state', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);

  const st = await lib.pullState();
  assert.equal(st.materials.length, 1);
  assert.equal(st.materials[0].code, 'A-1');
  assert.equal(st.materials[0].qty, 5);
  assert.equal(st.transactions.length, 0);
  assert.equal(st.txnSeq, 0);
});

test('飞书读：缺少应用凭证时明确报错', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_APP_ID: '' });
  await assert.rejects(() => lib.pullState(), /未配置 FEISHU_APP_ID/);
});

test('飞书读：鉴权失败时报错，不返回空数据', async (t) => {
  const mock = await startMock({ badAuth: true });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  await assert.rejects(() => lib.pullState(), /获取 tenant_access_token 失败/);
});

test('飞书读【回归】表不存在时报错，绝不静默返回空表', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ materials: 'tblNOPE', transactions: 'tblTXN' }) });
  await assert.rejects(() => lib.pullState(), /飞书表不存在/);
});

test('飞书读：权限不足时给出可操作的提示', async (t) => {
  const mock = await startMock();
  mock.calls.denyOn = null;
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  // 直接构造一个权限错误，验证提示文案
  const e = lib.fsError('读取表 X', { code: 99991672, msg: 'Forbidden' });
  assert.match(e.message, /多维表格\*\*读写\*\*权限/);
  assert.match(e.message, /创建版本并发布/);
});

/* ================= 写 ================= */

test('飞书写【核心】改物料库存 + 追加流水（seq 自动递增）', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);

  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2, operator: '管理员', type: '领料工单', ref: 'W-1' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.seq, 1);

  // 物料行已改
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 3);
  assert.equal(mock.calls.updated.length, 1);
  assert.equal(mock.calls.updated[0].fields['库存数量'], 3);

  // 流水已追加，字段齐全
  const txn = mock.calls.created[0];
  assert.equal(txn['流水号'], '#000001');
  assert.equal(txn['物料码'], 'A-1');
  assert.equal(txn['变动'], -2);
  assert.equal(txn['余量'], 3);
  assert.equal(txn['类型'], '领料工单');
  assert.equal(txn['操作人'], '管理员');
  assert.equal(txn['关联单'], 'W-1');
  // 时间必须是中文 24 小时制（Vercel 运行时是 en-US，不能依赖 toLocaleString）
  assert.match(txn['时间'], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.doesNotMatch(txn['时间'], /[AP]M/);
});

test('飞书写：seq 取现有最大值 + 1（不是从 1 重来）', async (t) => {
  const mock = await startMock({
    tables: {
      tblMAT: { fields: ['物料码', '库存数量'], rows: [{ '物料码': 'A-1', '库存数量': 5 }] },
      tblTXN: { fields: ['流水号'], rows: [{ '流水号': '#000007' }, { '流水号': '#000012' }, { '流水号': '#000003' }] }
    }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.writeStock({ matCode: 'A-1', qty: 4, delta: -1 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.seq, 13, '应接在最大流水号 12 之后');
  assert.equal(mock.calls.created[0]['流水号'], '#000013');
});

test('飞书写：物料不在飞书台账时拒绝，并给出处理建议', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.writeStock({ matCode: 'NOT-EXIST', qty: 1, delta: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /不在飞书台账/);
  assert.equal(mock.calls.updated.length, 0, '不应产生任何写入');
});

test('飞书写：缺 matCode / qty 时拒绝', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  assert.equal((await lib.writeStock({ qty: 1 })).ok, false);
  assert.equal((await lib.writeStock({ matCode: 'A-1' })).ok, false);
  assert.equal((await lib.writeStock({ matCode: 'A-1', qty: 'NaN' })).ok, false);
});

test('飞书写：权限不足时明确提示去开权限', async (t) => {
  const mock = await startMock({ denyWrite: true });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2 });
  assert.equal(r.ok, false);
  assert.match(r.error, /读写\*\*权限|创建版本并发布/);
});

test('飞书写【重要】库存改了但流水写失败时，必须如实报告而不能假装成功', async (t) => {
  // 让 batch_create 失败（表 ID 指到一个不存在的表）
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ materials: 'tblMAT', transactions: 'tblNOPE' }) });
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2 });
  assert.equal(r.ok, false, '不能返回成功');
  assert.equal(r.warning, 'stock_written_txn_failed');
  assert.match(r.error, /库存已改为 3，但流水写入失败/);
  // 库存确实被改了 —— 这正是必须报告的原因
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 3);
});

test('飞书写：写完后回放读到的余量与库存一致', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  await lib.writeStock({ matCode: 'A-1', qty: 8, delta: 3, operator: '甲', type: '补货工单' });
  await lib.writeStock({ matCode: 'A-1', qty: 6, delta: -2, operator: '乙', type: '领料工单' });

  const st = await lib.pullState();
  assert.equal(st.transactions.length, 2);
  assert.deepEqual(st.transactions.map(t => t.seq), [2, 1], '新的在前');
  assert.equal(st.txnSeq, 2);
  assert.equal(st.materials[0].qty, 6);
  const newest = st.transactions[0];
  assert.equal(newest.balance, 6);
  assert.equal(newest.delta, -2);
});
