'use strict';
/* TASK-06：出库批量放开库位限制（方案 A）
 * 跨库位混拣出库：source.loc 变为可选兼容字段，每件由 containerCode 反查容器现状。
 * 数据安全底线不降：in_stock / SOURCE_MISMATCH / 版本前置 / 50 件上限 / DUPLICATE_IN_BATCH。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/unique-items');
const Scan = require('../lib/item-scan');

function baseState() {
  const state = {
    locations: [
      { code: 'B-01-01-01', status: 'active' },
      { code: 'B-01-01-07', status: 'active' },
      { code: 'B-01-01-08', status: 'active' }
    ],
    containers: [
      { code: 'C-A', loc: 'B-01-01-01', status: 'active', version: 3 },
      { code: 'C-B', loc: 'B-01-01-07', status: 'active', version: 5 },
      { code: 'C-C', loc: 'B-01-01-08', status: 'active', version: 7 }
    ],
    items: [
      { code: 'I-A', status: 'in_stock', container: 'C-A', version: 2 },
      { code: 'I-B', status: 'in_stock', container: 'C-B', version: 2 },
      { code: 'I-C', status: 'in_stock', container: 'C-C', version: 2 },
      { code: 'I-D', status: 'in_stock', container: 'C-C', version: 2 },
      { code: 'I-OUT', status: 'out', container: '', version: 1 },
      { code: 'I-PENDING', status: 'pending', container: '', version: 0 }
    ],
    itemOperations: []
  };
  U.migrate(state);
  return state;
}
const actor = { id: 'op', roles: ['admin', 'operator'] };
const issueBatch = (items, source) => ({ schemaVersion: 1, opId: 'op-t06', kind: 'issueBatch', source: source !== undefined ? source : { loc: 'B-01-01-01' }, items });

/* ── L3 服务端：跨库位出库 ── */

test('T06-S1 跨库位出库：两件在不同库位 → plan 通过，全置 out', () => {
  const state = baseState();
  const plan = U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 },
    { itemCode: 'I-C', containerCode: 'C-C', expectedItemVersion: 2, expectedContainerVersion: 7 }
  ]), actor);
  assert.equal(plan.after.items.length, 2);
  plan.after.items.forEach(r => { assert.equal(r.status, 'out'); assert.equal(r.container, ''); });
});

test('T06-S2 跨库位出库：三件三个库位 → plan 通过', () => {
  const state = baseState();
  const plan = U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 },
    { itemCode: 'I-B', containerCode: 'C-B', expectedItemVersion: 2, expectedContainerVersion: 5 },
    { itemCode: 'I-C', containerCode: 'C-C', expectedItemVersion: 2, expectedContainerVersion: 7 }
  ]), actor);
  assert.equal(plan.after.items.length, 3);
  plan.after.items.forEach(r => { assert.equal(r.status, 'out'); assert.equal(r.container, ''); });
});

test('T06-S3 source.loc 缺省（旧客户端/空锚点）：source 为 {} → 兼容通过', () => {
  const state = baseState();
  const plan = U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 },
    { itemCode: 'I-B', containerCode: 'C-B', expectedItemVersion: 2, expectedContainerVersion: 5 }
  ], {}), actor);
  assert.equal(plan.after.items.length, 2);
  plan.after.items.forEach(r => { assert.equal(r.status, 'out'); });
});

test('T06-S4 source.loc 缺省：source 为 null → 兼容通过', () => {
  const state = baseState();
  const plan = U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 }
  ], null), actor);
  assert.equal(plan.after.items.length, 1);
  assert.equal(plan.after.items[0].status, 'out');
});

test('T06-S5 容器归属不符 → 仍 SOURCE_MISMATCH（数据安全底线）', () => {
  const state = baseState();
  // I-A 的实际容器是 C-A，声明 C-C
  assert.throws(() => U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-C', expectedItemVersion: 2, expectedContainerVersion: 7 }
  ]), actor), /SOURCE_MISMATCH/);
});

test('T06-S6 物品不在库 → INVALID_TRANSITION', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, issueBatch([
    { itemCode: 'I-OUT', containerCode: 'C-A', expectedItemVersion: 1, expectedContainerVersion: 3 }
  ]), actor), /INVALID_TRANSITION/);
});

test('T06-S7 物品版本不符 → VERSION_CONFLICT', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 99, expectedContainerVersion: 3 }
  ]), actor), /VERSION_CONFLICT/);
});

test('T06-S8 容器版本不符 → VERSION_CONFLICT', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 99 }
  ]), actor), /VERSION_CONFLICT/);
});

test('T06-S9 重复件 → DUPLICATE_IN_BATCH', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 },
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 }
  ]), actor), /DUPLICATE_IN_BATCH/);
});

test('T06-S10 超 50 件 → BATCH_TOO_LARGE', () => {
  const state = baseState();
  const many = Array.from({ length: 51 }, (_, i) => ({ itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 }));
  assert.throws(() => U.plan(state, issueBatch(many), actor), /BATCH_TOO_LARGE/);
});

test('T06-S11 容器未启用 → INACTIVE_ENTITY（安全底线）', () => {
  const state = baseState();
  state.containers.find(c => c.code === 'C-A').status = 'disabled';
  assert.throws(() => U.plan(state, issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 }
  ]), actor), /未核实启用或已停用/);
});

test('T06-S12 plan 纯函数：跨库位出库失败时原 state 不被污染', () => {
  const state = baseState();
  try {
    U.plan(state, issueBatch([
      { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 },
      { itemCode: 'I-B', containerCode: 'C-B', expectedItemVersion: 99, expectedContainerVersion: 5 }
    ]), actor);
  } catch (e) { /* 预期 VERSION_CONFLICT */ }
  assert.equal(state.items.find(x => x.code === 'I-A').status, 'in_stock', 'plan 纯函数');
  assert.equal(state.items.find(x => x.code === 'I-B').status, 'in_stock', 'plan 纯函数');
});

/* ── 入库回归：锚点校验不受影响 ── */

test('T06-R1 入库批量：缺 target.loc → 仍 MISSING_RELATION', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, { schemaVersion: 1, opId: 'op-r', kind: 'receiveBatch', target: {}, items: [
    { itemCode: 'I-PENDING', containerCode: 'C-A', expectedItemVersion: 0, expectedContainerVersion: 3 }
  ] }, actor), /MISSING_RELATION/);
});

test('T06-R2 入库批量：正常锚点入库仍通过（回归）', () => {
  const state = baseState();
  const plan = U.plan(state, { schemaVersion: 1, opId: 'op-r2', kind: 'receiveBatch', target: { loc: 'B-01-01-01' }, items: [
    { itemCode: 'I-PENDING', containerCode: 'C-A', expectedItemVersion: 0, expectedContainerVersion: 3 }
  ] }, actor);
  assert.equal(plan.after.items[0].status, 'in_stock');
  assert.equal(plan.after.items[0].container, 'C-A');
});

/* ── 单件 issue 回归 ── */

test('T06-R3 单件 issue：不受影响（回归）', () => {
  const state = baseState();
  const plan = U.plan(state, {
    schemaVersion: 1, opId: 'op-single', kind: 'issue', itemCode: 'I-A',
    source: { loc: 'B-01-01-01', container: 'C-A' },
    expected: { itemVersion: 2, containerVersion: 3 }
  }, actor);
  assert.equal(plan.after.items[0].status, 'out');
});

test('T06-R4 单件 issue：容器不符仍 SOURCE_MISMATCH（回归）', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, {
    schemaVersion: 1, opId: 'op-single-bad', kind: 'issue', itemCode: 'I-A',
    source: { loc: 'B-01-01-08', container: 'C-C' },
    expected: { itemVersion: 2, containerVersion: 7 }
  }, actor), /SOURCE_MISMATCH/);
});

/* ── L1/L2 客户端扫码：跨库位件可入批 ── */

function mkScanState() {
  return {
    locations: [
      { code: 'L-1', status: 'active' },
      { code: 'L-2', status: 'active' }
    ],
    containers: [
      { code: 'C-1', loc: 'L-1', status: 'active', version: 2 },
      { code: 'C-2', loc: 'L-2', status: 'active', version: 3 }
    ],
    items: [
      { code: 'I-1', status: 'in_stock', container: 'C-1', version: 1 },
      { code: 'I-2', status: 'in_stock', container: 'C-2', version: 1 },
      { code: 'I-3', status: 'in_stock', container: 'C-2', version: 1 },
      { code: 'I-4', status: 'out', container: '', version: 1 }
    ]
  };
}
let scanIdCounter = 0;
function mkScan(state) { return Scan.create({ getState: () => state, id: () => 't' + (++scanIdCounter) }); }

test('T06-C1 出库批量：跨库位两件均可入批（不再拦「不在本批库位」）', () => {
  const s = mkScan(mkScanState());
  s.startBatch('issue');
  const snap = s.snapshot(); snap.batch.targetQty = 3; s.restore(snap);
  const r1 = s.acceptBatchCode({ type: 'ITM', code: 'I-1' });
  assert.match(r1.text, /已入批（第 1 件）/, '首件入批且提示第 1 件');
  const r2 = s.acceptBatchCode({ type: 'ITM', code: 'I-2' });
  assert.match(r2.text, /已入批（第 2 件）/, '异库位第二件也入批且提示第 2 件');
  /* 强断言：第二件**真的进了批**（不只是「没报错」） */
  const rows = s.snapshot().rows.filter(r => r.values.some(v => v.type === 'ITM'));
  assert.equal(rows.length, 2, '清单里应有 2 行带 ITM 的行');
  assert.deepEqual(rows.map(r => r.values.find(v => v.type === 'ITM').code).sort(), ['I-1', 'I-2'], '两件都在清单里');
});

test('T06-C2 出库批量：首件提示不再宣称「须同库位」', () => {
  const s = mkScan(mkScanState());
  s.startBatch('issue');
  const snap = s.snapshot(); snap.batch.targetQty = 3; s.restore(snap);
  const r1 = s.acceptBatchCode({ type: 'ITM', code: 'I-1' });
  assert.ok(!r1.text.includes('须同库位'), '不应再宣称「本批后续件须同库位」');
  assert.ok(r1.text.includes('出库不限库位'), '提示应说明出库不限库位');
});

test('T06-C3 出库批量：重复件仍忽略', () => {
  const s = mkScan(mkScanState());
  s.startBatch('issue');
  const snap = s.snapshot(); snap.batch.targetQty = 3; s.restore(snap);
  s.acceptBatchCode({ type: 'ITM', code: 'I-1' });
  assert.equal(s.acceptBatchCode({ type: 'ITM', code: 'I-1' }).duplicate, true, '重复件仍忽略');
});

test('T06-C4 出库批量：不在库仍拒绝（数据安全底线）', () => {
  const s = mkScan(mkScanState());
  s.startBatch('issue');
  const snap = s.snapshot(); snap.batch.targetQty = 3; s.restore(snap);
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-4' }), /不在库/);
});

test('T06-C5 出库批量：50 件上限仍生效', () => {
  const s = mkScan(mkScanState());
  s.startBatch('issue');
  const snap = s.snapshot(); snap.batch.targetQty = 50; s.restore(snap);
  // 逐件扫描 50 件（借用循环生成不重复物品码）
  const st = mkScanState();
  for (let i = 0; i < 50; i++) {
    const code = 'I-BULK-' + i;
    st.items.push({ code, status: 'in_stock', container: 'C-1', version: 1 });
  }
  const s2 = mkScan(st);
  s2.startBatch('issue');
  const snap2 = s2.snapshot(); snap2.batch.targetQty = 51; s2.restore(snap2);
  for (let i = 0; i < 50; i++) {
    s2.acceptBatchCode({ type: 'ITM', code: 'I-BULK-' + i });
  }
  assert.throws(() => s2.acceptBatchCode({ type: 'ITM', code: 'I-1' }), /已满 50/);
});

/* ===== TASK-06R 审查补漏：负向 + 决策固化用例 ===== */

test('T06-N1 容器不存在/不符 → 仍被拒且带 @件码 后缀（负向）', () => {
  /* 物品现存容器与声明不符时，SOURCE_MISMATCH 先于「容器不存在」触发（校验顺序：
     item.container === e.containerCode 在前，反查容器在后）——两者都是拒绝，且都带件码。 */
  const req = { schemaVersion: 1, opId: 'op-n1', kind: 'issueBatch',
    items: [{ itemCode: 'I-A', containerCode: 'C-NOPE', expectedItemVersion: 2, expectedContainerVersion: 1 }] };
  assert.throws(() => U.plan(baseState(), req, actor), /@ I-A/);
});

test('T06-N2 显式传入与容器实际库位不一致的 source.loc → 仍通过（锚点降级为信息字段）', () => {
  /* 固化 TASK-06 决策：服务端**不再**用 source.loc 逐件比对，防止后人凭直觉加回校验。
     I-A 实际在 C-A(B-01-01-01)，却把 source.loc 传成 B-01-01-08。 */
  const p = U.plan(baseState(), issueBatch(
    [{ itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 }],
    { loc: 'B-01-01-08' }), actor);
  assert.equal(p.after.items[0].code, 'I-A');
  assert.equal(p.after.items[0].status, 'out');
});

test('T06-N3 容器所在库位 retired 仍可出库（固化「出库不校验源库位」这一有意放宽）', () => {
  /* 把东西从已停用的架子上取出来不该被拦死——这是 TASK-06 的特性，不是缺陷 */
  const st = baseState();
  st.locations.push({ code: 'L-RETIRED', status: 'retired' });
  st.containers.push({ code: 'C-R', loc: 'L-RETIRED', status: 'active', version: 7, lastOpId: 'o' });
  st.items.push({ code: 'I-R', container: 'C-R', status: 'in_stock', version: 1, lastOpId: 'o' });
  const req = { schemaVersion: 1, opId: 'op-n3', kind: 'issueBatch',
    items: [{ itemCode: 'I-R', containerCode: 'C-R', expectedItemVersion: 1, expectedContainerVersion: 7 }] };
  const p = U.plan(st, req, actor);
  assert.equal(p.after.items[0].status, 'out');
});

test('T06-N4 审计补位：出库 before 记录源库位，事后可答「这批动了哪些库位」', () => {
  /* TASK-06R 建议②：跨库位混拣后，容器还会被移库，必须在 before 留下当时库位 */
  const p = U.plan(baseState(), issueBatch([
    { itemCode: 'I-A', containerCode: 'C-A', expectedItemVersion: 2, expectedContainerVersion: 3 },
    { itemCode: 'I-B', containerCode: 'C-B', expectedItemVersion: 2, expectedContainerVersion: 5 }
  ]), actor);
  const locs = (p.before.items || []).map(r => r.loc).filter(Boolean);
  assert.deepEqual(locs.sort(), ['B-01-01-01', 'B-01-01-07'], 'before 须逐件记录源库位');
  /* after 不得写入 loc（不参与判定，只是历史线索） */
  assert.equal((p.after.items || []).some(r => r.loc), false, 'after 不应带 loc');
});
