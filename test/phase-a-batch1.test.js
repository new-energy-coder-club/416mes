'use strict';
/* Phase A 第 1 批行为锁：A-9（停容器内置补种）+ A-0（restore 静默跳过已删除 kind）+ A-1（容器「当前库位码」降 OPTIONAL）。
   全部断言真实运行行为：A-9 抽取 index.html 内联 migrateState 在 vm 中执行真实种子逻辑；
   A-0/A-1 直接 require lib 模块。不做字符串存在性断言；每个主题都带负向用例。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const U = require('../lib/unique-items');
const Schema = require('../lib/item-schema');
const Scan = require('../lib/item-scan');

/* ── 源码抽取（花括号配对，字符串/模板串/正则安全；container-loc-model.test.js 同款）── */

function fnSrc(name) {
  const start = HTML.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '找不到函数 ' + name);
  const brace = HTML.indexOf('{', start);
  let depth = 0, quote = '', esc = false, regex = false, cls = false, prev = '';
  for (let i = brace; i < HTML.length; i++) {
    const ch = HTML[i];
    if (regex) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '[') cls = true;
      else if (ch === ']') cls = false;
      else if (ch === '/' && !cls) regex = false;
      continue;
    }
    if (quote) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && '(=,:[!&|?{};\n'.includes(prev)) { regex = true; cls = false; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return HTML.slice(start, i + 1);
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error('函数未闭合 ' + name);
}

/* 抽取顶层 `const NAME = {…};` / `const NAME = […];` 声明（返回到收口括号为止） */
function topDecl(name) {
  const m = HTML.match(new RegExp('const ' + name + ' ='));
  assert.ok(m, '找不到声明 ' + name);
  const start = m.index;
  const obj = HTML.indexOf('{', start), arr = HTML.indexOf('[', start);
  let i, openCh, closeCh;
  if (arr >= 0 && (obj < 0 || arr < obj)) { i = arr; openCh = '['; closeCh = ']'; }
  else { i = obj; openCh = '{'; closeCh = '}'; }
  let depth = 0, quote = '', esc = false, regex = false, cls = false, prev = '';
  for (; i < HTML.length; i++) {
    const ch = HTML[i];
    if (regex) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '[') cls = true;
      else if (ch === ']') cls = false;
      else if (ch === '/' && !cls) regex = false;
      continue;
    }
    if (quote) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && '(=,:[!&|?{};\n'.includes(prev)) { regex = true; cls = false; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh && --depth === 0) return HTML.slice(start, i + 1);
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error('声明未闭合 ' + name);
}

/* ── A-9：在 vm 里跑真实 migrateState（C_LAYOUT/MODULE_ZONES/normalizeOrder/log/UniqueItems.migrate 全真）── */

function migrateHarness(state) {
  const logs = [];
  const ctx = vm.createContext({
    state,
    log: m => logs.push(String(m)),
    window: { UniqueItems: { migrate: st => U.migrate(st) } }
  });
  vm.runInContext([
    topDecl('C_LAYOUT'),
    topDecl('MODULE_ZONES'),
    fnSrc('normalizeOrder'),
    fnSrc('migrateState')
  ].join('\n'), ctx);
  return {
    logs,
    run: expr => vm.runInContext(expr, ctx),
    /* JSON 往返抹平 vm realm 差异，外层才能 deepEqual */
    json: expr => JSON.parse(vm.runInContext('JSON.stringify(' + expr + ')', ctx))
  };
}

const GHOSTS = ['SC4-001', 'SLG-011', 'KF-001'];   // 原内置容器种子的三个代表幽灵码

test('A-9：全新状态 migrateState 后 containers 为空，内置幽灵容器不再补种', () => {
  const h = migrateHarness({});
  const st = h.json('migrateState(state)');
  assert.deepEqual(st.containers, [], '容器补种已停：不得再长出任何内置容器');
  for (const g of GHOSTS) {
    assert.ok(!st.containers.some(c => c.code === g), '幽灵容器 ' + g + ' 不得出现');
  }
});

test('A-9：负向——locations/MODULE_ZONES 补种必须保留（只停容器，不伤库位）', () => {
  const h = migrateHarness({});
  const st = h.json('migrateState(state)');
  const locCodes = st.locations.map(l => l.code);
  assert.ok(locCodes.includes('C-01-01-01'), 'C_LAYOUT 货架库位仍须补种');
  for (let i = 1; i <= 5; i++) assert.ok(locCodes.includes('M-0' + i), '模块区 M-0' + i + ' 仍须补种');
  const h2 = migrateHarness({});
  h2.run('migrateState(state)');
  const declared = h2.json('C_LAYOUT.locations.length + MODULE_ZONES.length');
  assert.equal(st.locations.length, declared, '库位补种数量 = C_LAYOUT.locations + MODULE_ZONES，无多余种子');
});

test('A-9：自有容器在 migrateState 后原样保留（只停补种，不清洗存量）', () => {
  const h = migrateHarness({ containers: [{ code: 'KEEP-01', loc: 'C-01-01-01', status: 'active', version: 3 }] });
  const st = h.json('migrateState(state)');
  assert.equal(st.containers.length, 1, '自有容器不得被误删');
  // U.migrate 会为受控字段补默认 lastOpId: ''（既有行为）
  assert.deepEqual(st.containers[0], { code: 'KEEP-01', loc: 'C-01-01-01', status: 'active', version: 3, lastOpId: '' });
  // 存量幽灵（历史设备残留）也只在人工对齐面板清理，migrateState 不得顺手清库
  const h2 = migrateHarness({ containers: [{ code: 'SLG-011', loc: '', status: 'active', version: 1 }] });
  const st2 = h2.json('migrateState(state)');
  assert.equal(st2.containers.length, 1, '存量幽灵容器由人工清理，代码不得自动清洗');
  assert.equal(st2.containers[0].code, 'SLG-011');
});

test('A-9：migrateState 幂等——重复执行不产生重复库位/模块区', () => {
  const h = migrateHarness({});
  h.run('migrateState(state)');
  const once = h.json('state.locations.length');
  h.run('migrateState(state)');
  h.run('migrateState(state)');
  const thrice = h.json('state.locations.length');
  assert.equal(once, thrice, '多次执行不得重复补种');
  const codes = h.json('state.locations.map(l => l.code)');
  assert.equal(new Set(codes).size, codes.length, '库位码不得重复');
});

test('A-9：C_LAYOUT 声明本身不再携带 containers 成员（种子源头已摘除）', () => {
  const h = migrateHarness({});
  assert.equal(h.run('typeof C_LAYOUT.containers'), 'undefined', 'C_LAYOUT.containers 必须已删除');
  assert.equal(h.run('Array.isArray(C_LAYOUT.locations) && C_LAYOUT.locations.length > 0'), true,
    'locations 数组必须仍完整保留');
});

/* ── A-0：restore 对已删除 kind 的行静默跳过（lib/item-scan.js 真模块）── */

function mkScan(state) {
  let n = 0;
  return Scan.create({
    getState: () => state || { locations: [], containers: [], items: [] },
    id: () => 'pa-' + (++n)
  });
}

test('A-0：restore 混合草稿——合法行保留值，已删除 kind 行被静默丢弃且不抛错', () => {
  const scan = mkScan();
  const draft = {
    sessionId: 'mix', active: 2,
    rows: [
      { rowId: 'r1', kind: 'receive', generation: 1, values: [{ type: 'LOC', code: 'C-01-01-01' }, { type: 'CTN', code: 'CTN-9' }, { type: 'ITM', code: 'ITM-KEEP' }], locked: false, opId: null },
      { rowId: 'r2', kind: 'issueBatch', generation: 3, values: [{ type: 'ITM', code: 'ITM-LOST-A' }], locked: true, opId: 'op-1' },
      { rowId: 'r3', kind: 'ghostKind', generation: 0, values: [{ type: 'ITM', code: 'ITM-LOST-B' }], locked: false, opId: null }
    ]
  };
  assert.doesNotThrow(() => scan.restore(draft), '恢复旧草稿不得报错');
  const snap = scan.snapshot();
  assert.equal(snap.rows.length, 1, '只有合法 kind 的行存活');
  assert.equal(snap.rows[0].kind, 'receive');
  const codes = snap.rows[0].values.map(v => v.code);
  assert.deepEqual(codes, ['C-01-01-01', 'CTN-9', 'ITM-KEEP'], '合法行的已扫值必须原样保留');
  const leaked = snap.rows.flatMap(r => r.values.map(v => v.code)).filter(c => /^ITM-LOST/.test(c));
  assert.deepEqual(leaked, [], '被丢弃行的值不得泄漏进任何存活行');
  assert.ok(snap.active >= 0 && snap.active < snap.rows.length, '活动行索引必须钳位到合法范围');
});

test('A-0：restore 全部为已删除 kind——回退单条空白 receive 行，旧值不复活', () => {
  const scan = mkScan();
  assert.doesNotThrow(() => scan.restore({
    sessionId: 'all-dead',
    rows: [
      { rowId: 'r1', kind: 'receiveBatch', generation: 2, values: [{ type: 'ITM', code: 'GHOST-VAL' }], locked: false, opId: null },
      { rowId: 'r2', kind: 'ghostKind', generation: 0, values: [{ type: 'ITM', code: 'GHOST-VAL-2' }], locked: false, opId: null }
    ]
  }));
  const snap = scan.snapshot();
  assert.equal(snap.rows.length, 1, '全部行被丢弃时回退为单条 receive 空行');
  assert.equal(snap.rows[0].kind, 'receive');
  assert.deepEqual(snap.rows[0].values, [], '回退行必须为空白，不得携带旧值');
  assert.equal(snap.rows[0].locked, false, '回退行不得带锁');
  assert.equal(snap.rows[0].opId, null, '回退行不得携带旧操作ID');
});

test('A-0：负向——restore 的静默跳过只针对未知 kind，合法 kind 行必须存活', () => {
  const scan = mkScan();
  scan.restore({
    sessionId: 'live',
    rows: [
      { rowId: 'r1', kind: 'issue', generation: 0, values: [{ type: 'ITM', code: 'ITM-OUT' }], locked: false, opId: null },
      { rowId: 'r2', kind: 'ghostKind', generation: 0, values: [{ type: 'ITM', code: 'X' }], locked: false, opId: null }
    ]
  });
  const snap = scan.snapshot();
  assert.deepEqual(snap.rows.map(r => r.kind), ['issue'], '合法行不得被过滤误伤');
  assert.deepEqual(snap.rows[0].values.map(v => v.code), ['ITM-OUT']);
});

/* ── A-1：容器「当前库位码」REQUIRED → OPTIONAL（lib/item-schema.js 真模块）── */

const TABLE_IDS = { items: 'tbl_items', containers: 'tbl_containers', locations: 'tbl_locations', itemOperations: 'tbl_ops' };

/* 从 REQUIREMENTS 动态构建一份「字段全齐」的合法 schema 夹具 */
function fullSchemas() {
  const schemas = {};
  for (const [table, fields] of Object.entries(Schema.REQUIREMENTS)) {
    schemas[table] = Object.entries(fields).map(([name, spec]) => {
      const arr = Array.isArray(spec) ? spec : [spec];
      const type = Array.isArray(arr[0]) ? arr[0][0] : arr[0];
      const f = { name, type };
      if (arr[1]) f.options = arr[1];
      return f;
    });
  }
  return schemas;
}

test('A-1：容器缺「当前库位码」列 → 仅警告不阻断（schemaValid 仍为 true）', () => {
  const base = Schema.validate(fullSchemas(), TABLE_IDS);
  assert.equal(base.schemaValid, true, '夹具自检：全字段齐备时必须全绿');
  assert.deepEqual(base.warnings, [], '夹具自检：全字段齐备时不得有警告');
  assert.equal(base.writeEnabled, false);

  const schemas = fullSchemas();
  schemas.containers = schemas.containers.filter(f => f.name !== '当前库位码');
  const r = Schema.validate(schemas, TABLE_IDS);
  assert.equal(r.schemaValid, true, '缺「当前库位码」不得再阻断写入');
  assert.deepEqual(r.problems, [], 'problems 必须为空');
  assert.ok(r.warnings.some(w => w.table === 'containers' && w.name === '当前库位码' && w.reason === 'missing-column' && w.optional === true),
    'warnings 必须以 optional 缺列告警');
});

test('A-1：负向——容器码仍是 REQUIRED，缺列必须阻断', () => {
  const schemas = fullSchemas();
  schemas.containers = schemas.containers.filter(f => f.name !== '容器码');
  const r = Schema.validate(schemas, TABLE_IDS);
  assert.equal(r.schemaValid, false, '容器码缺列必须 fail-closed');
  assert.ok(r.problems.some(p => p.table === 'containers' && p.name === '容器码' && p.reason === 'missing-column'),
    'problems 必须含容器码缺列');
});

test('A-1：「当前库位码」类型不符 → 降为警告不再阻断', () => {
  const schemas = fullSchemas();
  schemas.containers.find(f => f.name === '当前库位码').type = 2;   // 数字类型，应为 1 文本
  const r = Schema.validate(schemas, TABLE_IDS);
  assert.equal(r.schemaValid, true, '类型不符只警告');
  assert.ok(r.warnings.some(w => w.table === 'containers' && w.name === '当前库位码' && w.reason === 'wrong-type' && w.optional === true),
    'warnings 必须含 wrong-type 且标记 optional');
  assert.deepEqual(r.problems, []);
});
