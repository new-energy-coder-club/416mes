/**
 * mes-core 单元测试 — 覆盖 416MES分阶段开发计划.md Phase 1 要求的全部场景
 *
 * 运行：npm test        （等价于 node --test test/）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../mes-core.js');

/* ---------- 测试夹具 ---------- */
function mkState(over) {
  return Object.assign({
    materials: [
      { code: 'MAT-A', name: '螺丝刀', qty: 5, minQty: 0, cost: 8.5 },
      { code: 'MAT-B', name: '打印纸', qty: 10, minQty: 0, cost: 22 }
    ],
    workorders: [],
    transactions: [],
    txnSeq: 0,
    deviceId: 'test-device',
    operator: '测试员'
  }, over || {});
}
const stockOf = (s, code) => Core.findMaterial(s, code).qty;
const txnsOf = (s, code) => s.transactions.filter(t => t.matCode === code);

/* ================= 1. 工单创建 ================= */

test('工单创建：正常创建并写入计划数量', () => {
  const s = mkState();
  const r = Core.createOrder(s, {
    type: 'LL', date: '2026-09-15', code: 'LL20260915001',
    items: [{ matCode: 'MAT-A', qty: 2 }, { matCode: 'MAT-B', qty: 3 }]
  });
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(s.workorders.length, 1);
  assert.equal(r.order.code, 'LL20260915001');
  assert.equal(r.order.status, '未执行');
  assert.deepEqual(r.order.items, [{ matCode: 'MAT-A', qty: 2 }, { matCode: 'MAT-B', qty: 3 }]);
  assert.deepEqual(r.order.execQty, []);
  // 创建工单不应改动库存
  assert.equal(stockOf(s, 'MAT-A'), 5);
  assert.equal(s.transactions.length, 0);
});

test('工单创建：未建档物料被拒绝', () => {
  const s = mkState();
  const r = Core.createOrder(s, { type: 'LL', items: [{ matCode: 'NO-SUCH', qty: 1 }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('；'), /物料未建档：NO-SUCH/);
  assert.equal(s.workorders.length, 0, '校验失败不应写入工单');
});

test('工单创建：空明细 / 非法数量被拒绝', () => {
  const s = mkState();
  assert.equal(Core.createOrder(s, { type: 'LL', items: [] }).ok, false);
  assert.equal(Core.createOrder(s, { type: 'LL', items: [{ matCode: 'MAT-A', qty: 0 }] }).ok, false);
  assert.equal(Core.createOrder(s, { type: 'LL', items: [{ matCode: 'MAT-A', qty: 'abc' }] }).ok, false);
  assert.equal(Core.createOrder(s, { type: 'LL', items: [{ matCode: 'MAT-A', qty: -3 }] }).ok, false);
  assert.equal(s.workorders.length, 0);
});

/* ================= 2. 重复物料合并 ================= */

test('重复物料合并：同一物料多行 → 合并为一行且数量相加', () => {
  const s = mkState();
  const r = Core.createOrder(s, {
    type: 'LL', items: [{ matCode: 'MAT-A', qty: 2 }, { matCode: 'MAT-B', qty: 1 }, { matCode: 'MAT-A', qty: 3 }]
  });
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.order.items.length, 2, '两行 MAT-A 应被合并');
  assert.deepEqual(r.order.items, [{ matCode: 'MAT-A', qty: 5 }, { matCode: 'MAT-B', qty: 1 }]);
  assert.deepEqual(r.merged, ['MAT-A'], '应报告被合并的物料码');
});

test('重复物料合并：normalizeItems 汇总多行并保留原始行数', () => {
  const n = Core.normalizeItems([
    { matCode: 'X', qty: 1 }, { matCode: 'X', qty: 2 }, { matCode: 'X', qty: 0.5 }, { matCode: 'Y', qty: 4 }
  ]);
  assert.deepEqual(n.items, [{ matCode: 'X', qty: 3.5, lines: 3 }, { matCode: 'Y', qty: 4, lines: 1 }]);
  assert.deepEqual(Core.mergedCodes(n.items), ['X']);
});

/* ================= 3. 库存扣减 / 增加 ================= */

test('库存扣减：领料工单按明细扣减并写流水', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-1', items: [{ matCode: 'MAT-A', qty: 3 }] }).order;
  const r = Core.executeOrder(s, o);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(stockOf(s, 'MAT-A'), 2);
  assert.equal(o.status, '已执行');
  assert.equal(s.transactions.length, 1);
  assert.equal(s.transactions[0].delta, -3);
  assert.equal(s.transactions[0].balance, 2);
  assert.equal(s.transactions[0].type, '领料工单');
  assert.equal(s.transactions[0].ref, 'LL-1');
  assert.equal(s.transactions[0].seq, 1);
});

test('库存增加：补货工单按明细增加库存', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'BH', code: 'BH-1', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  const r = Core.executeOrder(s, o);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(stockOf(s, 'MAT-A'), 9);
  assert.equal(s.transactions[0].delta, 4);
  assert.equal(s.transactions[0].balance, 9);
});

test('库存扣减：退料(TL)视为入库、拣货(JH)视为出库', () => {
  assert.equal(Core.signOf('LL'), -1);
  assert.equal(Core.signOf('JH'), -1);
  assert.equal(Core.signOf('BH'), 1);
  assert.equal(Core.signOf('TL'), 1);
});

/* ================= 4. 库存不足拦截 ================= */

test('库存不足拦截：单行超库存被拒绝且库存不变', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-2', items: [{ matCode: 'MAT-A', qty: 99 }] }).order;
  const r = Core.executeOrder(s, o);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('；'), /库存不足/);
  assert.equal(stockOf(s, 'MAT-A'), 5, '被拦截时库存不得变化');
  assert.equal(o.status, '未执行');
  assert.equal(s.transactions.length, 0, '被拦截时不得写流水');
});

test('库存不足拦截【回归】同一物料多行合计超库存 → 必须拦截，不得扣成负库存', () => {
  const s = mkState();
  // 模拟旧版本已持久化的「重复物料」工单：3 + 4 = 7 > 库存 5
  s.workorders.push({
    code: 'WIP-DUP', type: 'LL', date: '2026-09-15', status: '未执行', execTime: '',
    items: [{ matCode: 'MAT-A', qty: 3 }, { matCode: 'MAT-A', qty: 4 }]
  });
  const o = s.workorders[0];
  const v = Core.validateExecution(s, o);
  assert.equal(v.ok, false, '逐行校验时 5>=3 且 5>=4 都会通过，修复后必须按合计 7 拦截');
  assert.match(v.errors.join('；'), /库存不足（现 5，需 7）/);

  const r = Core.executeOrder(s, o);
  assert.equal(r.ok, false);
  assert.equal(stockOf(s, 'MAT-A'), 5);
  assert.ok(stockOf(s, 'MAT-A') >= 0, '库存绝不允许为负');
  assert.equal(s.transactions.length, 0);
});

test('库存不足拦截【回归】新建时的重复物料合并后同样被拦截', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-3', items: [{ matCode: 'MAT-A', qty: 3 }, { matCode: 'MAT-A', qty: 4 }] }).order;
  assert.deepEqual(o.items, [{ matCode: 'MAT-A', qty: 7 }], '创建时应已合并为 7');
  const r = Core.executeOrder(s, o);
  assert.equal(r.ok, false);
  assert.equal(stockOf(s, 'MAT-A'), 5);
});

test('库存不足拦截：刚好等于库存时允许执行并归零', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-4', items: [{ matCode: 'MAT-A', qty: 5 }] }).order;
  assert.equal(Core.executeOrder(s, o).ok, true);
  assert.equal(stockOf(s, 'MAT-A'), 0);
});

/* ================= 5. 已执行工单防重复 ================= */

test('已执行工单防重复：第二次执行被拒绝且库存不再变化', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-5', items: [{ matCode: 'MAT-A', qty: 2 }] }).order;
  assert.equal(Core.executeOrder(s, o).ok, true);
  assert.equal(stockOf(s, 'MAT-A'), 3);

  const again = Core.executeOrder(s, o);
  assert.equal(again.ok, false);
  assert.match(again.errors.join('；'), /不可重复执行/);
  assert.equal(stockOf(s, 'MAT-A'), 3, '重复执行不得再次扣减');
  assert.equal(s.transactions.length, 1);
});

test('已执行工单防重复：isOrderExecuted 覆盖已执行与已取消', () => {
  assert.equal(Core.isOrderExecuted({ status: '已执行' }), true);
  assert.equal(Core.isOrderExecuted({ status: '已取消' }), true);
  assert.equal(Core.isOrderExecuted({ status: '未执行' }), false);
  assert.equal(Core.isOrderExecuted(null), false);
});

/* ================= 6. 盘点差异 ================= */

test('盘点差异：盘亏写负差异流水', () => {
  const s = mkState();
  const r = Core.applyStocktake(s, 'MAT-B', 7);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.before, 10);
  assert.equal(r.balance, 7);
  assert.equal(r.delta, -3);
  assert.equal(stockOf(s, 'MAT-B'), 7);
  assert.equal(s.transactions[0].type, '盘点');
  assert.equal(s.transactions[0].delta, -3);
  assert.equal(s.transactions[0].reason, '盘点差异');
});

test('盘点差异：盘盈写正差异流水', () => {
  const s = mkState();
  const r = Core.applyStocktake(s, 'MAT-B', 12);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.delta, 2);
  assert.equal(stockOf(s, 'MAT-B'), 12);
  assert.equal(s.transactions[0].delta, 2);
});

test('盘点差异：账实相符时 delta 为 0 但仍留痕', () => {
  const s = mkState();
  const r = Core.applyStocktake(s, 'MAT-B', 10);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.delta, 0);
  assert.equal(s.transactions.length, 1, '账实相符也要写流水留痕');
  assert.equal(s.transactions[0].reason, '账实相符');
});

test('盘点输入校验【回归】空值 / 非数字不得静默转 0', () => {
  const s = mkState();
  for (const bad of ['', '   ', null, undefined, 'abc', '12abc', '--1', '1.2.3']) {
    const r = Core.applyStocktake(s, 'MAT-B', bad);
    assert.equal(r.ok, false, `输入 ${JSON.stringify(bad)} 应被拒绝`);
  }
  assert.equal(stockOf(s, 'MAT-B'), 10, '非法盘点输入绝不能把库存改成 0');
  assert.equal(s.transactions.length, 0, '被拒绝的盘点不得写流水');
});

test('盘点输入校验：负数被拒绝，显式 0 合法', () => {
  const s = mkState();
  const neg = Core.applyStocktake(s, 'MAT-B', '-5');
  assert.equal(neg.ok, false);
  assert.match(neg.error, /不能为负数/);
  assert.equal(stockOf(s, 'MAT-B'), 10);

  const zero = Core.applyStocktake(s, 'MAT-B', '0');
  assert.equal(zero.ok, true, zero.error);
  assert.equal(stockOf(s, 'MAT-B'), 0, '显式输入 0 表示确认无货，应允许');
});

test('盘点输入校验：未建档物料被拒绝', () => {
  const s = mkState();
  const r = Core.applyStocktake(s, 'NO-SUCH', '5');
  assert.equal(r.ok, false);
  assert.match(r.error, /物料未建档/);
});

test('parseStocktakeInput：接受带空格与小数', () => {
  assert.deepEqual(Core.parseStocktakeInput(' 3.5 '), { ok: true, value: 3.5 });
  assert.deepEqual(Core.parseStocktakeInput('0'), { ok: true, value: 0 });
  assert.equal(Core.parseStocktakeInput('').ok, false);
});

/* ================= 7. 回放校验 ================= */

test('回放校验：一致的流水链通过', () => {
  const s = mkState();
  const o1 = Core.createOrder(s, { type: 'LL', code: 'LL-6', items: [{ matCode: 'MAT-A', qty: 2 }] }).order;
  Core.executeOrder(s, o1);
  Core.applyStocktake(s, 'MAT-A', 7);
  const o2 = Core.createOrder(s, { type: 'BH', code: 'BH-2', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  Core.executeOrder(s, o2);

  const rep = Core.replayAudit(s);
  assert.equal(rep.ok, true, JSON.stringify(rep.mismatches));
  assert.equal(rep.mismatches.length, 0);
  assert.equal(rep.materials, 1);
  assert.equal(rep.compared, 3);
  assert.equal(stockOf(s, 'MAT-A'), 8);
});

test('回放校验：篡改余量可被检出', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-7', items: [{ matCode: 'MAT-A', qty: 2 }] }).order;
  Core.executeOrder(s, o);
  Core.applyStocktake(s, 'MAT-A', 7);

  s.transactions[0].balance = 999;   // 篡改最新一条的余量
  const rep = Core.replayAudit(s);
  assert.equal(rep.ok, false);
  assert.equal(rep.mismatches.length, 1);
  assert.equal(rep.mismatches[0].actual, 999);
  assert.equal(rep.mismatches[0].expected, 7);
});

test('回放校验：多物料互不干扰，按物料各自成链', () => {
  const s = mkState();
  const o = Core.createOrder(s, {
    type: 'LL', code: 'LL-8', items: [{ matCode: 'MAT-A', qty: 1 }, { matCode: 'MAT-B', qty: 4 }]
  }).order;
  Core.executeOrder(s, o);
  const rep = Core.replayAudit(s);
  assert.equal(rep.ok, true, JSON.stringify(rep.mismatches));
  assert.equal(rep.materials, 2);
  assert.equal(stockOf(s, 'MAT-A'), 4);
  assert.equal(stockOf(s, 'MAT-B'), 6);
});

test('回放校验：兼容无 seq 的旧数据', () => {
  const s = mkState();
  // 旧数据同样遵循「数组内新的在前」约定（recordTxn 用 unshift），
  // 因此数组顺序是最新 → 最旧，回放时需反转为时间正序。
  s.transactions = [
    { seq: null, matCode: 'MAT-A', delta: -2, balance: 3, type: '旧', device: 'x', time: 't2' },  // 最新
    { seq: null, matCode: 'MAT-A', delta: 5, balance: 5, type: '旧', device: 'x', time: 't1' }   // 最旧
  ];
  const rep = Core.replayAudit(s);
  assert.equal(rep.ok, true, JSON.stringify(rep.mismatches));
  assert.equal(rep.compared, 2);
  // 时间正序：+5 → 3，链式余量 5 → 3 与记录一致
  assert.deepEqual(Core.orderedTransactions(s).map(t => t.delta), [5, -2]);
});

test('回放校验：旧数据与带 seq 数据混合时仍能对链', () => {
  const s = mkState();
  s.transactions = [
    { seq: 2, matCode: 'MAT-A', delta: -1, balance: 4, type: '新', device: 'x', time: 't3' },
    { seq: null, matCode: 'MAT-A', delta: 5, balance: 5, type: '旧', device: 'x', time: 't1' }
  ];
  s.txnSeq = 2;
  const rep = Core.replayAudit(s);
  assert.equal(rep.ok, true, JSON.stringify(rep.mismatches));
  assert.equal(rep.compared, 2);
});

/* ================= 8. 统一写入口 / 计划与执行数量分离 ================= */

test('统一写入口：任何库存变化都产生流水，数量与流水不可分离', () => {
  const s = mkState();
  const before = stockOf(s, 'MAT-A');
  const r = Core.applyStockChange(s, { matCode: 'MAT-A', mode: 'delta', qty: -1, type: '手工调整', reason: '测试' });
  assert.equal(r.ok, true, r.error);
  assert.equal(stockOf(s, 'MAT-A'), before - 1);
  assert.equal(s.transactions.length, 1);
  assert.equal(s.transactions[0].delta, -1);
  assert.equal(s.transactions[0].balance, before - 1);
});

test('统一写入口：默认拒绝把库存改成负数', () => {
  const s = mkState();
  const r = Core.applyStockChange(s, { matCode: 'MAT-A', mode: 'delta', qty: -100, type: '手工调整' });
  assert.equal(r.ok, false);
  assert.match(r.error, /库存不足/);
  assert.equal(stockOf(s, 'MAT-A'), 5);
  assert.equal(s.transactions.length, 0);
});

test('统一写入口：未建档物料被拒绝', () => {
  const s = mkState();
  assert.equal(Core.applyStockChange(s, { matCode: 'NOPE', mode: 'delta', qty: 1, type: 'x' }).ok, false);
});

test('计划数量与执行数量分离：执行不修改计划数量', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-9', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  assert.deepEqual(o.items, [{ matCode: 'MAT-A', qty: 4 }]);

  const r = Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 2 } });   // 实际只领 2
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.deepEqual(o.items, [{ matCode: 'MAT-A', qty: 4 }], '计划数量必须保持 4');
  assert.deepEqual(o.execQty, [{ matCode: 'MAT-A', qty: 2 }], '执行数量单独记录为 2');
  assert.equal(stockOf(s, 'MAT-A'), 3, '按执行数量 2 扣减');
  assert.equal(o.execBatches.length, 1);
  assert.equal(o.execBatches[0].items[0].qty, 2);
});

test('执行数量覆盖：汇总后仍受库存约束', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-10', items: [{ matCode: 'MAT-A', qty: 2 }] }).order;
  const r = Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 9 } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('；'), /库存不足（现 5，需 9）/);
  assert.equal(stockOf(s, 'MAT-A'), 5);
});

test('落库一致性：执行后库存等于期初加全部流水变动之和', () => {
  const s = mkState();
  const q0 = stockOf(s, 'MAT-A');
  Core.executeOrder(s, Core.createOrder(s, { type: 'LL', code: 'A1', items: [{ matCode: 'MAT-A', qty: 2 }] }).order);
  Core.executeOrder(s, Core.createOrder(s, { type: 'BH', code: 'A2', items: [{ matCode: 'MAT-A', qty: 5 }] }).order);
  Core.applyStocktake(s, 'MAT-A', 4);
  Core.applyManualAdjust(s, 'MAT-A', 6, { reason: '测试' });

  const sum = txnsOf(s, 'MAT-A').reduce((a, t) => a + t.delta, 0);
  assert.equal(stockOf(s, 'MAT-A'), q0 + sum);
  assert.equal(Core.replayAudit(s).ok, true);
});

/* ================= Phase 2：30S 定位回查 ================= */

const T0 = '2026-09-15T02:00:00.000Z';
const T1 = '2026-09-15T03:00:00.000Z';
const T2 = '2026-09-15T04:00:00.000Z';

test('扫码历史：recordScan 追加结构化记录并递增 seq', () => {
  const s = mkState();
  const a = Core.recordScan(s, { prefix: 'MAT:', code: 'MAT-A', kind: 'material', hit: true, name: '螺丝刀', loc: 'B-01-01-01', now: T0 });
  const b = Core.recordScan(s, { prefix: 'LOC:', code: 'B-01-01-01', kind: 'location', hit: true, now: T1 });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(s.scanHistory.length, 2);
  assert.equal(s.scanHistory[0].code, 'B-01-01-01', '新的在前');
  assert.equal(a.loc, 'B-01-01-01');
  assert.equal(a.ts, T0);
});

test('扫码历史：scanHistoryFor 按编码过滤并支持 limit', () => {
  const s = mkState();
  Core.recordScan(s, { code: 'MAT-A', now: T0 });
  Core.recordScan(s, { code: 'MAT-B', now: T1 });
  Core.recordScan(s, { code: 'MAT-A', now: T2 });
  assert.equal(Core.scanHistoryFor(s, 'MAT-A').length, 2);
  assert.equal(Core.scanHistoryFor(s, 'MAT-A', 1).length, 1);
  assert.equal(Core.scanHistoryFor(s, 'NOPE').length, 0);
});

test('lastTransactionFor：取该物料时间上最后一条流水', () => {
  const s = mkState();
  Core.executeOrder(s, Core.createOrder(s, { type: 'LL', code: 'L1', items: [{ matCode: 'MAT-A', qty: 1 }] }).order, { now: T0 });
  Core.executeOrder(s, Core.createOrder(s, { type: 'BH', code: 'L2', items: [{ matCode: 'MAT-A', qty: 3 }] }).order, { now: T1 });
  Core.executeOrder(s, Core.createOrder(s, { type: 'LL', code: 'L3', items: [{ matCode: 'MAT-B', qty: 1 }] }).order, { now: T2 });
  const last = Core.lastTransactionFor(s, 'MAT-A');
  assert.equal(last.ref, 'L2');
  assert.equal(last.delta, 3);
  assert.equal(Core.lastTransactionFor(s, 'NOPE'), null);
});

test('lastOrderFor：找到含该物料且时间最新的工单', () => {
  const s = mkState();
  Core.createOrder(s, { type: 'LL', code: 'W1', date: '2026-09-01', items: [{ matCode: 'MAT-A', qty: 1 }] });
  Core.createOrder(s, { type: 'LL', code: 'W2', date: '2026-09-10', items: [{ matCode: 'MAT-A', qty: 1 }] });
  Core.createOrder(s, { type: 'LL', code: 'W3', date: '2026-09-05', items: [{ matCode: 'MAT-B', qty: 1 }] });
  assert.equal(Core.lastOrderFor(s, 'MAT-A').code, 'W2');
  assert.equal(Core.lastOrderFor(s, 'MAT-B').code, 'W3');
  assert.equal(Core.lastOrderFor(s, 'NOPE'), null);
});

test('timeAgo：相对时间描述', () => {
  assert.equal(Core.timeAgo(null), '');
  assert.equal(Core.timeAgo(T0, T0), '0 秒前');
  assert.equal(Core.timeAgo(T0, '2026-09-15T02:00:30.000Z'), '30 秒前');
  assert.equal(Core.timeAgo(T0, '2026-09-15T02:05:00.000Z'), '5 分钟前');
  assert.equal(Core.timeAgo(T0, '2026-09-15T05:00:00.000Z'), '3 小时前');
  assert.equal(Core.timeAgo(T0, '2026-09-17T02:00:00.000Z'), '2 天前');
});

test('locateMaterial：台账命中时直接用台账位置', () => {
  const s = mkState();
  s.materials[0].loc = 'B-01-01-01';
  s.materials[0].container = 'XK-001';
  s.materials[0].zone = 'M-01';
  const L = Core.locateMaterial(s, 'MAT-A');
  assert.equal(L.found, true);
  assert.equal(L.source, '物料台账');
  assert.equal(L.loc, 'B-01-01-01');
  assert.equal(L.container, 'XK-001');
  assert.equal(L.zone, 'M-01');
});

test('locateMaterial【核心】台账未命中时回查最近扫码位置', () => {
  const s = mkState();
  Core.recordScan(s, { prefix: 'MAT:', code: 'GHOST', kind: 'material', hit: true, loc: 'B-02-03-04', container: 'XK-009', now: T1 });
  const L = Core.locateMaterial(s, 'GHOST');
  assert.equal(L.found, false, '台账里确实没有这条物料');
  assert.equal(L.loc, 'B-02-03-04', '仍应给出上次扫码时的位置');
  assert.equal(L.container, 'XK-009');
  assert.equal(L.source, '最近扫码');
  assert.equal(L.lastScan.ts, T1);
});

test('locateMaterial：台账有记录但库位为空时用最近扫码位置兜底', () => {
  const s = mkState();
  s.materials[0].loc = '';
  Core.recordScan(s, { code: 'MAT-A', hit: true, loc: 'B-09-09-09', now: T0 });
  const L = Core.locateMaterial(s, 'MAT-A');
  assert.equal(L.found, true);
  assert.equal(L.source, '最近扫码');
  assert.equal(L.loc, 'B-09-09-09');
});

test('locateMaterial：无扫码记录但有流水时给出最近流水线索', () => {
  const s = mkState();
  Core.executeOrder(s, Core.createOrder(s, { type: 'LL', code: 'L9', items: [{ matCode: 'MAT-A', qty: 2 }] }).order, { now: T2 });
  const L = Core.locateMaterial(s, 'MAT-A');
  assert.ok(L.lastTxn, '应返回最近流水');
  assert.equal(L.lastTxn.ref, 'L9');
  assert.ok(L.lastOrder, '同时应能找到相关工单');
  assert.equal(L.lastOrder.code, 'L9');
  assert.equal(L.source, '物料台账', '台账有库位时位置来源仍是台账');
});

test('locateMaterial：完全无记录时返回空线索', () => {
  const s = mkState();
  const L = Core.locateMaterial(s, 'NOTHING');
  assert.equal(L.found, false);
  assert.equal(L.loc, '');
  assert.equal(L.lastScan, null);
  assert.equal(L.lastTxn, null);
  assert.equal(L.lastOrder, null);
  assert.equal(L.source, '无记录');
});

test('locateMaterial：流水回查只认本物料，不串号', () => {
  const s = mkState();
  Core.executeOrder(s, Core.createOrder(s, { type: 'LL', code: 'X', items: [{ matCode: 'MAT-B', qty: 1 }] }).order, { now: T0 });
  const L = Core.locateMaterial(s, 'MAT-A');
  assert.equal(L.lastTxn, null, 'MAT-A 没有流水，不应拿到 MAT-B 的');
  assert.equal(L.lastOrder, null);
});

test('30S 定位可达性：随机抽 10 个物料都能给出库位或时间线索', () => {
  const s = mkState({ materials: [] });
  for (let i = 1; i <= 10; i++) {
    s.materials.push({ code: 'P-' + i, name: '零件' + i, qty: i, minQty: 0, cost: 0, loc: i % 2 ? 'B-01-0' + (i % 9 + 1) + '-01' : '', container: '', zone: 'M-0' + (i % 5 + 1) });
  }
  // 偶数号没有台账库位，但曾扫过
  for (let i = 2; i <= 10; i += 2) {
    Core.recordScan(s, { code: 'P-' + i, hit: true, loc: 'B-07-0' + i + '-02', now: T0 });
  }
  for (let i = 1; i <= 10; i++) {
    const L = Core.locateMaterial(s, 'P-' + i);
    assert.ok(L.loc || L.lastScan || L.lastTxn || L.lastOrder, 'P-' + i + ' 应至少有一个位置/时间线索');
  }
});

test('locateMaterial【回归】后续无位置的扫码不得覆盖早先的位置线索', () => {
  const s = mkState();
  Core.recordScan(s, { code: 'GHOST', hit: true, loc: 'B-02-03-04', container: 'XK-009', now: T0 });
  assert.equal(Core.locateMaterial(s, 'GHOST').loc, 'B-02-03-04');

  // 再扫一次，这次未命中 → 记录不带位置
  Core.recordScan(s, { code: 'GHOST', hit: false, now: T1 });
  const L = Core.locateMaterial(s, 'GHOST');
  assert.equal(L.loc, 'B-02-03-04', '位置线索必须保住');
  assert.equal(L.container, 'XK-009');
  assert.equal(L.source, '最近扫码');
  assert.equal(L.lastScan.ts, T1, '时间展示仍取最新一次扫码');
});

test('locateMaterial：位置兜底只认带位置的记录，跳过中间的空位置记录', () => {
  const s = mkState();
  Core.recordScan(s, { code: 'G', hit: true, loc: 'B-01-01-01', now: T0 });
  Core.recordScan(s, { code: 'G', hit: false, now: T1 });
  Core.recordScan(s, { code: 'G', hit: false, now: T2 });
  const L = Core.locateMaterial(s, 'G');
  assert.equal(L.loc, 'B-01-01-01');
  assert.equal(L.lastScan.ts, T2);
});
