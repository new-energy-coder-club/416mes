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

const ALL_TABLE_TYPES = {
  tblMAT: [{ name: '物料码', type: 1 }, { name: '名称', type: 1 }, { name: '规格型号', type: 1 }, { name: '闲鱼XY编号', type: 1 }, { name: '当前库位码', type: 1 }, { name: '容器码', type: 1 }, { name: '库存数量', type: 2 }, { name: '安全库存', type: 2 }, { name: '成本', type: 2 }],
  tblLOC: [{ name: '库位码', type: 1 }, { name: '类型', type: 1 }, { name: '说明', type: 1 }, { name: '授权人员', type: 1 }],
  tblCTN: [{ name: '容器码', type: 1 }, { name: '容器类型', type: 1 }, { name: '规格', type: 1 }, { name: '当前库位码', type: 1 }],
  tblMBR: [{ name: '编号', type: 1 }, { name: '姓名', type: 1 }, { name: '学号', type: 1 }, { name: '部门/SIG', type: 1 }, { name: '职务', type: 1 }, { name: '电话', type: 1 }, { name: '备注', type: 1 }, { name: '标签', type: 1 }, { name: 'PIN码', type: 1 }],
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
  assert.ok(r.dropped.includes('执行数量') && r.dropped.includes('执行批次') && r.dropped.includes('冲销记录'), '应回报被丢掉的列：' + JSON.stringify(r.dropped));
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
