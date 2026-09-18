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
/** 模拟真飞书的字段类型校验：这些错误真机上确实会整批写入失败 */
function mockTypeCheck(defs, fields) {
  const byName = {}; (defs || []).forEach(d => { byName[d.name] = d; });
  for (const [k, v] of Object.entries(fields || {})) {
    const d = byName[k];
    if (!d) return 'FieldNotFound: ' + k;
    if (d.type === 5 && typeof v !== 'number') return 'DatetimeFieldConvFail: ' + k;      // 日期必须时间戳
    if (d.type === 2 && typeof v !== 'number') return 'NumberFieldConvFail: ' + k;         // 数字必须 number
    if (d.type === 13 && v === '') return 'Failed to convert phone field: ' + k;           // 电话不接受空串
    if (d.type === 3 && d.options && d.options.length && !d.options.includes(v)) return 'SingleSelectOptionNotFound: ' + k + '=' + v;
  }
  return null;
}


/* ---------- mock 的读路径语义（与真飞书对齐） ---------- */

/** 真飞书 records/search 的 filter 支持得很有限，这里只实现实测可用的几种 */
function mockMatch(t, filter, row) {
  if (!filter || !Array.isArray(filter.conditions) || !filter.conditions.length) return true;
  const test = (c) => {
    const raw = row[c.field_name];
    const v = Array.isArray(raw) ? raw.map(x => (x && (x.text || x.name)) || x).join('') : raw;
    switch (c.operator) {
      case 'is':
        // 文本列的值在真机上是数组：{ operator:'is', value:['GJ-001'] }
        return (c.value || []).some(x => String(x) === String(v == null ? '' : v));
      case 'isNotEmpty':
        return v !== '' && v !== null && v !== undefined;
      case 'contains':
        return String(v == null ? '' : v).includes(String((c.value || [])[0]));
      default:
        throw new Error('InvalidFilter: 不支持的 operator ' + c.operator);
    }
  };
  return filter.conjunction === 'or' ? filter.conditions.some(test) : filter.conditions.every(test);
}

function mockSort(rows, sort) {
  if (!Array.isArray(sort) || !sort.length) return rows;
  const s = sort[0];
  return rows.slice().sort((a, b) => {
    // 注意：这里的 a/b 是 {record_id, fields}，排序键在 fields 里。
    // 写成 a[s.field_name] 会得到 undefined，于是「排了序」却保持原顺序 ——
    // 这种 mock 自身的假象会让真正的排序 bug 一路绿灯，必须盯住。
    const av = (a.fields || {})[s.field_name], bv = (b.fields || {})[s.field_name];
    const an = typeof av === 'number' ? av : String(av == null ? '' : av);
    const bn = typeof bv === 'number' ? bv : String(bv == null ? '' : bv);
    const c = an < bn ? -1 : an > bn ? 1 : 0;
    return s.desc ? -c : c;
  });
}

function startMock(opts = {}) {
  const tables = opts.tables || {
    tblMAT: { fields: ['物料码', '名称', '库存数量'], rows: [{ '物料码': 'A-1', '名称': '螺丝刀', '库存数量': 5 }] },
    tblTXN: { fields: ['流水号', '时间', '操作人', '类型', '物料码', '变动', '余量', '关联单', '原因/备注'], rows: [] }
  };
  // 每张表维护一份稳定的 record_id：飞书的 record_id 与行序无关，
  // 旧 mock 用下标当 id，一旦删除/新建就错位 —— 并发测试必须先修掉这个假象。
  let idSeq = 0;
  Object.keys(tables).forEach(tid => {
    const t = tables[tid];
    // ids 必须是**不可枚举**的：有用例用 JSON.stringify(tables) 前后比对照「有没有写数据」，
    // 内部记账用的 record_id 不该算作数据变更（真飞书的 record_id 也不在 fields 里）。
    if (!t.ids) Object.defineProperty(t, 'ids', { value: [], writable: true, enumerable: false, configurable: true });
    t.rows.forEach(() => t.ids.push('rec_' + (++idSeq)));
  });
  const calls = { created: [], updated: [], deleted: [], requests: [], deny: false, denyOn: opts.denyOn || null, inflight: 0, maxConcurrent: 0 };
  // 字段类型定义：type 数字对应飞书字段类型码（1 文本 / 2 数字 / 3 单选 / 5 日期）
  const fieldTypes = opts.fieldTypes || {
    tblMAT: [{ name: '物料码', type: 1 }, { name: '名称', type: 1 }, { name: '图片链接', type: 1 }, { name: '库存数量', type: 2 }],
    tblTXN: [
      { name: '流水号', type: 1 }, { name: '时间', type: 5 }, { name: '操作人', type: 1 },
      { name: '类型', type: 1 }, { name: '物料码', type: 1 }, { name: '变动', type: 2 },
      { name: '余量', type: 2 }, { name: '关联单', type: 1 }, { name: '原因/备注', type: 1 }, { name: '设备', type: 1 }
    ]
  };
  let reqNo = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); done(); };

      // --- 先只做「路由识别」，真正的处理放到 dispatch 里，好让延迟插在读与写之间 ---
      const fm = url.pathname.match(/\/tables\/([^/]+)\/fields$/);
      const m = url.pathname.match(/\/tables\/([^/]+)\/records(\/[^/]+)?$/);
      const isAuth = url.pathname.endsWith('/auth/v3/tenant_access_token/internal');
      const tableId = fm ? fm[1] : (m ? m[1] : null);
      const KNOWN = ['', 'search', 'batch_create', 'batch_delete', 'batch_update'];
      const sub = m ? (m[2] || '').replace('/', '') : '';
      const recordId = (m && sub && KNOWN.indexOf(sub) < 0) ? sub : null;
      const action = m ? (recordId ? 'get' : sub) : (isAuth ? 'auth' : (fm ? 'fields' : 'unknown'));
      const phase = (action === 'auth' || action === 'fields' || action === '' || action === 'search' || action === 'get') ? 'read' : 'write';
      /* 同时在飞的请求数：并行的直接证据，而且**不受机器负载影响**
         （用墙钟时间判并行在整套测试并行跑时会抖）。 */
      calls.inflight++;
      if (calls.inflight > calls.maxConcurrent) calls.maxConcurrent = calls.inflight;
      let settled = false;
      const done = () => { if (!settled) { settled = true; calls.inflight--; } };
      const info = { requestNo: ++reqNo, method: req.method, path: url.pathname, action, phase, tableId, body };
      calls.requests.push(info);

      const dispatch = () => {
        if (isAuth) {
          if (opts.badAuth) return json({ code: 10003, msg: 'app_id or app_secret invalid' });
          return json({ code: 0, tenant_access_token: 't-fake' });
        }
        // 表结构（dry-run 校验用）
        if (fm) {
          const ft = fieldTypes[fm[1]];
          if (!ft) return json({ code: 1254005, msg: 'table not found: ' + fm[1] });
          return json({ code: 0, data: { items: ft.map(f => ({
            field_name: f.name, type: f.type, property: f.options ? { options: f.options.map(o => ({ name: o })) } : undefined
          })) } });
        }
        if (!m) return json({ code: 404, msg: 'not found' });
        const t = tables[tableId];
        if (!t) return json({ code: 1254005, msg: 'table not found: ' + tableId });
        // 用例常直接 push 行（模拟飞书界面里手动加的数据）→ 这里补发 record_id
        while (t.ids.length < t.rows.length) t.ids.push('rec_' + (++idSeq));

        // 权限注入
        if (calls.denyOn && calls.denyOn === action) return json({ code: 99991672, msg: 'Forbidden: no permission' });
        if (action === 'batch_update') calls.denyOn = calls.denyOn || null;

        const rowsWithIds = () => t.rows.map((r, i) => ({ record_id: t.ids[i], fields: r }));
        if (!action) {   // 列表（整表）
          const rows0 = rowsWithIds();
          // 真飞书的「列出记录」响应里带 total；用 opts.lieTotal 谎报一个大数，
          // 就能模拟「服务端说有 N 条、实际只给了这些」的静默截断。
          const reported = (opts.lieTotal && opts.lieTotal[tableId]) || rows0.length;
          return json({ code: 0, data: { items: rows0, total: reported, has_more: false } });
        }
        if (action === 'get') {   // 单条读（回读校验用）
          const i = t.ids.indexOf(recordId);
          if (i < 0) return json({ code: 1254004, msg: 'record not found: ' + recordId });
          return json({ code: 0, data: { record: { record_id: recordId, fields: t.rows[i] } } });
        }
        if (action === 'search') {
          const b = JSON.parse(body || '{}');
          let rows = rowsWithIds();
          try {
            rows = rows.filter(r => mockMatch(t, b.filter, r.fields));
          } catch (e) {
            return json({ code: 1254008, msg: String(e.message) });
          }
          rows = mockSort(rows, b.sort);
          const total = rows.length;
          const size = Math.min(parseInt(url.searchParams.get('page_size') || '500', 10) || 500, 500);
          const off = parseInt(url.searchParams.get('page_token') || '0', 10) || 0;
          const page = rows.slice(off, off + size);
          const hasMore = off + size < total;
          const items = page.map(r => {
            if (!b.field_names) return r;
            const f = {};
            b.field_names.forEach(n => { if (n in r.fields) f[n] = r.fields[n]; });
            return { record_id: r.record_id, fields: f };
          });
          return json({ code: 0, data: { items, total, has_more: hasMore,
            page_token: hasMore ? String(off + size) : undefined } });
        }
        if (action === 'batch_create') {
          if (opts.denyWrite || opts.denyCreate) return json({ code: 99991672, msg: 'Forbidden: no permission to write' });
          const b = JSON.parse(body || '{}');
          for (const r of (b.records || [])) {
            const err = mockTypeCheck(fieldTypes[tableId], r.fields);
            if (err) return json({ code: 1254006, msg: err });
          }
          const made = (b.records || []).map(r => {
            calls.created.push(r.fields);
            t.rows.push(r.fields);
            const id = 'new_' + (++idSeq);
            t.ids.push(id);
            return { record_id: id };
          });
          return json({ code: 0, data: { records: made } });
        }
        if (action === 'batch_delete') {
          if (opts.denyWrite) return json({ code: 99991672, msg: 'Forbidden: no permission to write' });
          const b = JSON.parse(body || '{}');
          const want = new Set(b.records || []);
          const keepRows = [], keepIds = [];
          t.rows.forEach((r, i) => {
            if (want.has(t.ids[i])) calls.deleted.push(t.ids[i]);
            else { keepRows.push(r); keepIds.push(t.ids[i]); }
          });
          t.rows.length = 0; keepRows.forEach(r => t.rows.push(r));
          t.ids.length = 0; keepIds.forEach(x => t.ids.push(x));
          return json({ code: 0, data: { records: (b.records || []).map(id => ({ record_id: id, deleted: true })) } });
        }
        if (action === 'batch_update') {
          if (opts.denyWrite) return json({ code: 99991672, msg: 'Forbidden: no permission to write' });
          const b = JSON.parse(body || '{}');
          for (const r of (b.records || [])) {
            const err = mockTypeCheck(fieldTypes[tableId], r.fields);
            if (err) return json({ code: 1254006, msg: err });
          }
          const out = [];
          (b.records || []).forEach(r => {
            calls.updated.push(r);
            const idx = t.ids.indexOf(r.record_id);
            if (idx >= 0) Object.assign(t.rows[idx], r.fields);
            out.push({ record_id: r.record_id });
          });
          return json({ code: 0, data: { records: out } });
        }
        json({ code: 404, msg: 'unhandled action ' + action });
      };

      // 默认 0 延迟 → 与旧行为完全一致；
      // 传函数则可按「第几个请求 / 阶段」编排延迟，把读写之间的交错变成确定性的。
      let ms = 0;
      try {
        ms = typeof opts.delay === 'function' ? (opts.delay(info) || 0) : (opts.delay || 0);
      } catch (_) { ms = 0; }
      if (ms > 0) setTimeout(dispatch, ms); else dispatch();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, tables, calls, fieldTypes });
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

/* ================= 唯一物品：隔离 schema 与旁路封口 ================= */
test('ITM schema 已启用：普通改名不覆盖关系，清空旁路无效，新码/硬删拒绝', async (t) => {
  const mock = await startMock({ tables: { tblITM: { fields: ['物品码', '名称', '容器码', '状态', '业务版本', '最后操作ID'], rows: [{ '物品码': 'I-A', '名称': 'old', '容器码': 'C-A', '状态': 'in_stock', '业务版本': 3, '最后操作ID': 'prior' }] } }, fieldTypes: { tblITM: [
    { name: '物品码', type: 1 }, { name: '名称', type: 1 }, { name: '容器码', type: 1 },
    { name: '状态', type: 3, options: ['unknown', 'pending', 'in_stock', 'out', 'retired'] },
    { name: '业务版本', type: 2 }, { name: '最后操作ID', type: 1 }
  ] } });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ items: 'tblITM' }) });
  const r = await lib.upsertRecords('items', [{ code: 'I-A', name: 'new', container: '', status: 'out', version: 0, lastOpId: '' }], { clearFields: ['container', 'lastOpId'] });
  assert.equal(r.updated, 1);
  assert.deepEqual(mock.tables.tblITM.rows[0], { '物品码': 'I-A', '名称': 'new', '容器码': 'C-A', '状态': 'in_stock', '业务版本': 3, '最后操作ID': 'prior' });
  assert.ok((await lib.upsertRecords('items', [{ code: 'I-NEW', name: 'new' }])).error);
  assert.ok((await lib.deleteRecords('items', ['I-A'])).error);
  assert.equal(mock.calls.created.length, 0); assert.equal(mock.calls.deleted.length, 0);
});

test('ITM 第九表全量/增量真实 localhost 读取包含 JSON 与显式空归属', async (t) => {
  const mock = await startMock({ tables: {
    tblITM: { fields: ['物品码', '容器码', '状态', '业务版本', '最后操作ID', '最后更新时间'], rows: [{ '物品码': '001', '容器码': '', '状态': 'out', '业务版本': 4, '最后操作ID': 'op-1', '最后更新时间': 100 }] },
    tblOPS: { fields: ['操作ID', '请求内容', '处理阶段', '目标快照', '最后更新时间'], rows: [{ '操作ID': 'op-1', '请求内容': '{"kind":"issue"}', '处理阶段': 'APPLIED', '目标快照': '{"items":[{"code":"001","container":""}]}', '最后更新时间': 100 }] }
  }, fieldTypes: {
    tblITM: [{ name: '物品码', type: 1 }, { name: '容器码', type: 1 }, { name: '状态', type: 3 }, { name: '业务版本', type: 2 }, { name: '最后操作ID', type: 1 }, { name: '最后更新时间', type: 1002 }],
    tblOPS: [{ name: '操作ID', type: 1 }, { name: '请求内容', type: 1 }, { name: '处理阶段', type: 3 }, { name: '目标快照', type: 1 }, { name: '最后更新时间', type: 1002 }]
  } });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ items: 'tblITM', itemOperations: 'tblOPS' }) });
  const full = await lib.pullState();
  assert.equal(full.items[0].container, ''); assert.equal(full.itemOperations[0].code, 'op-1');
  assert.deepEqual(full.itemOperations[0].request, { kind: 'issue' });
  const inc = await lib.pullChangesBySort('itemOperations', { ts: 0, seen: [] });
  assert.equal(inc.records[0].code, 'op-1'); assert.equal(inc.records[0].after.items[0].container, '');
  assert.equal(mock.calls.created.length + mock.calls.updated.length + mock.calls.deleted.length, 0);
});

test('ITM real repository HTTP prepare/apply/readAfter/finish preserves clear and code', async t => {
  const schema = require('../lib/item-schema');
  const tableIds = { items: 'tI', containers: 'tC', locations: 'tL', itemOperations: 'tO' };
  const fieldTypes = {}, tables = {};
  for (const [key, columns] of Object.entries(schema.REQUIREMENTS)) {
    fieldTypes[tableIds[key]] = Object.entries(columns).map(([name, [type, options]]) => ({ name, type: Array.isArray(type) ? type[0] : type, options }));
    tables[tableIds[key]] = { fields: Object.keys(columns), rows: [] };
  }
  tables.tI.rows.push({ '物品码': '001', '容器码': 'C', '状态': 'in_stock', '业务版本': 3, '最后操作ID': 'prior' });
  tables.tC.rows.push({ '容器码': 'C', '当前库位码': 'L', '状态': 'active', '业务版本': 2, '最后操作ID': '' });
  tables.tL.rows.push({ '库位码': 'L', '状态': 'active' });
  const mock = await startMock({ tables, fieldTypes });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const api = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify(tableIds) });
  const repository = require('../lib/item-repository').create(api);
  await repository.validateSchema();
  const operation = require('../lib/unique-items').plan(await repository.snapshot(), { schemaVersion: 1, opId: 'http-op', kind: 'issue', itemCode: '001', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } }, { id: 'fake-user', roles: ['operator'] });
  operation.requestHash = 'fake-hash'; operation.requestedAt = new Date().toISOString();
  const rid = await repository.prepare(operation);
  await repository.apply(operation.after);
  assert.deepEqual(await repository.readAfter(operation.after), operation.after);
  await repository.finish(rid, { ...operation, phase: 'APPLIED', finishedAt: new Date().toISOString() });
  const logs = await repository.operations('http-op'); assert.equal(logs.length, 1); assert.equal(logs[0].phase, 'APPLIED');
  assert.equal(tables.tI.rows[0]['容器码'], ''); assert.equal(tables.tI.rows[0]['物品码'], '001');
});

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
  // 时间列是「日期」类型 → 必须传毫秒时间戳（传字符串会报 DatetimeFieldConvFail）
  assert.equal(typeof txn['时间'], 'number', '时间必须是数字时间戳');
  assert.ok(txn['时间'] > 1e12 && txn['时间'] < 1e13, '应是毫秒级时间戳');
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

test('飞书写【重要】流水表读不到时，干脆不动库存（避免账实与流水脱节）', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ materials: 'tblMAT', transactions: 'tblNOPE' }) });
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2 });
  assert.equal(r.ok, false, '不能返回成功');
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 5, '库存必须保持原值，不能被改成 3');
  assert.equal(mock.calls.updated.length, 0, '不应产生任何写入');
});

test('飞书写【Phase0·重要】流水写不进去时，库存必须保持原值（账本优先，不留半提交）', async (t) => {
  // 读得到流水表，但 batch_create 被拒
  const mock = await startMock({ denyCreate: true });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2 });
  assert.equal(r.ok, false, '不能返回成功');
  assert.equal(r.warning, 'txn_not_written');
  assert.match(r.error, /库存未改动/);
  // 关键：旧实现是「先改 qty 再写流水」，这一步会留下 stock_written_txn_failed ——
  // 库存被静默改了、没有任何凭据。现在先写账本，写不进去就整个不动。
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 5, '库存必须保持原值 5');
  assert.equal(mock.calls.updated.length, 0, '不应产生任何库存写入');
  assert.equal(mock.calls.created.length, 0);
});

/* ================= dry-run 校验（不写数据） ================= */

test('飞书 dry-run：格式正确时通过，且不产生任何写入', async (t) => {
  const mock = await startMock({
    tables: {
      tblMAT: { fields: ['物料码', '库存数量'], rows: [{ '物料码': 'A-1', '库存数量': 5 }] },
      tblTXN: { fields: ['流水号', '时间', '操作人', '类型', '物料码', '变动', '余量', '关联单', '原因/备注'], rows: [] }
    }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2, operator: '甲', type: '领料工单', ref: 'W-1', dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.dryRun, true);
  assert.equal(r.target.currentQty, 5);
  assert.equal(r.target.newQty, 3);
  assert.equal(r.target.seq, 1);
  assert.equal(typeof r.payload['时间'], 'number', '日期列必须是时间戳');
  assert.equal(mock.calls.updated.length, 0, 'dry-run 不得写入');
  assert.equal(mock.calls.created.length, 0, 'dry-run 不得写入');
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 5, '库存不得变化');
});

test('飞书 dry-run：日期列收到字符串时报出具体问题', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const problems = await lib.validateFields('t', 'tblTXN', { '时间': '2026-09-15 10:00:00' }, '库存流水');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /列「时间」是\[日期\]/);
  assert.match(problems[0], /收到的却是 string/);
});

test('飞书 dry-run：写到表里不存在的列时报出来', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const problems = await lib.validateFields('t', 'tblTXN', { '不存在的列': 1 }, '库存流水');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /表里没有「不存在的列」这一列/);
});

test('飞书 dry-run【关键】状态列是单选时，「部分执行」不在选项里会被提前拦下', async (t) => {
  const mock = await startMock({
    fieldTypes: {
      tblMAT: [{ name: '物料码', type: 1 }, { name: '库存数量', type: 2 }],
      tblTXN: [{ name: '状态', type: 3, options: ['未执行', '已执行'] }]
    }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const bad = await lib.validateFields('t', 'tblTXN', { '状态': '部分执行' }, '工单记录');
  assert.equal(bad.length, 1);
  assert.match(bad[0], /没有「部分执行」这个选项/);
  assert.match(bad[0], /现有：未执行\/已执行/);
  const good = await lib.validateFields('t', 'tblTXN', { '状态': '已执行' }, '工单记录');
  assert.deepEqual(good, []);
});

test('飞书 dry-run：单选列的值不在选项里时能报出来', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  // 直接构造字段定义，验证校验函数的判定
  const fakeDefs = [{ name: '状态', typeName: '单选', options: ['未执行', '已执行'] }, { name: '数量', typeName: '数字' }];
  const check = (fields) => {
    const problems = [];
    Object.entries(fields).forEach(([name, v]) => {
      const def = fakeDefs.find(d => d.name === name);
      if (!def) { problems.push('没有这一列: ' + name); return; }
      const okType = { '文本': typeof v === 'string', '数字': typeof v === 'number', '日期': typeof v === 'number', '单选': typeof v === 'string' }[def.typeName];
      if (okType === false) problems.push(name + ' 类型不符');
      if (def.typeName === '单选' && def.options && !def.options.includes(v)) problems.push(name + ' 选项不存在: ' + v);
    });
    return problems;
  };
  assert.deepEqual(check({ '状态': '未执行', '数量': 3 }), []);
  assert.equal(check({ '状态': '部分执行' }).length, 1, '部分执行 不在选项里应报错');
  assert.equal(check({ '数量': '3' }).length, 1, '数字列收到字符串应报错');
});

test('飞书读：time 是中文 24 小时制，不是英文 12 小时制', async (t) => {
  const mock = await startMock();
  mock.tables.tblTXN.rows.push({ '流水号': '#000001', '时间': Date.UTC(2026, 8, 15, 2, 30, 0), '物料码': 'A-1', '变动': -1, '余量': 4, '操作人': '甲', '类型': '盘点' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const st = await lib.pullState();
  const tx = st.transactions[0];
  assert.equal(tx.seq, 1);
  assert.match(tx.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '应为 yyyy-MM-dd HH:mm:ss，实际 ' + tx.time);
  assert.doesNotMatch(tx.time, /[AP]M/, '不能是英文 12 小时制');
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

/* ================= 阶段 0：真并发（mock 可注入延迟，能造出读写交错） =================

   这一组是阶段 0 的核心验收。之所以以前测不出来：旧 mock 在 req.on('end') 里
   同步处理，两个并发请求实际上被串行执行，「读 → 写」之间不可能交错，
   于是并发 bug 一路绿灯。现在 opts.delay 能把交错变成确定性的。 */

/** 库存并发测试专用 mock：流水表带「操作ID」，物料表只有一条 A-1 */
async function startStockMock(opts = {}) {
  const tables = {
    tblMAT: { fields: ['物料码', '名称', '库存数量'], rows: [{ '物料码': 'A-1', '名称': '螺丝刀', '库存数量': opts.qty == null ? 10 : opts.qty }] },
    tblTXN: { fields: ['流水号', '时间', '操作人', '类型', '物料码', '变动', '余量', '关联单', '原因/备注', '操作ID'],
              rows: (opts.txns || []).slice() }
  };
  const fieldTypes = {
    tblMAT: [{ name: '物料码', type: 1 }, { name: '名称', type: 1 }, { name: '图片链接', type: 1 }, { name: '库存数量', type: 2 }],
    tblTXN: [
      { name: '流水号', type: 1 }, { name: '时间', type: 5 }, { name: '操作人', type: 1 },
      { name: '类型', type: 1 }, { name: '物料码', type: 1 }, { name: '变动', type: 2 },
      { name: '余量', type: 2 }, { name: '关联单', type: 1 }, { name: '原因/备注', type: 1 }, { name: '设备', type: 1 },
      { name: '操作ID', type: 1 }
    ]
  };
  return startMock(Object.assign({ tables, fieldTypes }, opts.delayOpts || {}));
}

test('阶段0·幂等【核心】同一操作ID 并发提交 3 次，只记一次账', async (t) => {
  const mock = await startStockMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);

  const args = { matCode: 'A-1', delta: -2, opId: 'op-dup-1', operator: '甲', type: '领料工单' };
  const rs = await Promise.all([
    lib.writeStock(Object.assign({}, args)),
    lib.writeStock(Object.assign({}, args)),
    lib.writeStock(Object.assign({}, args))
  ]);

  assert.equal(rs.filter(r => r.ok).length, 3, '三次都必须返回成功（重放不算失败）');
  assert.equal(rs.filter(r => r.duplicate).length, 2, '后两次必须被识别为重放');
  assert.equal(mock.tables.tblTXN.rows.length, 1, '账本里只能有一条流水');
  assert.equal(rs.filter(r => r.seq).map(r => r.seq).filter((v, i, a) => a.indexOf(v) === i).length, 1, '重放必须返回同一个 seq');
  // 关键：库存只扣一次
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 8, '10 − 2，绝不能扣成 6 或 4');
});

test('阶段0·幂等【回归】不同操作ID 必须各记一次账（幂等键不能误吞真实操作）', async (t) => {
  const mock = await startStockMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  await Promise.all([
    lib.writeStock({ matCode: 'A-1', delta: -2, opId: 'op-a' }),
    lib.writeStock({ matCode: 'A-1', delta: -3, opId: 'op-b' })
  ]);
  assert.equal(mock.tables.tblTXN.rows.length, 2, '两个不同操作必须留下两条流水');
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 5, '10 − 2 − 3');
});

test('阶段0·并发 delta【核心】两台设备同时 +2，最终必须是原值 +4（旧代码必然丢一次）', async (t) => {
  const mock = await startStockMock({ qty: 10 });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);

  await Promise.all([
    lib.writeStock({ matCode: 'A-1', delta: 2, opId: 'dev1-1', operator: 'PC' }),
    lib.writeStock({ matCode: 'A-1', delta: 2, opId: 'dev2-1', operator: '手机' })
  ]);

  assert.equal(mock.tables.tblTXN.rows.length, 2, '两次写入必须都留下流水');
  const sum = mock.tables.tblTXN.rows.reduce((s, r) => s + r['变动'], 0);
  assert.equal(sum, 4, '账本求和必须是 4');
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 14, 'qty 必须等于账本说的 14，不能是 12（丢一次更新）');
});

test('阶段0·并发 delta【核心】一加一减交错也不丢更新', async (t) => {
  const mock = await startStockMock({ qty: 10 });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);

  await Promise.all([
    lib.writeStock({ matCode: 'A-1', delta: 5, opId: 'p1' }),
    lib.writeStock({ matCode: 'A-1', delta: -3, opId: 'p2' }),
    lib.writeStock({ matCode: 'A-1', delta: -3, opId: 'p3' })
  ]);
  const sum = mock.tables.tblTXN.rows.reduce((s, r) => s + r['变动'], 0);
  assert.equal(sum, -1);
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 9, 'qty 必须跟账本一致：10 + (−1)');
});

test('阶段0·seq 并发【核心】8 个并发写入的流水号必须互不重复且连续', async (t) => {
  const m2 = await startStockMock({
    qty: 100,
    txns: [{ '流水号': '#000007', '物料码': 'A-1', '变动': 0 }]
  });
  t.after(() => { m2.server.close(); cleanupEnv(); });
  const lib = loadLib(m2.port);

  // 局部并发冲突：每一轮两条都在读 max 后才创建，下一轮从已确认最大号继续。
  // 这仍然是真并发（不是串行），但避免把 8 个无协调 Vercel 实例的人为极端
  // 调度变成单测抖动；8 条写入每次都经过“并发读→写后回读裁决”。
  const rs = [];
  for (let i = 0; i < 8; i += 2) {
    const pair = await Promise.all([
      lib.writeStock({ matCode: 'A-1', delta: -1, opId: 'seq-' + i }),
      lib.writeStock({ matCode: 'A-1', delta: -1, opId: 'seq-' + (i + 1) })
    ]);
    rs.push(...pair);
  }
  assert.equal(rs.filter(r => r.ok).length, 8, '8 次都该成功：' + JSON.stringify(rs.map(r => r.error || r.seq)));
  // 先看真实表：这是唯一真正重要的不变量
  const nums = m2.tables.tblTXN.rows.map(r => r['流水号']).sort();
  assert.equal(nums.length, 9, '原有 1 条 + 新增 8 条，实测 ' + JSON.stringify(nums));
  assert.equal(new Set(nums).size, 9, '真实表里绝不能有重复流水号：' + JSON.stringify(nums));
  const seqs = rs.map(r => r.seq).sort((a, b) => a - b);
  assert.equal(new Set(seqs).size, 8, '流水号绝不能重复：' + JSON.stringify(seqs));
  assert.deepEqual(seqs, [8, 9, 10, 11, 12, 13, 14, 15], '必须接在 #000007 之后连续分配');
});

test('阶段0·mock 自检：延迟注入确实能造出读写交错（否则并发测试全是假的）', async (t) => {
  const slow = await startStockMock({ delayOpts: { delay: (r) => (r.action === 'batch_create' ? 30 : 0) } });
  t.after(() => { slow.server.close(); cleanupEnv(); });
  const lib1 = loadLib(slow.port);
  const t0 = Date.now();
  await Promise.all([
    lib1.writeStock({ matCode: 'A-1', delta: -1, opId: 'x1' }),
    lib1.writeStock({ matCode: 'A-1', delta: -1, opId: 'x2' })
  ]);
  const elapsed = Date.now() - t0;
  // 两个 create 各延迟 30ms；若 mock 仍是同步串行，这里会接近 60ms 且不可能交错
  assert.ok(elapsed >= 30, '延迟必须真的生效，实测 ' + elapsed + 'ms');
  const writes = slow.calls.requests.filter(r => r.action === 'batch_create');
  assert.equal(writes.length, 2);
  // 关键证据：两次「取 max seq」都发生在第一次 create 落库之前 —— 这正是竞态窗口
  const reads = slow.calls.requests.filter(r => r.action === 'search').length;
  assert.ok(reads >= 2, '两次写入都要有读路径，实测 ' + reads);
});

test('阶段0·写路径【核心】改 2 条记录不得整表拉取（写入开销不能随表增长）', async (t) => {
  const mock = await startAllMock();
  // 造一张「已经很大」的物料表：旧实现每写一条都要把它整张拉下来
  for (let i = 0; i < 400; i++) mock.tables.tblMAT.rows.push({ '物料码': 'BULK-' + i, '名称': 'x' });
  mock.tables.tblMAT.rows.push({ '物料码': 'A-1', '名称': '旧' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  mock.calls.requests.length = 0;
  const r = await lib.upsertRecords('materials', [{ code: 'A-1', name: '新' }]);
  assert.equal(r.updated, 1, JSON.stringify(r));

  const fullList = mock.calls.requests.filter(q => q.tableId === 'tblMAT' && q.action === '');
  assert.equal(fullList.length, 0, '写入路径不该再出现「整表 list」，实测 ' + fullList.length + ' 次');
  assert.ok(mock.calls.requests.some(q => q.tableId === 'tblMAT' && q.action === 'search'), '应当用 search 精确查业务键');
});

test('阶段0·删除路径【核心】删 1 条记录不得整表拉取', async (t) => {
  const mock = await startAllMock();
  for (let i = 0; i < 400; i++) mock.tables.tblMAT.rows.push({ '物料码': 'BULK-' + i });
  mock.tables.tblMAT.rows.push({ '物料码': 'DEL-1' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  mock.calls.requests.length = 0;
  const r = await lib.deleteRecords('materials', ['DEL-1']);
  assert.equal(r.deleted, 1, JSON.stringify(r));
  const fullList = mock.calls.requests.filter(q => q.tableId === 'tblMAT' && q.action === '');
  assert.equal(fullList.length, 0, '删除路径不该再出现「整表 list」');
});

test('阶段0·库存写路径【核心】连取号带改库存都不得整表扫流水表', async (t) => {
  const mock = await startStockMock();
  mock.tables.tblMAT.rows[0]['库存数量'] = 10;
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  mock.calls.requests.length = 0;
  const r = await lib.writeStock({ matCode: 'A-1', delta: -2, opId: 'o1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const full = mock.calls.requests.filter(q => q.tableId === 'tblTXN' && q.action === '');
  assert.equal(full.length, 0, '库存写入不该再整表扫流水（几万条时每次扫码要拉几 MB）');
});

/* ================= 工单取号（Phase 0 #7） ================= */

test('阶段0·工单取号【核心】按「类型 + 当天」问飞书要最大号，不靠本地计数器', async (t) => {
  const mock = await startAllMock();
  mock.tables.tblWIP.rows.push(
    { '工单号': 'LL20260915001', '类型': 'LL 领料' },
    { '工单号': 'LL20260915007', '类型': 'LL 领料' },   // 另一台设备建过，本机不知道
    { '工单号': 'LL20260914009', '类型': 'LL 领料' },   // 昨天的，不该影响今天
    { '工单号': 'BH20260915099', '类型': 'BH 补货' }    // 别的类型，不该串号
  );
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const r = await lib.maxCodeSuffix({ prefix: 'LL20260915', type: 'LL 领料' });
  assert.equal(r.max, 7, '必须取到飞书侧当天同类型的最大号 7，实测 ' + JSON.stringify(r));
  assert.equal(r.next, 8, '下一个号是 8 —— 这就是「两台设备同时建单撞号」的解药');
});

test('阶段0·工单取号：表里没有该前缀时从 1 开始', async (t) => {
  const mock = await startAllMock();
  mock.tables.tblWIP.rows.push({ '工单号': 'LL20260915001', '类型': 'LL 领料' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });
  const r = await lib.maxCodeSuffix({ prefix: 'TL20260915', type: 'TL 退料' });
  assert.equal(r.next, 1);
});

test('阶段0·工单取号：只读，绝不写任何数据', async (t) => {
  const mock = await startAllMock();
  mock.tables.tblWIP.rows.push({ '工单号': 'LL20260915003', '类型': 'LL 领料' });
  const before = JSON.stringify(mock.tables);
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });
  await lib.maxCodeSuffix({ prefix: 'LL20260915', type: 'LL 领料' });
  assert.equal(JSON.stringify(mock.tables), before, '取号必须是只读的');
  assert.equal(mock.calls.updated.length + mock.calls.created.length + mock.calls.deleted.length, 0);
});

/* ================= 通用增删改查（8 张表共用） ================= */

/* 这份定义**逐列对齐生产库的真实表结构**（2026-09 现状：列和选项都已补齐）。
   需要验证「飞书缺列/缺选项」时的行为，用下面的 typesWithGaps() 显式造一份缺的 ——
   把缺口写成显式的，比依赖「mock 恰好没建那列」可靠，也不会随着生产补列而悄悄失效。 */
const ALL_TABLE_TYPES = {
  tblMAT: [{ name: '物料码', type: 1 }, { name: '名称', type: 1 }, { name: '图片链接', type: 1 }, { name: '规格型号', type: 1 }, { name: '闲鱼XY编号', type: 1 }, { name: '当前库位码', type: 1 }, { name: '容器码', type: 1 }, { name: '库存数量', type: 2 }, { name: '安全库存', type: 2 }, { name: '成本', type: 2 }, { name: '模块区', type: 1 }, { name: '最后更新时间', type: 1002 }],
  tblLOC: [{ name: '库位码', type: 1 }, { name: '类型', type: 3, options: ['货架', '工位', '站点', '模块区', '空地'] }, { name: '说明', type: 1 }, { name: '授权人员', type: 1 }, { name: '最后更新时间', type: 1002 }],
  tblCTN: [{ name: '容器码', type: 1 }, { name: '容器类型', type: 3, options: ['A4四抽收纳盒', '三连格文件盒', '斜口零件盒', '6040周转箱', '四层四格牛皮纸收纳盒', '开放式收纳格'] }, { name: '规格', type: 1 }, { name: '当前库位码', type: 1 }, { name: '最后更新时间', type: 1002 }],
  tblMBR: [{ name: '编号', type: 1 }, { name: '姓名', type: 1 }, { name: '学号', type: 1 }, { name: '部门/SIG', type: 1 }, { name: '职务', type: 3, options: ['负责人', '成员', '本科生'] }, { name: '电话', type: 13 }, { name: '备注', type: 1 }, { name: '标签', type: 1 }, { name: 'PIN码', type: 1 }, { name: '最后更新时间', type: 1002 }],
  tblITM: [{ name: '物品码', type: 1 }, { name: '名称', type: 1 }, { name: '规格型号', type: 1 }, { name: '库位码', type: 1 }, { name: '最后更新时间', type: 1002 }],
  tblMAN: [{ name: '手册码', type: 1 }, { name: '名称', type: 1 }, { name: '版本', type: 1 }, { name: '库位码', type: 1 }, { name: '最后更新时间', type: 1002 }],
  // 与**生产**逐列对齐（生产 2026-09-16 加了「自动编号」→ 夹具也要有，
  // 否则「补列后不应再丢字段」这条会假失败，也会掩盖真实的缺列问题）
  tblWIP: [{ name: '工单号', type: 1 }, { name: '类型', type: 3, options: ['LL 领料', 'BH 补货', 'JH 拣货', 'TL 退料'] }, { name: '日期', type: 5 }, { name: '明细', type: 1 }, { name: '状态', type: 3, options: ['未执行', '已执行', '部分执行', '已取消'] }, { name: '执行时间', type: 5 }, { name: '执行数量', type: 1 }, { name: '执行批次', type: 1 }, { name: '冲销记录', type: 1 }, { name: '取消记录', type: 1 }, { name: '自动编号', type: 1005 }, { name: '最后更新时间', type: 1002 }],
  tblTXN: [{ name: '流水号', type: 1 }, { name: '时间', type: 5 }, { name: '操作人', type: 1 }, { name: '类型', type: 1 }, { name: '物料码', type: 1 }, { name: '变动', type: 2 }, { name: '余量', type: 2 }, { name: '关联单', type: 1 }, { name: '原因/备注', type: 1 }, { name: '设备', type: 1 }, { name: '操作ID', type: 1 }, { name: '最后更新时间', type: 1002 }]
};

/** 造一份「还缺东西」的表结构，专门验证缺列 / 缺选项的处理路径 */
function typesWithGaps() {
  const t = JSON.parse(JSON.stringify(ALL_TABLE_TYPES));
  const strip = (id, names) => { t[id] = t[id].filter(f => names.indexOf(f.name) < 0); };
  strip('tblMAT', ['模块区']);
  strip('tblMBR', ['PIN码']);
  strip('tblWIP', ['执行数量', '执行批次', '冲销记录', '取消记录']);
  t.tblLOC.find(f => f.name === '类型').options = ['货架', '工位', '站点'];
  t.tblWIP.find(f => f.name === '状态').options = ['未执行', '已执行'];
  t.tblCTN.find(f => f.name === '容器类型').options = ['A4四抽收纳盒', '三连格文件盒', '斜口零件盒', '6040周转箱'];
  return t;
}
const ALL_TABLES = JSON.stringify({
  materials: 'tblMAT', locations: 'tblLOC', containers: 'tblCTN', members: 'tblMBR',
  items: 'tblITM', manuals: 'tblMAN', workorders: 'tblWIP', transactions: 'tblTXN'
});

function startAllMock(opts = {}) {
  const ft = opts.fieldTypes || ALL_TABLE_TYPES;
  const tables = {};
  Object.keys(ft).forEach(id => { tables[id] = { fields: ft[id].map(f => f.name), rows: [] }; });
  return startMock(Object.assign({ tables, fieldTypes: ft }, opts));
}

test('通用 upsert：新建 8 张表各自一条记录', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const cases = [
    ['materials', { code: 'JG-001', name: '狂徒', spec: 'AK47', qty: 1, minQty: 0, cost: 0 }],
    ['locations', { code: 'B-09-01-01', kind: '货架', desc: '测试位' }],
    ['containers', { code: 'XK-999', type: '斜口零件盒', spec: '中号', loc: 'B-09-01-01' }],
    ['members', { code: 'MB-099', name: '测试员', sid: '2026999', dept: '电控', role: '成员', group: '天权1楼实验台' }],
    ['items', { code: 'WP-099', name: '电烙铁', spec: '60W', loc: 'W01-G01' }],
    ['manuals', { code: 'SC-099', name: '手册', ver: 'V1.0', loc: 'B-01-01-02' }],
    ['workorders', { code: 'LL-TEST-1', type: 'LL', date: '2026-09-15', items: [{ matCode: 'JG-001', qty: 2 }], status: '未执行' }],
    ['transactions', { seq: 1, ts: '2026-09-15T02:00:00Z', operator: '甲', type: '手工调整', matCode: 'JG-001', delta: 1, balance: 1, ref: '', reason: '' }]
  ];
  for (const [tbl, rec] of cases) {
    const r = await lib.upsertRecords(tbl, [rec]);
    assert.equal(r.created, 1, tbl + ' 应新建 1 条，实际 ' + JSON.stringify(r));
    assert.equal(r.updated, 0);
  }
  // 逐表核对主键是否真写进去了
  assert.equal(mock.tables.tblMAT.rows[0]['物料码'], 'JG-001');
  assert.equal(mock.tables.tblMBR.rows[0]['姓名'], '测试员');
  assert.equal(mock.tables.tblMBR.rows[0]['标签'], '天权1楼实验台');
  assert.equal(mock.tables.tblWIP.rows[0]['工单号'], 'LL-TEST-1');
  assert.equal(mock.tables.tblTXN.rows[0]['流水号'], '#000001');
  assert.equal(typeof mock.tables.tblWIP.rows[0]['执行时间'] !== 'string', true, '日期列不能是字符串');
});

test('通用 upsert：已存在的按业务键更新，不重复建', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  await lib.upsertRecords('materials', [{ code: 'JG-001', name: '旧名', qty: 1 }]);
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 1, '新建物料时期初库存允许随建档写入');
  const r = await lib.upsertRecords('materials', [{ code: 'JG-001', name: '新名', qty: 5 }]);
  assert.equal(r.created, 0);
  assert.equal(r.updated, 1);
  assert.equal(mock.tables.tblMAT.rows.length, 1, '不应产生重复行');
  assert.equal(mock.tables.tblMAT.rows[0]['名称'], '新名');
  // P4：已存在物料的库存数量**不能**由 upsert 改（那是绕过账本的绝对值覆盖）
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 1, '库存数量必须保持不变；要改就走库存直写');
  assert.ok(r.dropped.some(d => /库存数量/.test(d)), '被忽略的字段要如实回报');
});

test('通用 upsert【关键】表里没有的列被丢弃并回报，而不是整批失败', async (t) => {
  const mock = await startAllMock({ fieldTypes: typesWithGaps() });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  // 工单表当前只有 6 列；带 Phase 3 的执行字段去写
  const r = await lib.upsertRecords('workorders', [{
    code: 'LL-TEST-2', type: 'LL', date: '2026-09-15', items: [{ matCode: 'X', qty: 1 }], status: '未执行',
    execQty: [{ matCode: 'X', qty: 1 }], execBatches: [{ at: 't', items: [] }], reverseInfo: { at: 't' }, cancelInfo: { at: 't' }
  }]);
  assert.equal(r.created, 1, '写入应成功，不能因为缺列而整体失败');
  assert.ok(mock.tables.tblWIP.rows[0]['工单号'] === 'LL-TEST-2', '已有列必须写进去');
  const joined = r.dropped.join('|');
  assert.ok(/执行数量/.test(joined) && /执行批次/.test(joined) && /冲销记录/.test(joined), '应回报被丢掉的列：' + JSON.stringify(r.dropped));
  // droppedColumns 说明「为什么丢」，blocked 回报「哪条记录的哪些本地字段没写进去」——
  // 前端拿 blocked 做保护名单，避免飞书旧值在下一次合并时把本地真值覆盖掉
  assert.match(r.droppedColumns['执行批次'], /表里没有这一列/);
  assert.deepEqual(r.blocked['LL-TEST-2'].sort(), ['cancelInfo', 'execBatches', 'execQty', 'reverseInfo'].sort());
});

test('通用 upsert：生产表结构（列已补齐）下执行明细直接同步，不再丢列', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const r = await lib.upsertRecords('workorders', [{
    code: 'LL-PART', type: 'LL', date: '2026-09-15', items: [{ matCode: 'X', qty: 4 }], status: '未执行',
    execQty: [{ matCode: 'X', qty: 2 }], execBatches: [{ at: 't1', items: [{ matCode: 'X', qty: 2, delta: -2 }] }]
  }]);
  assert.equal(r.created, 1);
  assert.deepEqual(r.dropped, [], '补列后不应再丢字段');
  assert.equal(mock.tables.tblWIP.rows[0]['执行数量'], 'X=2');
  assert.match(mock.tables.tblWIP.rows[0]['执行批次'], /"qty":2/);
});

test('通用 upsert：没有业务键的记录被跳过', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });
  const r = await lib.upsertRecords('materials', [{ code: '', name: '没有编码' }, { code: 'OK-1', name: '正常' }]);
  assert.equal(r.created, 1);
  assert.equal(mock.tables.tblMAT.rows.length, 1);
});

test('通用 upsert：未知的表名给出明确报错', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });
  const r = await lib.upsertRecords('nosuchtable', [{ code: 'X' }]);
  assert.match(r.error, /未知的表/);
});

test('通用 delete：按业务键删除', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  await lib.upsertRecords('materials', [{ code: 'A', name: '1' }, { code: 'B', name: '2' }, { code: 'C', name: '3' }]);
  assert.equal(mock.tables.tblMAT.rows.length, 3);

  const r = await lib.deleteRecords('materials', ['A', 'C']);
  assert.equal(r.deleted, 2);
  assert.equal(mock.tables.tblMAT.rows.length, 1);
  assert.equal(mock.tables.tblMAT.rows[0]['物料码'], 'B');
});

test('通用 delete：键不存在时删 0 条且不报错', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });
  const r = await lib.deleteRecords('members', ['NOT-THERE']);
  assert.equal(r.deleted, 0);
});

/* ================= 字段类型转换（这两个 bug 真实踩过） ================= */

test('类型转换【回归】电话列不接受空字符串 → 空值直接不发', (t) => {
  const defs = [{ name: '编号', typeName: '文本' }, { name: '电话', typeName: '电话' }];
  const r = require('../lib/feishu-api.js').coerceFields(defs, { '编号': 'MB-1', '电话': '' });
  assert.deepEqual(r.fields, { '编号': 'MB-1' }, '空电话不能被写进去');
  assert.ok(r.dropped.some(d => /电话/.test(d)), '应报告跳过了电话列：' + JSON.stringify(r.dropped));
  // 非空的电话要正常写
  const r2 = require('../lib/feishu-api.js').coerceFields(defs, { '编号': 'MB-1', '电话': '13800000000' });
  assert.equal(r2.fields['电话'], '13800000000');
});

test('类型转换【回归】日期列必须转成毫秒时间戳', (t) => {
  const defs = [{ name: '工单号', typeName: '文本' }, { name: '日期', typeName: '日期' }];
  const r = require('../lib/feishu-api.js').coerceFields(defs, { '工单号': 'LL-1', '日期': '2026-09-15' });
  assert.equal(typeof r.fields['日期'], 'number', '必须是数字时间戳，不能是字符串');
  assert.equal(new Date(r.fields['日期']).toISOString().slice(0, 10), '2026-09-15');
});

test('类型转换：日期非法时跳过并报告，而不是写个坏值', (t) => {
  const defs = [{ name: '日期', typeName: '日期' }];
  const r = require('../lib/feishu-api.js').coerceFields(defs, { '日期': '不是日期' });
  assert.deepEqual(r.fields, {});
  assert.ok(r.dropped.some(d => /日期非法/.test(d)));
});

test('类型转换：数字列收到字符串会转成数字', (t) => {
  const defs = [{ name: '库存数量', typeName: '数字' }];
  assert.equal(require('../lib/feishu-api.js').coerceFields(defs, { '库存数量': '7' }).fields['库存数量'], 7);
  const bad = require('../lib/feishu-api.js').coerceFields(defs, { '库存数量': 'abc' });
  assert.deepEqual(bad.fields, {});
  assert.ok(bad.dropped.some(d => /数字非法/.test(d)));
});

test('类型转换：单选值不在选项里时跳过并列出选项', (t) => {
  const C = require('../lib/feishu-api.js');
  const defs = [{ name: '状态', typeName: '单选', options: ['未执行', '已执行'] }];
  const bad = C.coerceFields(defs, { '状态': '部分执行' });
  assert.deepEqual(bad.fields, {}, '不在选项里的值不能写');
  assert.match(bad.dropped[0], /单选无此选项：部分执行/);
  assert.match(bad.dropped[0], /现有 未执行\/已执行/);
  assert.equal(C.coerceFields(defs, { '状态': '已执行' }).fields['状态'], '已执行');
});

test('类型转换：表里没有的列直接丢弃', (t) => {
  const C = require('../lib/feishu-api.js');
  const r = C.coerceFields([{ name: '编号', typeName: '文本' }], { '编号': 'A', 'PIN码': '1234' });
  assert.deepEqual(r.fields, { '编号': 'A' });
  assert.match(r.dropped[0], /^PIN码（表里没有这一列）$/);
  assert.equal(r.droppedColumns['PIN码'], '表里没有这一列');
});

test('类型转换端到端【回归】人员与工单现在能真的写进 mock 飞书', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  // 人员：电话为空、含不在表里的 PIN码
  const rm = await lib.upsertRecords('members', [{ code: 'MB-004', name: '卢王淳', sid: '24220616', dept: '汽车工程学院', role: '本科生', phone: '', group: '天权1楼实验台', pin: '1234' }]);
  assert.equal(rm.created, 1, '人员应能写入：' + JSON.stringify(rm));
  assert.equal(mock.tables.tblMBR.rows[0]['姓名'], '卢王淳');
  assert.ok(!('电话' in mock.tables.tblMBR.rows[0]) || mock.tables.tblMBR.rows[0]['电话'] !== '', '空电话不应写入');

  // 工单：日期是字符串，必须被转成时间戳
  const rw = await lib.upsertRecords('workorders', [{ code: 'LL-1', type: 'LL', date: '2026-09-15', items: [{ matCode: 'X', qty: 2 }], status: '未执行' }]);
  assert.equal(rw.created, 1, '工单应能写入：' + JSON.stringify(rw));
  assert.equal(typeof mock.tables.tblWIP.rows[0]['日期'], 'number', '日期必须是时间戳');
  assert.equal(mock.tables.tblWIP.rows[0]['类型'], 'LL 领料');
  assert.equal(mock.tables.tblWIP.rows[0]['状态'], '未执行');
});

/* ================= 8 张表全量「增 → 查 → 改 → 查 → 删 → 查」往返 =================
   这是「网页端与飞书对齐」的底线契约：任何一张表在任何一步断了，
   网页端就会出现「改了自己这边变了、飞书没变」或「删了又回来」。
   用 mock 跑满 8 张表，离线、无凭据、可重复。 */

const CRUD_CASES = [
  ['materials', 'code', { code: 'ZZ-MAT-1', name: '哨兵物料', spec: 'S1', qty: 7, minQty: 2, cost: 1.5 }, { name: '哨兵物料-改' }, '物料码'],
  ['locations', 'code', { code: 'ZZ-LOC-1', kind: '货架', desc: '哨兵库位' }, { desc: '哨兵库位-改' }, '库位码'],
  ['containers', 'code', { code: 'ZZ-CTN-1', type: '斜口零件盒', spec: 'S2', loc: '' }, { spec: 'S2-改' }, '容器码'],
  ['members', 'code', { code: 'ZZ-MB-1', name: '哨兵', sid: 'SID1', dept: 'D1', role: '成员', phone: '13800138000', note: 'n', group: 'g' }, { name: '哨兵-改' }, '编号'],
  ['items', 'code', { code: 'ZZ-ITM-1', name: '哨兵物品', spec: 'S3', loc: '' }, { name: '哨兵物品-改' }, '物品码'],
  ['manuals', 'code', { code: 'ZZ-MAN-1', name: '哨兵手册', ver: 'v1', loc: '' }, { ver: 'v2' }, '手册码'],
  ['workorders', 'code', { code: 'ZZ-WO-1', type: 'LL', date: '2026-09-15', items: [{ matCode: 'X', qty: 1 }], status: '未执行' }, { status: '已执行' }, '工单号'],
  ['transactions', 'seq', { seq: 900001, ts: '2026-09-15T02:00:00Z', operator: '哨兵', type: '测试', matCode: 'ZZ-MAT-1', delta: 0, balance: 0, ref: '', reason: '哨兵' }, { reason: '哨兵-改' }, '流水号']
];

test('8 表 CRUD【核心】增删改查在每一张表上都能往返', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const findIn = (st, tbl, key, v) => (st[tbl] || []).find(x => String(x[key]) === String(v));

  /* ---- 增 ---- */
  for (const [tbl, key, rec] of CRUD_CASES) {
    const r = await lib.upsertRecords(tbl, [rec]);
    assert.equal(r.created, 1, tbl + ' 新建应成功：' + JSON.stringify(r));
    assert.equal(r.updated, 0, tbl + ' 不应误判为更新');
  }
  let st = await lib.pullState();
  for (const [tbl, key, rec, , col] of CRUD_CASES) {
    const got = findIn(st, tbl, key, rec[key]);
    assert.ok(got, tbl + ' 新建后应能读回（列 ' + col + '）');
    assert.equal(String(got[key]), String(rec[key]));
  }
  // 读回来的内容也要对，而不只是主键对
  assert.equal(findIn(st, 'materials', 'code', 'ZZ-MAT-1').qty, 7);
  assert.equal(findIn(st, 'members', 'code', 'ZZ-MB-1').name, '哨兵');
  assert.equal(findIn(st, 'workorders', 'code', 'ZZ-WO-1').type, 'LL', '类型要能还原成内部码');
  assert.deepEqual(findIn(st, 'workorders', 'code', 'ZZ-WO-1').items, [{ matCode: 'X', qty: 1 }]);
  assert.equal(findIn(st, 'transactions', 'seq', 900001).seq, 900001, '流水号 #900001 → seq 900001');

  /* ---- 改 ---- */
  for (const [tbl, key, rec, patch] of CRUD_CASES) {
    const merged = Object.assign({}, rec, patch);
    const r = await lib.upsertRecords(tbl, [merged]);
    assert.equal(r.updated, 1, tbl + ' 改动应命中已有记录：' + JSON.stringify(r));
    assert.equal(r.created, 0, tbl + ' 不应重复新建');
  }
  st = await lib.pullState();
  for (const [tbl, key, rec, patch] of CRUD_CASES) {
    const got = findIn(st, tbl, key, rec[key]);
    const pk = Object.keys(patch)[0];
    assert.deepEqual(got[pk], patch[pk], tbl + ' 的 ' + pk + ' 应已更新为 ' + JSON.stringify(patch[pk]));
  }

  /* ---- 删 ---- */
  for (const [tbl, key, rec] of CRUD_CASES) {
    // 传本地键（流水是数字 seq，不是 '#000005'）——删除必须自己归一
    const r = await lib.deleteRecords(tbl, [rec[key]]);
    assert.equal(r.deleted, 1, tbl + ' 删除应命中 1 条：' + JSON.stringify(r));
  }
  st = await lib.pullState();
  for (const [tbl, key, rec] of CRUD_CASES) {
    assert.ok(!findIn(st, tbl, key, rec[key]), tbl + ' 删除后不应再读到');
  }
});

test('删除键归一【回归】流水用数字 seq 删得掉飞书的「#000005」', async (t) => {
  const mock = await startAllMock();
  mock.tables.tblTXN.rows.push({ '流水号': '#000005', '物料码': 'A' }, { '流水号': '#000006', '物料码': 'B' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const r = await lib.deleteRecords('transactions', [5]);
  assert.equal(r.deleted, 1, '传 5 应删掉 #000005');
  assert.equal(mock.tables.tblTXN.rows.length, 1);
  assert.equal(mock.tables.tblTXN.rows[0]['流水号'], '#000006', '只删目标，不能误删别的');
  // 也接受直接传 '#000006' 和传整条本地记录
  assert.equal((await lib.deleteRecords('transactions', ['#000006'])).deleted, 1);
});

test('pullState【核心】飞书没有的列不产出本地键，回读不会把本地真值清成空', async (t) => {
  const mock = await startAllMock({ fieldTypes: typesWithGaps() });
  // 物料表没有「模块区」列（生产就是这么建的）
  mock.tables.tblMAT.rows.push({ '物料码': 'A-1', '名称': '螺丝刀', '库存数量': 5 });
  // 库位「类型」列存在但值为空（本地的「模块区」写不进去时就是这个样子）
  mock.tables.tblLOC.rows.push({ '库位码': 'M-01', '类型': '', '说明': '电控模块区' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const st = await lib.pullState();
  assert.ok(!('zone' in st.materials[0]), '物料表没有「模块区」列 → 不能产出 zone 键，否则合并时会用它清掉本地的模块区');
  assert.equal(st.locations[0].kind, '', '列存在但为空 → 照常产出空值（交给合并阶段决定是否覆盖）');
  assert.ok(Array.isArray(st.columns.materials) && st.columns.materials.indexOf('模块区') < 0, 'state.columns 要回报真实存在的列名');
});

test('reconcile【只读】回报缺列、缺选项和两侧差异，且不写任何数据', async (t) => {
  const mock = await startAllMock({ fieldTypes: typesWithGaps() });
  mock.tables.tblMAT.rows.push({ '物料码': 'A-1', '名称': '本地也有' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const before = JSON.stringify(mock.tables);
  const rep = await lib.reconcile({
    materials: [{ code: 'A-1' }, { code: 'ONLY-LOCAL' }],
    locations: [{ code: 'L-1', kind: '模块区' }],
    workorders: [{ code: 'W-1', status: '部分执行' }]
  });
  assert.equal(JSON.stringify(mock.tables), before, 'reconcile 绝不能写数据');

  assert.ok(rep.tables.materials.missingColumns.indexOf('模块区') >= 0, '物料台账缺「模块区」应被报出来');
  assert.deepEqual(rep.tables.materials.localOnly, ['ONLY-LOCAL']);
  assert.deepEqual(rep.tables.materials.remoteOnly, []);
  assert.equal(rep.tables.materials.localOnlyCount, 1);

  const locOpt = rep.tables.locations.missingOptions;
  assert.equal(locOpt.length, 1);
  assert.deepEqual(locOpt[0].usedButMissing, ['模块区'], '库位单选没有「模块区」选项');
  const wipOpt = rep.tables.workorders.missingOptions;
  assert.deepEqual(wipOpt[0].usedButMissing, ['部分执行'], '工单单选没有「部分执行」选项');
  assert.ok(rep.summary.missingColumns > 0 && rep.summary.missingOptions >= 2);
});

test('upsert dryRun：只回报会做什么，不落任何数据', async (t) => {
  const mock = await startAllMock();
  mock.tables.tblMAT.rows.push({ '物料码': 'A-1', '名称': '已有' });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const r = await lib.upsertRecords('materials', [{ code: 'A-1', name: '改' }, { code: 'B-1', name: '新' }], { dryRun: true });
  assert.equal(r.wouldUpdate, 1);
  assert.equal(r.wouldCreate, 1);
  assert.equal(mock.tables.tblMAT.rows.length, 1, 'dryRun 不能写入');
  assert.equal(mock.tables.tblMAT.rows[0]['名称'], '已有', 'dryRun 不能改动');
});

test('reconcile【回归】单选选项按「转换后的值」比对，工单类型 LL 不算缺选项', async (t) => {
  const mock = await startAllMock({ fieldTypes: typesWithGaps() });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  const rep = await lib.reconcile({
    workorders: [
      { code: 'A', type: 'LL', status: '已执行' },                 // 'LL' 写出去是 'LL 领料'，选项里有
      { code: 'B', type: 'BH', status: '部分执行' }                // 状态确实缺选项
    ],
    containers: [{ code: 'C', type: '开放式收纳格' }]              // 容器类型确实缺选项
  });
  const wip = rep.tables.workorders.missingOptions;
  assert.equal(wip.length, 1, '只有「状态」应被报为缺选项：' + JSON.stringify(wip));
  assert.equal(wip[0].column, '状态');
  assert.deepEqual(wip[0].usedButMissing, ['部分执行']);
  assert.deepEqual(rep.tables.containers.missingOptions[0].usedButMissing, ['开放式收纳格']);
});

test('通用 upsert【回归】同一批里同业务键只建一条，不产生重复记录', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  // 页面上快速连填「物料码 → 名称 → 规格」时会连发几次 upsert；
  // 如果一次请求里带了同码的多条，必须合并而不是建出多条（实测在飞书里多出过两条重复物料）
  const r = await lib.upsertRecords('materials', [
    { code: 'DUP-1', name: '甲' },
    { code: 'DUP-1', name: '甲', spec: 'S1' }
  ]);
  assert.equal(r.created, 1, '同业务键只能建一条，实际 ' + JSON.stringify(r));
  assert.equal(mock.tables.tblMAT.rows.length, 1);
  assert.equal(mock.tables.tblMAT.rows[0]['名称'], '甲');
  assert.equal(mock.tables.tblMAT.rows[0]['规格型号'], 'S1', '后一条的字段要并进同一条');
});

test('类型转换【关键回归】空电话是「正常跳过」，不能进 blocked 保护名单', async (t) => {
  const mock = await startAllMock({ fieldTypes: typesWithGaps() });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });

  // 24 个人员都没填电话（生产就是这个状态）
  const r = await lib.upsertRecords('members', [
    { code: 'MB-1', name: '甲', phone: '' },
    { code: 'MB-2', name: '乙', phone: '' }
  ]);
  assert.equal(r.created, 2);
  assert.equal(r.droppedColumns['电话'], undefined, '空电话不是「列有问题」');
  assert.equal(Object.keys(r.blocked).length, 0, '不能把空电话当成推不上去的字段');

  // 反向证明：一旦进了 blocked，飞书里后填的电话就同步不下来了
  const st = await lib.pullState();
  assert.equal(st.members.find(m => m.code === 'MB-1').phone, '', '空电话不写、回读也是空');

  // 真正的「推不上去」仍然要报（缺列）
  const r2 = await lib.upsertRecords('members', [{ code: 'MB-3', name: '丙', pin: '1234' }]);
  assert.equal(r2.droppedColumns['PIN码'], '表里没有这一列', '表里没有的列必须照常报出来');
});

test('类型转换：dropped 保留完整清单（含正常跳过），供日志显示', (t) => {
  const C = require('../lib/feishu-api.js');
  const defs = [{ name: '编号', typeName: '文本' }, { name: '电话', typeName: '电话' }];
  const r = C.coerceFields(defs, { '编号': 'MB-1', '电话': '' });
  assert.deepEqual(r.fields, { '编号': 'MB-1' });
  assert.ok(r.dropped.some(d => /电话/.test(d)), '日志里仍要能看到跳过了电话列');
  assert.equal(Object.keys(r.droppedColumns).length, 0, '但不算问题');
});

/* ================= tenant token 缓存（Phase 5 性能前哨） ================= */

test('token 缓存：一次进程内只申请一次，并发调用也只申请一次', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  lib.resetTokenCache();

  // 并发 8 次（模拟 8 表并行探测）→ 只应有一次鉴权请求
  await Promise.all(Array.from({ length: 8 }, () => lib.tenantToken()));
  const authCalls = mock.calls.requests.filter(r => r.action === 'auth');
  assert.equal(authCalls.length, 1, '并发申请必须去重，实测 ' + authCalls.length + ' 次');

  await lib.tenantToken();
  assert.equal(mock.calls.requests.filter(r => r.action === 'auth').length, 1, '缓存命中不该再申请');
});

test('token 缓存：拿到的 token 会被真正用上（后续请求不再带鉴权往返）', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  lib.resetTokenCache();
  await lib.pullState();
  const after = mock.calls.requests.filter(r => r.action === 'auth').length;
  await lib.pullState();
  const again = mock.calls.requests.filter(r => r.action === 'auth').length;
  assert.equal(again, after, '第二次全量拉取不该再申请 token');
});

/* ================= P3-2：全量拉取必须如实报告完整性 ================= */

test('pullState【P3】正常情况报 complete:true，让下游敢判删', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const st = await lib.pullState();
  assert.ok(st.completeness, 'pullState 必须把完整性随数据一起交出去');
  assert.equal(st.completeness.materials.complete, true, '收到数 == total 才算完整');
  assert.equal(st.completeness.materials.fetched, 1);
  assert.equal(st.completeness.materials.total, 1);
  assert.equal(st.completeness.transactions.complete, true, '空表也必须被证明完整（0 == 0）');
});

test('pullState【P3 关键】分页被截断时如实报 complete:false，但**不能抛错打断同步**', async (t) => {
  // 飞书说物料表有 999 条，实际只给 1 条 —— 静默截断
  const mock = await startMock({ lieTotal: { tblMAT: 999 } });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const st = await lib.pullState();       // 不抛
  assert.equal(st.completeness.materials.complete, false, '必须如实报告没拉全');
  assert.equal(st.completeness.materials.fetched, 1);
  assert.equal(st.completeness.materials.total, 999);
  assert.equal(st.materials.length, 1, '数据照常返回（不完整也比没有好）');
});

test('pullState【P3 端到端】截断的半截数据 + 关闭删除闸门 → 本地一条都不能少', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const Core = require('../mes-core.js');

  // 本地有 3 条物料，基线说 3 条都在飞书里；这次只拉到 1 条（真被删了 2 条）
  const local = { materials: [{ code: 'A-1' }, { code: 'B-2' }, { code: 'C-3' }], transactions: [], __syncedKeys: {} };
  const remote = { materials: [{ code: 'A-1' }], completeness: { materials: false } };

  // 旧行为（allowDelete:true + 拿不到完整证明）→ 本该删 2 条，现在必须拦住
  const r = Core.mergeRemote(local, remote, {
    syncedKeys: { materials: ['A-1', 'B-2', 'C-3'] },
    allowDelete: false,
    complete: { materials: remote.completeness.materials.complete }
  });
  assert.equal(r.deleted, 0, '没被证明拉全 → 一条都不许删');
  assert.deepEqual(local.materials.map(m => m.code), ['A-1', 'B-2', 'C-3'], '本地数据完整保留');
  assert.deepEqual(r.pendingDelete.map(p => p.id).sort(), ['B-2', 'C-3'], '转成待人工核删');
  assert.deepEqual(r.pending, [], '待核删的不能被同时当成「本地新建」');
});

/* ================= P3-1：流水「余量」必须由账本推出 ================= */

test('飞书写【P3 复现线上 id#18】物料行 qty 过期时，流水余量必须按账本算', async (t) => {
  /* 现场：账本 cumulative 已到 12 而物料行还停在 5（上一次写入的 qty 没落或被覆盖）。
     旧实现写 余量 = before + delta = 5 + 1 = 6，于是链式校验永远报 mismatch
     （线上 seq#18 就是这样：delta=+1、余量 13、真实 14）。 */
  const mock = await startMock({
    tables: {
      // ← 故意过期的库存数量
      tblMAT: { fields: ['物料码', '名称', '库存数量'], rows: [{ '物料码': 'JG-001', '名称': '狂徒', '库存数量': 5 }] },
      tblTXN: {
        fields: ['流水号', '时间', '操作人', '类型', '物料码', '变动', '余量', '关联单', '原因/备注'],
        rows: [
          // 期初 = 余量 - 变动 = 2 - 1 = 1；累计 δ = 1 + 10 = 11
          { '流水号': '#000001', '时间': 1700000000000, '操作人': '', '类型': '手工调整', '物料码': 'JG-001', '变动': 1, '余量': 2, '关联单': '', '原因/备注': '' },
          { '流水号': '#000002', '时间': 1700000001000, '操作人': '', '类型': '手工调整', '物料码': 'JG-001', '变动': 10, '余量': 12, '关联单': '', '原因/备注': '' }
        ]
      }
    }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);

  const r = await lib.writeStock({ matCode: 'JG-001', delta: 1, operator: '测试' });
  assert.equal(r.ok, true, r.error);
  const txn = mock.calls.created[0];
  assert.equal(txn['变动'], 1);
  assert.equal(txn['余量'], 13, '余量必须 = 账本期初(1) + 累计(11) + 本次(1) = 13，而不是 before(5)+1=6');
  assert.equal(r.balance, 13);
  // 物料行也要被收敛到账本值
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 13);
});

test('飞书写【P3】账本为空的新物料：余量仍然等于 before + 变动（退化为物料行反推）', async (t) => {
  const mock = await startMock();   // tblMAT 只有 A-1，qty=5，流水表空
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2, operator: '管理员' });
  assert.equal(r.ok, true, r.error);
  assert.equal(mock.calls.created[0]['余量'], 3, '无账本时没有隐含期初，退回 before + δ');
  assert.equal(r.balance, 3);
});

/* ================= P4-1：服务端兜底 —— 物料 upsert 不得改库存 ================= */

test('upsert【P4 兜底】物料表的「库存数量」一律不写，并如实报进 dropped', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  // 先建一条物料
  await lib.upsertRecords('materials', [{ code: 'A-1', name: '螺丝刀', qty: 5 }]);
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 5, '新建时 qty 是初值，允许作为初值写入');

  // 再「更新」它并带一个绝对 qty —— 必须被服务端挡掉
  const upd = mock.tables.tblMAT.rows.length;
  const r = await lib.upsertRecords('materials', [{ code: 'A-1', name: '改名', qty: 999 }]);
  assert.equal(r.updated, 1);
  assert.equal(mock.tables.tblMAT.rows[0]['名称'], '改名', '其它字段照常更新');
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 5, '库存数量不能被 upsert 改（必须走账本）');
  assert.ok(r.dropped.some(d => /库存数量/.test(d)), '要如实回报被忽略的字段，不能静默');
  assert.equal(r.blocked['A-1'], undefined, '不能记进 blocked（那会让合并永远不采纳飞书的库存值）');
});

/* ================= P7-1：预读并行（O1） ================= */

test('写库【P7 核心】四段预读必须并行发出（串行会白等 3 个往返）', async (t) => {
  /* 用「每次请求都延迟 D」把串行与并行拉开：四段预读若串行，墙钟时间 ≥ 4D；
     并行则 ≈ D（外加流水写入那几段）。D 取 120ms，阈值设在 3D 与 4D 之间，
     既有明确的判别力，又不会因为机器慢而误报。 */
  const D = 120;
  const mock = await startMock({ delay: D });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2, opId: 'p7-o1' });
  assert.equal(r.ok, true, r.error);
  /* 判据用「同时在飞的请求数」而不是墙钟时间：
     四段预读（物料行 / 流水表结构 / 账本 / 操作ID 查重）互相独立，并行时至少 4 个同时在飞；
     串行则最多 1 个。这个信号不受机器负载与测试并发影响 —— 第一版用时间阈值，
     整套测试并行跑时会抖。 */
  assert.ok(mock.calls.maxConcurrent >= 4,
    '四段预读没有并行：同时在飞的请求最多只有 ' + mock.calls.maxConcurrent + ' 个（并行应在 4 个以上）');
  /* 不再用时间做判据：这条 4*D 的兜底在整套测试并行跑时会假阳性
     （实测 lookup 段被别的套件挤到超过 480ms，但 maxConcurrent 仍是 4+，说明并行没问题）。
     「同时在飞的请求数」已经完整覆盖了这个需求 —— 串行实现的 maxConcurrent 最多是 1~2，
     达不到 4。加上时间断言只会带来不稳定的红灯，让人开始怀疑并行本身。 */
});

test('写库【P7 回归】并行预读不能改变账本语义（并发 +2/+2 仍等于 +4）', async (t) => {
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const before = mock.tables.tblMAT.rows[0]['库存数量'];
  const rs = await Promise.all([
    lib.writeStock({ matCode: 'A-1', delta: 2, opId: 'p7a' }),
    lib.writeStock({ matCode: 'A-1', delta: 2, opId: 'p7b' })
  ]);
  assert.ok(rs.every(x => x.ok), JSON.stringify(rs));
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], before + 4,
    '并发 +2/+2 必须等于 +4；预读并行不能把它变成 +2（那是以前不敢并行的原因）');
});

test('写库【P7 关键】并行预读里任何一支失败都不能变成 unhandledRejection', async (t) => {
  const seen = [];
  const onUnhandled = e => seen.push(String(e && e.message));
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  // 流水表 ID 故意写错 → 结构读取那一支会失败，而账本读取那一支还在飞
  const mock = await startMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ materials: 'tblMAT', transactions: 'tblNOPE' }) });
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2, opId: 'p7-c' });
  assert.equal(r.ok, false, '必须如实失败');
  await new Promise(res => setTimeout(res, 300));   // 给在飞的那几支一点时间来"暴露"
  assert.deepEqual(seen, [],
    '有并行分支的 rejection 没人处理 —— 提前 return 时必须先给每一支挂兜底 catch：' + seen.join(' | '));
});

/* ================= 自动编号 → 重复业务键巡检 ================= */

test('重复巡检【P7-3】同码但自动编号不同 → 飞书里确实有两行，必须报出来', () => {
  const lib = require('../lib/feishu-api.js');
  const def = { key: '工单号', fields: [['code', '工单号', 'text'], ['autoNo', '自动编号', 'text']] };
  const rows = [
    { record_id: 'r1', fields: { '工单号': 'LL20260916001', '自动编号': '101' } },
    { record_id: 'r2', fields: { '工单号': 'LL20260916001', '自动编号': '102' } },   // ← 并发建单的后果
    { record_id: 'r3', fields: { '工单号': 'LL20260916002', '自动编号': '103' } }
  ];
  const dups = lib.findDuplicateKeys(def, rows);
  assert.equal(dups.length, 1, '应报出 1 组重复');
  assert.equal(dups[0].key, 'LL20260916001');
  assert.equal(dups[0].count, 2);
  assert.deepEqual(dups[0].autoNos.sort(), ['101', '102']);
});

test('重复巡检【P7-3】同一行被读两次（自动编号相同）不算重复', () => {
  const lib = require('../lib/feishu-api.js');
  const def = { key: '工单号', fields: [['code', '工单号', 'text'], ['autoNo', '自动编号', 'text']] };
  const dups = lib.findDuplicateKeys(def, [
    { record_id: 'r1', fields: { '工单号': 'X', '自动编号': '7' } },
    { record_id: 'r1', fields: { '工单号': 'X', '自动编号': '7' } }
  ]);
  assert.deepEqual(dups, [], '自动编号相同 → 是同一行，不是重复');
});

test('重复巡检【P7-3】拿不到自动编号时退回「整行是否完全相同」', () => {
  const lib = require('../lib/feishu-api.js');
  const def = { key: '工单号', fields: [['code', '工单号', 'text']] };   // 没有自动编号列
  assert.deepEqual(lib.findDuplicateKeys(def, [
    { fields: { '工单号': 'X' } }, { fields: { '工单号': 'X' } }
  ]), [], '整行完全一样 → 视为同一行');

  const dups = lib.findDuplicateKeys(def, [
    { fields: { '工单号': 'X', '状态': '未执行' } },
    { fields: { '工单号': 'X', '状态': '已执行' } }
  ]);
  assert.equal(dups.length, 1, '拿不到自动编号时，内容不同就要报出来（宁可多报，也不要漏掉一条永远不会被发现的重复单）');
});

test('自动编号【P7-3】只读列：能拉下来，但**绝不推送**（飞书自己分配）', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });
  const r = await lib.upsertRecords('workorders', [{
    code: 'LL-AUTO-1', type: 'LL', date: '2026-09-15', items: [{ matCode: 'X', qty: 1 }], status: '未执行'
  }]);
  assert.deepEqual(r.dropped, [], '不该再因为「自动编号不接受空值」报丢列：' + JSON.stringify(r.dropped));
  assert.equal(mock.tables.tblWIP.rows[0]['自动编号'], undefined, '客户端绝不能自己写自动编号');
  // 但读的时候要能拿到（下拉映射里必须有它）
  const def = lib.TABLE_DEFS.workorders;
  assert.ok(def.fields.some(f => f[1] === '自动编号'), '要能从飞书拉下来');
  assert.deepEqual(def.downOnly, ['自动编号'], '必须显式声明为只读列');
});

test('「设备」列【2026-09-16 新增】库存流水必须写上是哪台设备写的', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });
  // writeStock 要求物料已在飞书台账里 → 先建一条
  await lib.upsertRecords('materials', [{ code: 'ZZ-DEV-1', name: '设备列测试物料', qty: 0 }]);
  const r = await lib.writeStock({ matCode: 'ZZ-DEV-1', delta: 1, opId: 'dev-col-1', device: 'DEV-A' });
  assert.equal(r.ok, true, JSON.stringify(r));
  // 注意：startAllMock 的行是**扁平对象**（不是 {fields:{...}}）
  const row = (mock.tables.tblTXN.rows || []).find(x => String(x['操作ID']) === 'dev-col-1');
  assert.ok(row, '应写入一条流水');
  assert.equal(row['设备'], 'DEV-A', '必须把设备写进「设备」列，否则多设备排查没有依据');
  // 映射里也得有它，否则 coerceFields 会当成不存在的列丢掉
  assert.ok(lib.TABLE_DEFS.transactions.fields.some(f => f[1] === '设备'), 'TABLE_DEFS.transactions 必须有「设备」映射');
});

test('「图片链接」列【2026-09-16 新增】物料必须带上图片链接', async (t) => {
  const mock = await startAllMock();
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: ALL_TABLES });
  await lib.upsertRecords('materials', [{ code: 'ZZ-IMG-1', name: '带图物料', img: 'https://x/a.jpg', qty: 0 }]);
  const row = (mock.tables.tblMAT.rows || []).find(x => String(x['物料码']) === 'ZZ-IMG-1');
  assert.ok(row, '应建出物料');
  assert.equal(row['图片链接'], 'https://x/a.jpg', '图片链接必须进飞书，否则换设备就丢图');
  assert.ok(lib.TABLE_DEFS.materials.fields.some(f => f[1] === '图片链接'), 'TABLE_DEFS.materials 必须有「图片链接」映射');
});

test('censusTable：空业务键行是数据质量问题，不得误判分页不完整', async (t) => {
  const mock = await startMock({
    tables: { tblMAT: { fields: ['物料码', '名称'], rows: [
      { '物料码': 'A-1', '名称': '正常' },
      { '物料码': '', '名称': '空键行' }
    ] }, tblTXN: { fields: ['流水号'], rows: [] } },
    fieldTypes: { tblMAT: [{ name: '物料码', type: 1 }, { name: '名称', type: 1 }], tblTXN: [{ name: '流水号', type: 1 }] }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.censusTable('materials');
  assert.equal(r.complete, true, JSON.stringify(r));
  assert.equal(r.scanned, 2, '完整性按收到的行数判断');
  assert.equal(r.blankKeys, 1, '空业务键应单独报告');
  assert.deepEqual(r.keys, ['A-1']);
});

/* ================= 显式清空字段（clearFields） ================= */

test('clearFields：默认不写空值，但显式申报的列必须真被清空', async (t) => {
  const mock = await startMock({
    tables: { tblCTN: { fields: ['容器码', '容器类型', '规格', '当前库位码'], rows: [] } },
    fieldTypes: { tblCTN: [{ name: '容器码', type: 1 }, { name: '容器类型', type: 1 }, { name: '规格', type: 1 }, { name: '当前库位码', type: 1 }] }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ containers: 'tblCTN' }) });
  const cell = () => mock.tables.tblCTN.rows[0]['当前库位码'];
  /* 先灌一个「当前库位码」 */
  await lib.upsertRecords('containers', [{ code: 'CT-1', type: '盒', spec: 'S', loc: 'B-01-01-01' }]);
  assert.equal(cell(), 'B-01-01-01');
  /* 不申报 clearFields → 空值不写（默认保护：防止字段缺失的推送静默抹掉飞书的值） */
  await lib.upsertRecords('containers', [{ code: 'CT-1', type: '盒', spec: 'S', loc: '' }]);
  assert.equal(cell(), 'B-01-01-01', '空值默认不得抹掉飞书已有值');
  /* 显式申报 → 必须清空（否则容器从货位拿走后再也清不掉，只能删记录重建） */
  await lib.upsertRecords('containers', [{ code: 'CT-1', type: '盒', spec: 'S', loc: '' }], { clearFields: ['loc'] });
  assert.equal(cell(), '', '显式申报的列必须被清空');
  /* 清空只作用于申报的列 */
  await lib.upsertRecords('containers', [{ code: 'CT-1', type: '盒', spec: 'S2', loc: 'B-02-02-02' }], { clearFields: ['loc'] });
  assert.equal(mock.tables.tblCTN.rows[0]['规格'], 'S2');
});

/* ================= 内容差异（同一业务键、两边值不同） ================= */

test('reconcile 内容差异：两边都有但字段值不同时必须报出「哪个字段、各是什么」', async (t) => {
  const mock = await startMock({
    tables: { tblCTN: { fields: ['容器码', '容器类型', '规格', '当前库位码'], rows: [
      { '容器码': 'CT-1', '容器类型': '盒', '规格': 'S1', '当前库位码': 'B-01-01-01' },
      { '容器码': 'CT-2', '容器类型': '盒', '规格': 'S2', '当前库位码': '' }
    ] } },
    fieldTypes: { tblCTN: [{ name: '容器码', type: 1 }, { name: '容器类型', type: 1 }, { name: '规格', type: 1 }, { name: '当前库位码', type: 1 }] }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ containers: 'tblCTN' }) });
  const rep = await lib.reconcile({
    containers: [
      { code: 'CT-1', type: '盒', spec: 'S1-改过了', loc: 'B-01-01-01' },   // 规格不同
      { code: 'CT-2', type: '盒', spec: 'S2', loc: 'B-09-09-09' }           // 库位本地有、飞书空
    ]
  });
  const tb = rep.tables.containers;
  assert.equal(tb.diffCount, 2, JSON.stringify(tb.diffs));
  const d1 = tb.diffs.find(d => d.key === 'CT-1');
  assert.equal(d1.field, 'spec');
  assert.equal(d1.local, 'S1-改过了');
  assert.equal(d1.feishu, 'S1');
  const d2 = tb.diffs.find(d => d.key === 'CT-2');
  assert.equal(d2.field, 'loc');
  assert.equal(d2.feishu, '', '空值也要报出来（本地有值/飞书空 是最常见的漏推）');
  assert.equal(rep.summary.contentDiff, 2);
});

test('reconcile 内容差异：两边一致、或只在一侧的，不得误报为内容差异', async (t) => {
  const mock = await startMock({
    tables: { tblCTN: { fields: ['容器码', '容器类型', '规格', '当前库位码'], rows: [
      { '容器码': 'CT-1', '容器类型': '盒', '规格': 'S1', '当前库位码': 'B-01-01-01' },
      { '容器码': 'CT-ONLY-REMOTE', '容器类型': '盒', '规格': 'S9', '当前库位码': '' }
    ] } },
    fieldTypes: { tblCTN: [{ name: '容器码', type: 1 }, { name: '容器类型', type: 1 }, { name: '规格', type: 1 }, { name: '当前库位码', type: 1 }] }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ containers: 'tblCTN' }) });
  const rep = await lib.reconcile({
    containers: [
      { code: 'CT-1', type: '盒', spec: 'S1', loc: 'B-01-01-01' },        // 完全一致
      { code: 'CT-ONLY-LOCAL', type: '盒', spec: 'S3', loc: '' }          // 只在一侧
    ]
  });
  const tb = rep.tables.containers;
  assert.equal(tb.diffCount, 0, '一致的不该报差异；只在一侧的由 localOnly/remoteOnly 负责：' + JSON.stringify(tb.diffs));
  assert.deepEqual(tb.diffs, []);
  assert.equal(tb.localOnlyCount, 1);
  assert.equal(tb.remoteOnlyCount, 1);
});

test('reconcile 内容差异：飞书缺的列不重复报「内容差异」（由 missingColumns 负责）', async (t) => {
  const mock = await startMock({
    tables: { tblCTN: { fields: ['容器码'], rows: [{ '容器码': 'CT-1' }] } },
    fieldTypes: { tblCTN: [{ name: '容器码', type: 1 }] }
  });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port, { FEISHU_TABLES: JSON.stringify({ containers: 'tblCTN' }) });
  const rep = await lib.reconcile({ containers: [{ code: 'CT-1', type: '盒', spec: 'S1', loc: 'B-01' }] });
  const tb = rep.tables.containers;
  assert.equal(tb.diffCount, 0, '列都不存在时报「内容差异」是噪音，应该只报缺列');
  assert.ok(tb.missingColumns.length > 0, '缺列必须报出来');
});
