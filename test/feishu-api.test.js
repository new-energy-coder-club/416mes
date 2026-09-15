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


function startMock(opts = {}) {
  const tables = opts.tables || {
    tblMAT: { fields: ['物料码', '名称', '库存数量'], rows: [{ '物料码': 'A-1', '名称': '螺丝刀', '库存数量': 5 }] },
    tblTXN: { fields: ['流水号', '时间', '操作人', '类型', '物料码', '变动', '余量', '关联单', '原因/备注'], rows: [] }
  };
  const calls = { created: [], updated: [], deleted: [], deny: false, denyOn: opts.denyOn || null };
  // 字段类型定义：type 数字对应飞书字段类型码（1 文本 / 2 数字 / 3 单选 / 5 日期）
  const fieldTypes = opts.fieldTypes || {
    tblMAT: [{ name: '物料码', type: 1 }, { name: '名称', type: 1 }, { name: '库存数量', type: 2 }],
    tblTXN: [
      { name: '流水号', type: 1 }, { name: '时间', type: 5 }, { name: '操作人', type: 1 },
      { name: '类型', type: 1 }, { name: '物料码', type: 1 }, { name: '变动', type: 2 },
      { name: '余量', type: 2 }, { name: '关联单', type: 1 }, { name: '原因/备注', type: 1 }
    ]
  };
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
      // 表结构（dry-run 校验用）
      const fm = url.pathname.match(/\/tables\/([^/]+)\/fields$/);
      if (fm) {
        const ft = fieldTypes[fm[1]];
        if (!ft) return json({ code: 1254005, msg: 'table not found: ' + fm[1] });
        return json({ code: 0, data: { items: ft.map(f => ({
          field_name: f.name, type: f.type, property: f.options ? { options: f.options.map(o => ({ name: o })) } : undefined
        })) } });
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
        if (opts.denyWrite || opts.denyCreate) return json({ code: 99991672, msg: 'Forbidden: no permission to write' });
        const b = JSON.parse(body || '{}');
        for (const r of (b.records || [])) {
          const err = mockTypeCheck(fieldTypes[tableId], r.fields);
          if (err) return json({ code: 1254006, msg: err });
        }
        (b.records || []).forEach(r => { calls.created.push(r.fields); t.rows.push(r.fields); });
        return json({ code: 0, data: { records: (b.records || []).map((_, i) => ({ record_id: 'new_' + i })) } });
      }
      if (action === 'batch_delete') {
        if (opts.denyWrite) return json({ code: 99991672, msg: 'Forbidden: no permission to write' });
        const b = JSON.parse(body || '{}');
        const want = new Set(b.records || []);
        const keep = [];
        t.rows.forEach((r, i) => { if (!want.has('rec_' + i)) keep.push(r); else calls.deleted.push('rec_' + i); });
        t.rows.length = 0; keep.forEach(r => t.rows.push(r));
        return json({ code: 0, data: { records: (b.records || []).map(id => ({ record_id: id, deleted: true })) } });
      }
      if (action === 'batch_update') {
        if (opts.denyWrite) return json({ code: 99991672, msg: 'Forbidden: no permission to write' });
        const b = JSON.parse(body || '{}');
        for (const r of (b.records || [])) {
          const err = mockTypeCheck(fieldTypes[tableId], r.fields);
          if (err) return json({ code: 1254006, msg: err });
        }
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

test('飞书写【重要】流水写入失败时，必须如实报告「库存已改」而不能假装成功', async (t) => {
  // 读得到流水表，但 batch_create 被拒
  const mock = await startMock({ denyCreate: true });
  t.after(() => { mock.server.close(); cleanupEnv(); });
  const lib = loadLib(mock.port);
  const r = await lib.writeStock({ matCode: 'A-1', qty: 3, delta: -2 });
  assert.equal(r.ok, false, '不能返回成功');
  assert.equal(r.warning, 'stock_written_txn_failed');
  assert.match(r.error, /库存已改为 3，但流水写入失败/);
  // 库存确实被改了 —— 这正是必须明确告知的原因
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 3);
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

/* ================= 通用增删改查（8 张表共用） ================= */

/* 这份定义**逐列对齐生产库的真实表结构**（含它的缺口），不是理想结构：
     物料台账没有「模块区」、人员没有「PIN码」、工单记录没有执行/冲销四列；
     库位「类型」是单选[货架|工位|站点]（没有「模块区」「空地」）；
     工单「状态」是单选[未执行|已执行]（没有「部分执行」「已取消」）。
   缺列/缺选项正是「网页端改了飞书没变」的根因，所以必须照着生产来测。 */
const ALL_TABLE_TYPES = {
  tblMAT: [{ name: '物料码', type: 1 }, { name: '名称', type: 1 }, { name: '规格型号', type: 1 }, { name: '闲鱼XY编号', type: 1 }, { name: '当前库位码', type: 1 }, { name: '容器码', type: 1 }, { name: '库存数量', type: 2 }, { name: '安全库存', type: 2 }, { name: '成本', type: 2 }],
  tblLOC: [{ name: '库位码', type: 1 }, { name: '类型', type: 3, options: ['货架', '工位', '站点'] }, { name: '说明', type: 1 }, { name: '授权人员', type: 1 }],
  tblCTN: [{ name: '容器码', type: 1 }, { name: '容器类型', type: 3, options: ['A4四抽收纳盒', '三连格文件盒', '斜口零件盒', '6040周转箱'] }, { name: '规格', type: 1 }, { name: '当前库位码', type: 1 }],
  tblMBR: [{ name: '编号', type: 1 }, { name: '姓名', type: 1 }, { name: '学号', type: 1 }, { name: '部门/SIG', type: 1 }, { name: '职务', type: 3, options: ['负责人', '成员', '本科生'] }, { name: '电话', type: 13 }, { name: '备注', type: 1 }, { name: '标签', type: 1 }],
  tblITM: [{ name: '物品码', type: 1 }, { name: '名称', type: 1 }, { name: '规格型号', type: 1 }, { name: '库位码', type: 1 }],
  tblMAN: [{ name: '手册码', type: 1 }, { name: '名称', type: 1 }, { name: '版本', type: 1 }, { name: '库位码', type: 1 }],
  tblWIP: [{ name: '工单号', type: 1 }, { name: '类型', type: 3, options: ['LL 领料', 'BH 补货', 'JH 拣货', 'TL 退料'] }, { name: '日期', type: 5 }, { name: '明细', type: 1 }, { name: '状态', type: 3, options: ['未执行', '已执行'] }, { name: '执行时间', type: 5 }],
  tblTXN: [{ name: '流水号', type: 1 }, { name: '时间', type: 5 }, { name: '操作人', type: 1 }, { name: '类型', type: 1 }, { name: '物料码', type: 1 }, { name: '变动', type: 2 }, { name: '余量', type: 2 }, { name: '关联单', type: 1 }, { name: '原因/备注', type: 1 }]
};
const ALL_TABLES = JSON.stringify({
  materials: 'tblMAT', locations: 'tblLOC', containers: 'tblCTN', members: 'tblMBR',
  items: 'tblITM', manuals: 'tblMAN', workorders: 'tblWIP', transactions: 'tblTXN'
});

function startAllMock(opts = {}) {
  const tables = {};
  Object.keys(ALL_TABLE_TYPES).forEach(id => { tables[id] = { fields: ALL_TABLE_TYPES[id].map(f => f.name), rows: [] }; });
  return startMock(Object.assign({ tables, fieldTypes: ALL_TABLE_TYPES }, opts));
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
  const r = await lib.upsertRecords('materials', [{ code: 'JG-001', name: '新名', qty: 5 }]);
  assert.equal(r.created, 0);
  assert.equal(r.updated, 1);
  assert.equal(mock.tables.tblMAT.rows.length, 1, '不应产生重复行');
  assert.equal(mock.tables.tblMAT.rows[0]['名称'], '新名');
  assert.equal(mock.tables.tblMAT.rows[0]['库存数量'], 5);
});

test('通用 upsert【关键】表里没有的列被丢弃并回报，而不是整批失败', async (t) => {
  const mock = await startAllMock();
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

test('通用 upsert：补上列之后，执行明细自动开始同步', async (t) => {
  const types = JSON.parse(JSON.stringify(ALL_TABLE_TYPES));
  types.tblWIP.push({ name: '执行数量', type: 1 }, { name: '执行批次', type: 1 }, { name: '冲销记录', type: 1 }, { name: '取消记录', type: 1 });
  const mock = await startAllMock({ fieldTypes: types });
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
  const rm = await lib.upsertRecords('members', [{ code: 'MB-004', name: '卢玉淳', sid: '24220616', dept: '汽车工程学院', role: '本科生', phone: '', group: '天权1楼实验台', pin: '1234' }]);
  assert.equal(rm.created, 1, '人员应能写入：' + JSON.stringify(rm));
  assert.equal(mock.tables.tblMBR.rows[0]['姓名'], '卢玉淳');
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
  const mock = await startAllMock();
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
  const mock = await startAllMock();
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
  const mock = await startAllMock();
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
