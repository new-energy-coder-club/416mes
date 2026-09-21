'use strict';
/* 2.77.0 批量收发（Phase 1）：协议与服务端批量分支的测试
 * 用例来源：k3 研究探针 13 项转正（L2 同容器 / L1 同库位 / 全有或全无 / 互斥键集 / 上限 / 重复件）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/unique-items');

function baseState() {
  const state = {
    locations: [{ code: 'L-1', status: 'active' }],
    containers: [
      { code: 'C-1', loc: 'L-1', status: 'active', version: 3 },
      { code: 'C-2', loc: 'L-1', status: 'active', version: 5 }
    ],
    items: [
      { code: 'I-1', status: 'pending', container: '', version: 0 },
      { code: 'I-2', status: 'pending', container: '', version: 0 },
      { code: 'I-3', status: 'pending', container: '', version: 0 },
      { code: 'I-4', status: 'in_stock', container: 'C-1', version: 2 },
      { code: 'I-5', status: 'in_stock', container: 'C-2', version: 2 },
      { code: 'I-6', status: 'in_stock', container: 'C-1', version: 2 }
    ],
    itemOperations: []
  };
  U.migrate(state);
  return state;
}
const actor = { id: 'op', roles: ['admin', 'operator'] };
const recvBatch = items => ({ schemaVersion: 1, opId: 'op-batch', kind: 'receiveBatch', target: { loc: 'L-1' }, items });
const issueBatch = items => ({ schemaVersion: 1, opId: 'op-batch', kind: 'issueBatch', source: { loc: 'L-1' }, items });

test('B1 L2 同容器批量入库：3 件 push 累加，after.items 3 行、各版本 +1', () => {
  const state = baseState();
  const plan = U.plan(state, recvBatch([
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-2', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-3', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 }
  ]), actor);
  assert.equal(plan.after.items.length, 3);
  plan.after.items.forEach(r => { assert.equal(r.status, 'in_stock'); assert.equal(r.container, 'C-1'); assert.equal(r.version, 1); });
  assert.equal(plan.before.items.length, 3);
});

test('B2 L1 同库位异容器批量入库：各件容器各自正确', () => {
  const state = baseState();
  const plan = U.plan(state, recvBatch([
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-2', containerCode: 'C-2', expectedItemVersion: 0, expectedContainerVersion: 5 }
  ]), actor);
  assert.equal(plan.after.items[0].container, 'C-1');
  assert.equal(plan.after.items[1].container, 'C-2');
});

test('B3 跨架锚点：容器不属于锚点库位 → CONTAINER_LOCATION_MISMATCH 带件码', () => {
  const state = baseState();
  state.containers.push({ code: 'C-X', loc: 'L-OTHER', status: 'active', version: 1 });
  assert.throws(() => U.plan(state, recvBatch([
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-2', containerCode: 'C-X', expectedItemVersion: 0, expectedContainerVersion: 1 }
  ]), actor), /CONTAINER_LOCATION_MISMATCH.*I-2|I-2.*CONTAINER_LOCATION_MISMATCH/);
});

test('B4 全有或全无：第 3 件版本过期 → 全批拒绝且零副作用', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, recvBatch([
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-2', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-3', containerCode: 'C-1', expectedItemVersion: 9, expectedContainerVersion: 3 }
  ]), actor), /VERSION_CONFLICT/);
  assert.equal(state.items.find(x => x.code === 'I-1').status, 'pending', 'plan 是纯函数：原 state 不被污染');
});

test('B5 错误带件码：err.itemCode 定位失败行', () => {
  const state = baseState();
  try {
    U.plan(state, recvBatch([
      { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
      { itemCode: 'I-2', containerCode: 'C-1', expectedItemVersion: 7, expectedContainerVersion: 3 }
    ]), actor);
    assert.fail('should throw');
  } catch (e) { assert.equal(e.itemCode, 'I-2'); }
});

test('B6 批内重复件 → DUPLICATE_IN_BATCH', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, recvBatch([
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 }
  ]), actor), /DUPLICATE_IN_BATCH/);
});

test('B7 上限 50 件 → BATCH_TOO_LARGE', () => {
  const state = baseState();
  const many = Array.from({ length: 51 }, (_, i) => ({ itemCode: 'I-' + (i % 6 + 1), containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 }));
  assert.throws(() => U.plan(state, recvBatch(many), actor), /BATCH_TOO_LARGE/);
});

test('B8 批量出库：同库位异容器，状态/归属校验 + 置 out', () => {
  const state = baseState();
  const plan = U.plan(state, issueBatch([
    { itemCode: 'I-4', containerCode: 'C-1', expectedItemVersion: 2, expectedContainerVersion: 3 },
    { itemCode: 'I-5', containerCode: 'C-2', expectedItemVersion: 2, expectedContainerVersion: 5 }
  ]), actor);
  plan.after.items.forEach(r => { assert.equal(r.status, 'out'); assert.equal(r.container, ''); });
});

test('B9 批量出库：声明容器与现状不符 → SOURCE_MISMATCH', () => {
  const state = baseState();
  assert.throws(() => U.plan(state, issueBatch([
    { itemCode: 'I-4', containerCode: 'C-2', expectedItemVersion: 2, expectedContainerVersion: 5 }
  ]), actor), /SOURCE_MISMATCH/);
});

test('B10 entityKeysOf：批量键集 = N×items + M×containers', () => {
  const keys = U.entityKeysOf(recvBatch([
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-2', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-3', containerCode: 'C-2', expectedItemVersion: 0, expectedContainerVersion: 5 }
  ]));
  assert.ok(keys.has('items:I-1') && keys.has('items:I-2') && keys.has('items:I-3'));
  assert.ok(keys.has('containers:C-1') && keys.has('containers:C-2'));
  assert.equal(keys.size, 5, '2 容器 + 3 物品');
  assert.ok(![...keys].some(k => k.startsWith('locations:')), 'LOC 不进收发批量键集');
});

test('B11 键集相交即互斥：两批重叠一件', () => {
  const k1 = U.entityKeysOf(recvBatch([
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 }
  ]));
  const k2 = U.entityKeysOf(recvBatch([
    { itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 },
    { itemCode: 'I-2', containerCode: 'C-2', expectedItemVersion: 0, expectedContainerVersion: 5 }
  ]));
  assert.ok([...k1].some(k => k2.has(k)), '重叠 I-1 → 相交');
});

test('B12 键集不相交可并行：两批完全不同的物品与容器', () => {
  const k1 = U.entityKeysOf(recvBatch([{ itemCode: 'I-1', containerCode: 'C-1', expectedItemVersion: 0, expectedContainerVersion: 3 }]));
  const k2 = U.entityKeysOf(recvBatch([{ itemCode: 'I-2', containerCode: 'C-2', expectedItemVersion: 0, expectedContainerVersion: 5 }]));
  assert.ok(![...k1].some(k => k2.has(k)), '不相交');
});

test('B13 单件 receive 回归：change push 化后形状不变', () => {
  const state = baseState();
  const plan = U.plan(state, { schemaVersion: 1, opId: 'op-1', kind: 'receive', itemCode: 'I-1', target: { loc: 'L-1', container: 'C-1' }, expected: { itemVersion: 0, containerVersion: 3 } }, actor);
  assert.equal(plan.after.items.length, 1);
  assert.equal(plan.after.items[0].status, 'in_stock');
});
