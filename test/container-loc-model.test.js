'use strict';
/* 容器库位模型重构 P0+P1 · 定向回归（复核者补写，只新增本文件、不改产品代码）
 *
 * 六组行为锁定（全部断言真实行为，非字符串存在性）：
 *   1. currentPosition（lib/unique-items.js 域层只读定位）：
 *      it.loc 直读优先 / 旧容器链不变 / 非在库 historicalLoc / 脏数据优先级 / 旧守卫不回归
 *   2. 单件出库扫码来源解析（lib/item-scan.js issue 分支 :65-79）
 *   3. 批量出库锚点派生（lib/item-scan.js acceptBatchCode issue 分支 :134-168）
 *   4. 页面只读展示（index.html 内联 opSnapshotPos / scanItem，按源码抽取 + vm 执行）
 *   5. P0 契约：TABLE_DEFS.locations 新列映射 + ordinaryFields 白名单
 *      （role 进普通路径；parentContainer 是 P2 系统落笔字段，普通路径不可写）
 *   6. P1 边界锁（P2 已放开/翻转）：命令层对 it.loc 物品的真实行为——
 *      CLM-6.1–6.5 锁定旧形状拒绝不回归；CLM-6.6 翻转为正向锚点：
 *      容器入库显式清遗留 loc，定位不再被劫持（dev-docs/容器库位模型重构研究.md §六-1）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const U = require('../lib/unique-items');
const Scan = require('../lib/item-scan');
const FA = require('../lib/feishu-api');

const actor = { id: 'op', roles: ['admin', 'operator'] };

function baseState() {
  const state = {
    locations: [
      { code: 'SUB-1', status: 'active' },
      { code: 'L-A', status: 'active' },
      { code: 'L-OLD', status: 'active' }
    ],
    containers: [
      { code: 'C-A', loc: 'L-A', status: 'active', version: 2 },
      { code: 'C-NX', loc: '', status: 'active', version: 1 }
    ],
    items: [
      { code: 'I-SUB', status: 'in_stock', loc: 'SUB-1', container: '', version: 4 },
      { code: 'I-SUB-OUT', status: 'out', loc: 'SUB-1', container: '', version: 5 },
      { code: 'I-GHOST', status: 'in_stock', loc: 'SUB-404', container: '', version: 1 },
      { code: 'I-NONE', status: 'in_stock', loc: '', container: '', version: 1 },
      { code: 'I-DIRTY', status: 'in_stock', loc: 'SUB-1', container: 'C-A', version: 6 },
      { code: 'I-CTN', status: 'in_stock', container: 'C-A', version: 3 },
      { code: 'I-CTN-NX', status: 'in_stock', container: 'C-NX', version: 1 },
      { code: 'I-ORPHAN', status: 'in_stock', container: '', version: 1 },
      { code: 'I-UNKNOWN', status: 'unknown', loc: 'L-OLD', container: '', version: 1 },
      { code: 'I-STALE', status: 'pending', loc: 'L-OLD', container: '', version: 0 }
    ],
    itemOperations: []
  };
  U.migrate(state);
  return state;
}

/* ── 1. currentPosition：域层只读定位 ── */

test('CLM-1.1 在库 + it.loc 非空 → 直读库位，container=null，historicalLoc 清空', () => {
  const pos = U.currentPosition(baseState(), 'I-SUB');
  assert.equal(pos.location.code, 'SUB-1');
  assert.equal(pos.container, null);
  assert.equal(pos.historicalLoc, '');
  assert.equal(pos.legacy, false);
  assert.equal(pos.item.code, 'I-SUB');
});

test('CLM-1.2 迁移期兼容锁：在库 + it.loc 空 + 容器行仍带旧 loc → currentPosition 从 containers.loc 派生链可读（Phase D 删容器行 loc 时改写）', () => {
  /* v3.13.32（A-7）原「旧容器链行为不变（回归）」锁翻转为迁移期兼容锁：
     冻结体迁移期，存量物品（it.loc 空、container 指向的容器行仍带旧 containers.loc）
     的只读定位继续从 containers.loc 派生（unique-items.js currentPosition 容器链），
     保证存量数据在 Phase D 移除容器行 loc 之前不丢位置信息。 */
  const pos = U.currentPosition(baseState(), 'I-CTN');
  assert.equal(pos.location.code, 'L-A');
  assert.equal(pos.container.code, 'C-A');
  assert.equal(pos.historicalLoc, '');
  assert.equal(pos.legacy, false);
});

test('CLM-1.3 非在库（out/unknown）→ 旧行为：historicalLoc = it.loc，位置为空', () => {
  const outPos = U.currentPosition(baseState(), 'I-SUB-OUT');
  assert.equal(outPos.location, null);
  assert.equal(outPos.container, null);
  assert.equal(outPos.historicalLoc, 'SUB-1');
  assert.equal(outPos.legacy, false);
  const unkPos = U.currentPosition(baseState(), 'I-UNKNOWN');
  assert.equal(unkPos.location, null);
  assert.equal(unkPos.historicalLoc, 'L-OLD');
  assert.equal(unkPos.legacy, true, '只有 unknown 才标 legacy');
});

test('CLM-1.4 脏数据（it.loc 与容器同时非空）→ it.loc 优先（互斥校验 P2 落，先锁读取优先级）', () => {
  const pos = U.currentPosition(baseState(), 'I-DIRTY');
  assert.equal(pos.location.code, 'SUB-1', 'it.loc 优先于容器链');
  assert.equal(pos.container, null);
});

test('CLM-1.5 在库但无 loc 无容器 → 仍 INVALID_IN_STOCK_RELATION（旧守卫不回归）', () => {
  assert.throws(() => U.currentPosition(baseState(), 'I-ORPHAN'), /INVALID_IN_STOCK_RELATION/);
});

/* ── 2. 单件出库扫码：来源解析（item-scan issue 分支）── */

let scanSeq = 0;
const mkScan = st => Scan.create({ getState: () => st, id: () => 't' + (++scanSeq) });

test('CLM-2.1 it.loc 物品扫码：来源校验只查库位，不要求容器 → accept 通过', () => {
  const s = mkScan(baseState());
  s.add('issue');
  assert.deepEqual(s.accept('ITM:I-SUB'), { complete: true });
});

test('CLM-2.2 it.loc 指向不存在的库位 → NOT_FOUND（格式合法但缺失的码，非 INVALID_CODE）', () => {
  const s = mkScan(baseState());
  s.add('issue');
  assert.throws(() => s.accept('ITM:I-GHOST'), e => {
    assert.equal(e.code, 'NOT_FOUND');
    assert.match(e.message, /locations: SUB-404/);
    return true;
  });
});

test('CLM-2.3 无 it.loc 且无容器 → 物品档案缺少容器归属', () => {
  const s = mkScan(baseState());
  s.add('issue');
  assert.throws(() => s.accept('ITM:I-NONE'), /物品档案缺少容器归属/);
});

test('CLM-2.4 非在库的 it.loc 物品 → 状态门先于 loc 校验拦截', () => {
  const s = mkScan(baseState());
  s.add('issue');
  assert.throws(() => s.accept('ITM:I-SUB-OUT'), /物品当前不在库，不能出库/);
});

test('CLM-2.5 P2 扩展 source 后放开：子位直存物品 request() 产出 sub=true 出库请求', () => {
  const s = mkScan(baseState());
  s.add('issue');
  assert.deepEqual(s.accept('ITM:I-SUB'), { complete: true });
  /* P2（C3）：item-scan request() 的 issue 子位分支——子位无容器版本可派，
     source={loc,container:'',sub:true}（鉴别器仅显式 sub===true），expected 只带 itemVersion。 */
  const { opId, ...rest } = s.request();
  assert.equal(typeof opId, 'string');
  assert.ok(opId.length > 0, 'opId 应已派生');
  assert.deepEqual(rest, {
    schemaVersion: 1, kind: 'issue', itemCode: 'I-SUB',
    source: { loc: 'SUB-1', container: '', sub: true },
    expected: { itemVersion: 4 }
  });
});

/* ── 3. 批量出库锚点派生（acceptBatchCode issue 分支）── */

test('CLM-3.1 it.loc 首件 → 锚点直读 it.loc：{loc:SUB-1, ctn:null, sub:true}', () => {
  const s = mkScan(baseState());
  s.startBatch('issue');
  const r = s.acceptBatchCode({ type: 'ITM', code: 'I-SUB' });
  assert.equal(r.stage, 'anchor');
  /* P3：首件派生锚点带 sub 展示标记（item-scan acceptBatchCode issue 分支） */
  assert.deepEqual(s.batchState().anchor, { loc: 'SUB-1', ctn: null, sub: true });
  assert.match(r.text, /首件库位 SUB-1/);
});

test('CLM-3.2 it.loc 空 + 容器未定位 → 「尚未定位」人话报错', () => {
  const s = mkScan(baseState());
  s.startBatch('issue');
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-CTN-NX' }), /物品所在容器 C-NX 尚未定位/);
});

test('CLM-3.3 迁移期兼容锁：it.loc 空 + 容器行仍带旧 loc → 批量锚点 {loc:容器.库位, ctn:null, sub:false} 派生可读（Phase D 删容器行 loc 时改写）', () => {
  /* v3.13.32（A-7）原回归锁翻转为迁移期兼容锁：冻结体迁移期，批量出库锚点对
     存量物品继续从容器行的旧 containers.loc 派生（item-scan acceptBatchCode issue
     分支），Phase D 移除容器行 loc 前存量批量作业不得失去锚点。 */
  const s = mkScan(baseState());
  s.startBatch('issue');
  const r = s.acceptBatchCode({ type: 'ITM', code: 'I-CTN' });
  assert.equal(r.stage, 'anchor');
  /* P3：容器链首件锚点同样带 sub:false（容器路径，形状统一） */
  assert.deepEqual(s.batchState().anchor, { loc: 'L-A', ctn: null, sub: false });
});

test('CLM-3.4 it.loc 指向不存在库位 → 批量同样 NOT_FOUND', () => {
  const s = mkScan(baseState());
  s.startBatch('issue');
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-GHOST' }), e => {
    assert.equal(e.code, 'NOT_FOUND');
    assert.match(e.message, /locations: SUB-404/);
    return true;
  });
});

test('CLM-3.5 无 it.loc 且无容器 → 批量同样报缺少容器归属', () => {
  const s = mkScan(baseState());
  s.startBatch('issue');
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-NONE' }), /物品档案缺少容器归属/);
});

/* ── 4. 页面只读展示（index.html 内联函数：源码抽取 + vm）── */

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/* 花括号配对抽取顶层函数（itemized-ui-helper.cjs 同款：字符串/模板串/正则安全） */
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

const STATUS_CONST = (HTML.match(/const ITEM_STATUS_ZH = \{[^\n]*\};/) || [])[0];
assert.ok(STATUS_CONST && STATUS_CONST.includes('in_stock'), 'ITEM_STATUS_ZH 抽取失败');

/* 搭一个跑真实页面代码的 vm 现场；返回跨 realm 安全读值工具 */
function pageCtx(state) {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML('<div id="box" class="scan-result"></div>');
  const calls = { logs: [], scans: [] };
  const ctx = vm.createContext({
    document,
    state,
    addScan: function () { calls.scans.push(Array.from(arguments)); },
    log: function (m) { calls.logs.push(String(m)); }
  });
  vm.runInContext([
    STATUS_CONST,
    fnSrc('esc'), fnSrc('scanStatus'), fnSrc('renderScanCard'), fnSrc('itemStatusToText'),
    fnSrc('opSnapshotPos'), fnSrc('opPosText'), fnSrc('scanItem')
  ].join('\n;\n'), ctx);
  return {
    calls,
    run: expr => vm.runInContext(expr, ctx),
    runJson: expr => JSON.parse(vm.runInContext('JSON.stringify(' + expr + ')', ctx))
  };
}

test('CLM-4.1 opSnapshotPos：直存件快照 → loc=it.loc、snapLoc 命中库位行', () => {
  const p = pageCtx(baseState());
  const pos = p.runJson(`opSnapshotPos({
    items: [{ code: 'I-SUB', loc: 'SUB-1', container: '', status: 'in_stock' }],
    containers: [], locations: [{ code: 'SUB-1' }]
  }, 'I-SUB')`);
  assert.deepEqual(pos, { container: '', loc: 'SUB-1', status: 'in_stock', snapLoc: 'SUB-1' });
});

test('CLM-4.2 opSnapshotPos：旧容器链快照 → 容器 → 容器.库位（行为不变）', () => {
  const p = pageCtx(baseState());
  const pos = p.runJson(`opSnapshotPos({
    items: [{ code: 'I-CTN', container: 'C-A', status: 'in_stock' }],
    containers: [{ code: 'C-A', loc: 'L-A' }], locations: [{ code: 'L-A' }]
  }, 'I-CTN')`);
  assert.deepEqual(pos, { container: 'C-A', loc: 'L-A', status: 'in_stock', snapLoc: 'L-A' });
});

test('CLM-4.3 opSnapshotPos：脏快照 it.loc 优先；缺快照/缺物品 → null', () => {
  const p = pageCtx(baseState());
  const dirty = p.runJson(`opSnapshotPos({
    items: [{ code: 'I-DIRTY', loc: 'SUB-1', container: 'C-A', status: 'in_stock' }],
    containers: [{ code: 'C-A', loc: 'L-A' }], locations: [{ code: 'SUB-1' }, { code: 'L-A' }]
  }, 'I-DIRTY')`);
  assert.equal(dirty.loc, 'SUB-1', '与域层同优先级：it.loc 胜出');
  assert.equal(dirty.snapLoc, 'SUB-1');
  assert.equal(p.runJson('opSnapshotPos(null, "I-SUB")'), null);
  assert.equal(p.runJson(`opSnapshotPos({ items: [{ code: 'X' }] }, 'I-SUB')`), null);
});

test('CLM-4.4 opPosText：直存件展示「库位 SUB-1」（与 opPosText 消费端联动）', () => {
  const p = pageCtx(baseState());
  const pos = p.runJson(`opSnapshotPos({
    items: [{ code: 'I-SUB', loc: 'SUB-1', container: '', status: 'in_stock' }],
    containers: [], locations: [{ code: 'SUB-1' }]
  }, 'I-SUB')`);
  assert.equal(p.runJson(`opPosText(${JSON.stringify(pos)})`), '库位 SUB-1');
});

test('CLM-4.5 scanItem：直存件（无容器）→ 当前位置显示库位码，不再显示「缺容器归属」', () => {
  const state = baseState();
  state.locations.find(l => l.code === 'SUB-1').desc = '抽屉子位';
  const p = pageCtx(state);
  p.run(`scanItem('I-SUB', document.querySelector('#box'))`);
  const html = p.run(`document.querySelector('#box').innerHTML`);
  assert.ok(html.includes('物品 · 只读查询（不改库存）'), '真实 renderScanCard 链路跑通');
  assert.ok(html.includes('>SUB-1</strong>'), '当前位置读数 = 库位码');
  assert.ok(!html.includes('缺容器归属'), '不得回落到「—（缺容器归属）」');
  assert.ok(html.includes('抽屉子位'), '库位说明随命中库位带出');
  assert.ok(p.calls.logs.some(m => m.includes('位置 SUB-1')), '日志记录库位码');
});

test('CLM-4.6 scanItem：容器件 → 仍显示「C-A → L-A」旧链（回归）', () => {
  const p = pageCtx(baseState());
  p.run(`scanItem('I-CTN', document.querySelector('#box'))`);
  const html = p.run(`document.querySelector('#box').innerHTML`);
  assert.ok(html.includes('C-A → L-A'), '旧容器链展示不变');
});

test('CLM-4.7 scanItem：真孤儿（无 loc 无容器在库）→ 仍显示「—（缺容器归属）」（旧行为保留）', () => {
  const p = pageCtx(baseState());
  p.run(`scanItem('I-ORPHAN', document.querySelector('#box'))`);
  assert.ok(p.run(`document.querySelector('#box').innerHTML`).includes('—（缺容器归属）'));
});

test('CLM-4.8 scanItem：非在库 → 显示状态占位「—（已出库）」', () => {
  const p = pageCtx(baseState());
  p.run(`scanItem('I-SUB-OUT', document.querySelector('#box'))`);
  assert.ok(p.run(`document.querySelector('#box').innerHTML`).includes('—（已出库）'));
});

/* ── 5. P0 契约：新列映射 + ordinaryFields 白名单 ── */

test('CLM-5.1 TABLE_DEFS.locations 新增「库位角色」「所属容器码」映射（插在状态列之前）', () => {
  const fields = FA.TABLE_DEFS.locations.fields;
  assert.deepEqual(fields.find(f => f[0] === 'role'), ['role', '库位角色', FA.KIND.SELECT]);
  assert.deepEqual(fields.find(f => f[0] === 'parentContainer'), ['parentContainer', '所属容器码', FA.KIND.TEXT]);
  assert.equal(fields[fields.length - 1][0], 'status', 'status 仍为末列，同步列序不被打乱');
});

test('CLM-5.2 ordinaryFields(locations)：role 放行；parentContainer 被剥（P2 系统字段不可经普通路径写）', () => {
  const out = U.ordinaryFields('locations', {
    code: 'L-X', kind: '货架', desc: 'd', grants: 'g',
    role: '容器子位', parentContainer: 'C-A', status: 'active', version: 1
  });
  assert.deepEqual(Object.keys(out).sort(), ['code', 'desc', 'grants', 'kind', 'role']);
  assert.equal(out.role, '容器子位');
  assert.equal('parentContainer' in out, false);
  assert.equal('status' in out, false, '受控字段同样不入普通路径');
});

test('CLM-5.3 registerLocation 行为级验证：after 带角色、不带 parentContainer', () => {
  const state = { locations: [], containers: [], items: [], itemOperations: [] };
  U.migrate(state);
  const p = U.plan(state, {
    schemaVersion: 1, opId: 'reg-l1', kind: 'registerLocation',
    entity: { code: 'L-NEW', kind: '货架', desc: '', grants: '', role: '容器子位', parentContainer: 'C-A' }
  }, actor);
  assert.equal(p.after.locations[0].role, '容器子位');
  assert.equal('parentContainer' in p.after.locations[0], false);
});

/* ── 6. P1 边界锁（P2 将放开）：命令层真实行为 ── */

test('CLM-6.1 issue@域层：it.loc 物品声明旧链容器 → SOURCE_MISMATCH（写路径不放行）', () => {
  assert.throws(() => U.plan(baseState(), {
    schemaVersion: 1, opId: 'b1', kind: 'issue', itemCode: 'I-SUB',
    source: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 4, containerVersion: 2 }
  }, actor), e => assert.equal(e.code, 'SOURCE_MISMATCH') || true);
});

test('CLM-6.2 issue@域层：声明 loc=it.loc + 容器在别处 → pair 先拦 CONTAINER_LOCATION_MISMATCH', () => {
  assert.throws(() => U.plan(baseState(), {
    schemaVersion: 1, opId: 'b2', kind: 'issue', itemCode: 'I-SUB',
    source: { loc: 'SUB-1', container: 'C-A' }, expected: { itemVersion: 4, containerVersion: 2 }
  }, actor), /CONTAINER_LOCATION_MISMATCH/);
});

test('CLM-6.3 issue@域层：声明空容器 → INVALID_CODE（容器码校验在前端）', () => {
  assert.throws(() => U.plan(baseState(), {
    schemaVersion: 1, opId: 'b3', kind: 'issue', itemCode: 'I-SUB',
    source: { loc: 'SUB-1', container: '' }, expected: { itemVersion: 4, containerVersion: 0 }
  }, actor), e => assert.equal(e.code, 'INVALID_CODE') || true);
});

test('CLM-6.4 issueBatch@域层：it.loc 物品无论声明什么容器都 SOURCE_MISMATCH 且带 @件码', () => {
  const req = extra => ({
    schemaVersion: 1, opId: 'b4', kind: 'issueBatch', source: {},
    items: [Object.assign({ itemCode: 'I-SUB', expectedItemVersion: 4 }, extra)]
  });
  assert.throws(() => U.plan(baseState(), req({ containerCode: 'C-A', expectedContainerVersion: 2 }), actor),
    e => { assert.equal(e.code, 'SOURCE_MISMATCH'); assert.match(e.message, /@ I-SUB/); return true; });
  assert.throws(() => U.plan(baseState(), req({ containerCode: '', expectedContainerVersion: 0 }), actor), /SOURCE_MISMATCH/);
});

test('CLM-6.5 receive@域层：目标仍是容器↔库位 pair，容器不在目标库位照旧拦（P1 不动 pair）', () => {
  assert.throws(() => U.plan(baseState(), {
    schemaVersion: 1, opId: 'b5', kind: 'receive', itemCode: 'I-STALE',
    target: { loc: 'SUB-1', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 2 }
  }, actor), /CONTAINER_LOCATION_MISMATCH/);
});

test('CLM-6.6 P2 正向锚点：容器入库显式清遗留 loc，双写劫持收敛（原 P1 已知风险锁放开）', () => {
  /* 按 item-repository.apply 的真实合并语义（只写 CONTROLLED 中 after 行携带的字段）落库 */
  function applyAfter(state, plan) {
    for (const [table, rows] of Object.entries(plan.after || {})) {
      for (const row of rows) {
        const target = (state[table] || []).find(r => r.code === row.code);
        assert.ok(target, 'apply 前提：行已存在 ' + row.code);
        for (const k of U.CONTROLLED[table]) if (Object.hasOwn(row, k)) target[k] = row[k];
      }
    }
  }
  const state = baseState();
  const plan = U.plan(state, {
    schemaVersion: 1, opId: 'b6', kind: 'receive', itemCode: 'I-STALE',
    target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 2 }
  }, actor);
  assert.equal(plan.after.items[0].container, 'C-A', '容器入库本身照常通过');
  assert.equal(plan.after.items[0].loc, '', 'P2（A4 容器分支）：显式清空遗留 loc，双写互斥');
  assert.equal(plan.before.items[0].loc, 'L-OLD', 'before 审计携带遗留 loc（受控快照自动携带，CLM-6.6 断言翻转）');
  applyAfter(state, plan);
  assert.equal(state.items.find(r => r.code === 'I-STALE').loc, '', '遗留 loc 被显式清除，不再存活');
  const pos = U.currentPosition(state, 'I-STALE');
  assert.equal(pos.location.code, 'L-A', '定位走容器链：显示容器所在库位，不再被 L-OLD 劫持');
  assert.equal(pos.container.code, 'C-A', '容器链正常带出');
});
