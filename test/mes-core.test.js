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

test('回放校验【Phase1·coverage】中间挖掉 #500~#600 必须报数据不完整，不能伪装账目正确', () => {
  const s = mkState();
  s.transactions = Array.from({ length: 1000 }, (_, i) => {
    const seq = 1000 - i;
    return { seq, matCode: 'MAT-A', delta: 1, balance: seq, type: '测试', time: 't' + seq };
  }).filter(t => t.seq < 500 || t.seq > 600);
  const rep = Core.replayAudit(s, { expectedMaxSeq: 1000 });
  assert.equal(rep.ok, false, '中间缺账时绝不能显示为正确');
  assert.equal(rep.status, 'incomplete');
  assert.deepEqual(rep.coverage.gaps, [{ from: 500, to: 600 }]);
});

test('回放校验【Phase1·coverage】尾部尚未拉到时报告缺失范围', () => {
  const s = mkState();
  s.transactions = [{ seq: 1, matCode: 'MAT-A', delta: 1, balance: 1 }];
  const rep = Core.replayAudit(s, { expectedMaxSeq: 3 });
  assert.equal(rep.status, 'incomplete');
  assert.deepEqual(rep.coverage.gaps, [{ from: 2, to: 3, tail: true }]);
});

test('回放校验【Phase1·coverage】完整连续链条保持 complete-valid', () => {
  const s = mkState();
  s.transactions = [
    { seq: 3, matCode: 'MAT-A', delta: -1, balance: 2 },
    { seq: 2, matCode: 'MAT-A', delta: 1, balance: 3 },
    { seq: 1, matCode: 'MAT-A', delta: 2, balance: 2 }
  ];
  const rep = Core.replayAudit(s, { expectedMaxSeq: 3 });
  assert.equal(rep.ok, true);
  assert.equal(rep.status, 'complete-valid');
  assert.equal(rep.coverage.complete, true);
});

test('回放校验【Phase1·coverage】真余额篡改仍必须是 mismatch（coverage 不能削弱核账）', () => {
  const s = mkState();
  s.transactions = [
    { seq: 2, matCode: 'MAT-A', delta: -1, balance: 99 },
    { seq: 1, matCode: 'MAT-A', delta: 2, balance: 2 }
  ];
  const rep = Core.replayAudit(s, { expectedMaxSeq: 2 });
  assert.equal(rep.ok, false);
  assert.equal(rep.status, 'mismatch');
  assert.equal(rep.coverage.complete, true);
  assert.equal(rep.mismatches.length, 1);
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

test('执行数量覆盖【Phase 3 策略变更】不得超过剩余计划数量', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-10', items: [{ matCode: 'MAT-A', qty: 2 }] }).order;
  const r = Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 9 } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('；'), /超出剩余计划数量（计划 2，已执行 0，剩余 2）/);
  assert.equal(stockOf(s, 'MAT-A'), 5, '被拒绝时库存不得变化');
  assert.equal(o.status, '未执行');
});

test('执行数量在计划内时仍受库存约束', () => {
  const s = mkState();
  // 计划 99（数量在计划内），但库存只有 5 → 必须因库存不足被拦
  const o = Core.createOrder(s, { type: 'LL', code: 'LL-10b', items: [{ matCode: 'MAT-A', qty: 99 }] }).order;
  const r = Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 99 } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('；'), /库存不足（现 5，需 99）/);
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

/* ================= Phase 3：工单管理增强 ================= */

test('状态模型：待执行/部分执行/已执行/已取消 判定函数', () => {
  assert.equal(Core.isPending({ status: '未执行' }), true);
  assert.equal(Core.isPending({ status: '待执行' }), true, '「待执行」与「未执行」等价');
  assert.equal(Core.isPartiallyExecuted({ status: '部分执行' }), true);
  assert.equal(Core.isFullyExecuted({ status: '已执行' }), true);
  assert.equal(Core.isCancelled({ status: '已取消' }), true);
  assert.equal(Core.isOrderOpen({ status: '未执行' }), true);
  assert.equal(Core.isOrderOpen({ status: '部分执行' }), true);
  assert.equal(Core.isOrderOpen({ status: '已执行' }), false);
  assert.equal(Core.isOrderOpen({ status: '已取消' }), false);
  assert.equal(Core.statusLabel('未执行'), '待执行');
  assert.equal(Core.statusLabel('部分执行'), '部分执行');
});

test('orderProgress：计划 / 已执行 / 剩余 三项数量', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'P1', items: [{ matCode: 'MAT-A', qty: 5 }, { matCode: 'MAT-B', qty: 4 }] }).order;
  let p = Core.orderProgress(o);
  assert.deepEqual(p.items, [
    { matCode: 'MAT-A', planned: 5, executed: 0, remaining: 5 },
    { matCode: 'MAT-B', planned: 4, executed: 0, remaining: 4 }
  ]);
  assert.equal(p.plannedTotal, 9);
  assert.equal(p.executedTotal, 0);
  assert.equal(p.remainingTotal, 9);
  assert.equal(p.percent, 0);
  assert.equal(p.anyExecuted, false);
  assert.equal(p.fullyExecuted, false);

  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 2, 'MAT-B': 4 } });
  p = Core.orderProgress(o);
  assert.equal(p.items[0].remaining, 3);
  assert.equal(p.items[1].remaining, 0);
  assert.equal(p.executedTotal, 6);
  assert.equal(p.remainingTotal, 3);
  assert.equal(p.percent, 67);
  assert.equal(p.fullyExecuted, false);
});

test('部分执行：第一次只执行一部分 → 状态为「部分执行」，计划数量不变', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'PE-1', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  const r = Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 1 } });
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.partial, true);
  assert.equal(o.status, '部分执行');
  assert.deepEqual(o.items, [{ matCode: 'MAT-A', qty: 4 }], '计划数量始终不变');
  assert.deepEqual(o.execQty, [{ matCode: 'MAT-A', qty: 1 }]);
  assert.equal(stockOf(s, 'MAT-A'), 4);
  assert.equal(o.execBatches.length, 1);
  assert.equal(Core.orderProgress(o).items[0].remaining, 3);
});

test('部分执行：再次执行剩余部分 → 累计为「已执行」，库存正确', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'PE-2', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 1 } });
  const r2 = Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 3 } });
  assert.equal(r2.ok, true, r2.errors.join('；'));
  assert.equal(o.status, '已执行');
  assert.deepEqual(o.execQty, [{ matCode: 'MAT-A', qty: 4 }]);
  assert.equal(stockOf(s, 'MAT-A'), 1, '5 - 1 - 3 = 1');
  assert.equal(o.execBatches.length, 2, '应有两批执行记录');
  assert.equal(Core.orderProgress(o).remainingTotal, 0);
  assert.equal(Core.orderProgress(o).percent, 100);
});

test('部分执行：多物料工单分批执行，各物料剩余独立计算', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'PE-3', items: [{ matCode: 'MAT-A', qty: 3 }, { matCode: 'MAT-B', qty: 5 }] }).order;
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 3, 'MAT-B': 2 } });
  assert.equal(o.status, '部分执行');
  assert.equal(stockOf(s, 'MAT-A'), 2);
  assert.equal(stockOf(s, 'MAT-B'), 8);

  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 0, 'MAT-B': 3 } });
  assert.equal(o.status, '已执行');
  assert.equal(stockOf(s, 'MAT-A'), 2, 'MAT-A 已执行完，不应再变动');
  assert.equal(stockOf(s, 'MAT-B'), 5);
  assert.equal(o.execBatches.length, 2);
});

test('部分执行：已执行满的物料在后续批次中不再重复扣减', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'PE-4', items: [{ matCode: 'MAT-A', qty: 2 }, { matCode: 'MAT-B', qty: 2 }] }).order;
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 2, 'MAT-B': 0 } });
  assert.equal(stockOf(s, 'MAT-A'), 3);
  // 不传 execQtyByCode → 默认执行全部剩余
  const r = Core.executeOrder(s, o);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(stockOf(s, 'MAT-A'), 3, 'MAT-A 剩余为 0，不得再扣');
  assert.equal(stockOf(s, 'MAT-B'), 8);
  assert.equal(o.status, '已执行');
});

test('部分执行：超过剩余数量被拒绝', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'PE-5', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 3 } });
  const r = Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 2 } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('；'), /超出剩余计划数量（计划 4，已执行 3，剩余 1）/);
  assert.equal(stockOf(s, 'MAT-A'), 2, '被拒绝时库存不得变化');
  assert.equal(o.status, '部分执行');
});

test('取消工单：未执行的工单可取消，状态变「已取消」，库存不变', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'C-1', items: [{ matCode: 'MAT-A', qty: 3 }] }).order;
  const r = Core.cancelOrder(s, o, { reason: '计划取消', operator: '张三' });
  assert.equal(r.ok, true, r.error);
  assert.equal(o.status, '已取消');
  assert.equal(o.cancelInfo.reason, '计划取消');
  assert.equal(o.cancelInfo.operator, '张三');
  assert.equal(stockOf(s, 'MAT-A'), 5, '取消不改库存');
  assert.equal(s.transactions.length, 0, '取消不写流水');
});

test('取消工单：已执行的工单不能直接取消，须走冲销', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'C-2', items: [{ matCode: 'MAT-A', qty: 2 }] }).order;
  Core.executeOrder(s, o);
  const r = Core.cancelOrder(s, o);
  assert.equal(r.ok, false);
  assert.match(r.error, /不能直接取消/);
  assert.equal(o.status, '已执行');
});

test('取消工单：部分执行的工单同样不能直接取消', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'C-3', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 1 } });
  assert.equal(Core.cancelOrder(s, o).ok, false);
  assert.equal(o.status, '部分执行');
});

test('取消工单：已取消的工单不能重复取消', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'C-4', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  Core.cancelOrder(s, o);
  const r = Core.cancelOrder(s, o);
  assert.equal(r.ok, false);
  assert.match(r.error, /已是「已取消」状态/);
});

test('冲销工单【核心】出库工单冲销后库存回到执行前', () => {
  const s = mkState();
  const before = stockOf(s, 'MAT-A');
  const o = Core.createOrder(s, { type: 'LL', code: 'R-1', items: [{ matCode: 'MAT-A', qty: 3 }] }).order;
  Core.executeOrder(s, o);
  assert.equal(stockOf(s, 'MAT-A'), before - 3);

  const r = Core.reverseOrder(s, o, { reason: '单据作废' });
  assert.equal(r.ok, true, r.error);
  assert.equal(stockOf(s, 'MAT-A'), before, '冲销后库存必须回到执行前');
  assert.equal(o.status, '已取消');
  assert.ok(o.reverseInfo);
  assert.equal(o.reverseInfo.reason, '单据作废');
  // 流水链保持完整：执行 -3，冲销 +3
  const txns = Core.orderTransactions(s, 'R-1');
  assert.equal(txns.length, 2);
  assert.deepEqual(txns.map(t => t.delta), [-3, 3]);
  assert.equal(txns[1].type, '冲销');
  assert.equal(Core.replayAudit(s).ok, true, '冲销后回放校验仍须一致');
});

test('冲销工单：部分执行后冲销，只回退已执行的数量', () => {
  const s = mkState();
  const before = stockOf(s, 'MAT-A');
  const o = Core.createOrder(s, { type: 'LL', code: 'R-2', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 2 } });
  assert.equal(stockOf(s, 'MAT-A'), before - 2);

  const r = Core.reverseOrder(s, o);
  assert.equal(r.ok, true, r.error);
  assert.equal(stockOf(s, 'MAT-A'), before, '只回退已执行的 2 件');
  assert.equal(o.status, '已取消');
  assert.equal(o.execQty[0].qty, 2, '执行历史保留，便于追溯');
});

test('冲销工单：入库工单（补货）冲销方向相反', () => {
  const s = mkState();
  const before = stockOf(s, 'MAT-A');
  const o = Core.createOrder(s, { type: 'BH', code: 'R-3', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  Core.executeOrder(s, o);
  assert.equal(stockOf(s, 'MAT-A'), before + 4);
  Core.reverseOrder(s, o);
  assert.equal(stockOf(s, 'MAT-A'), before);
  assert.deepEqual(Core.orderTransactions(s, 'R-3').map(t => t.delta), [4, -4]);
});

test('冲销工单：未执行的工单不能冲销', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'R-4', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  const r = Core.reverseOrder(s, o);
  assert.equal(r.ok, false);
  assert.match(r.error, /尚未执行/);
});

test('冲销工单：已冲销（已取消）的工单不能重复冲销', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'R-5', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  Core.executeOrder(s, o);
  Core.reverseOrder(s, o);
  const r = Core.reverseOrder(s, o);
  assert.equal(r.ok, false);
  assert.match(r.error, /已取消/);
});

test('冲销工单：多物料工单全部回退', () => {
  const s = mkState();
  const a0 = stockOf(s, 'MAT-A'), b0 = stockOf(s, 'MAT-B');
  const o = Core.createOrder(s, { type: 'LL', code: 'R-6', items: [{ matCode: 'MAT-A', qty: 2 }, { matCode: 'MAT-B', qty: 3 }] }).order;
  Core.executeOrder(s, o);
  Core.reverseOrder(s, o);
  assert.equal(stockOf(s, 'MAT-A'), a0);
  assert.equal(stockOf(s, 'MAT-B'), b0);
  assert.equal(Core.replayAudit(s).ok, true);
});

test('已执行或已取消的工单不能再执行', () => {
  const s = mkState();
  const o1 = Core.createOrder(s, { type: 'LL', code: 'B-1', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  Core.executeOrder(s, o1);
  assert.match(Core.executeOrder(s, o1).errors.join('；'), /不可重复执行/);

  const o2 = Core.createOrder(s, { type: 'LL', code: 'B-2', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  Core.cancelOrder(s, o2);
  assert.match(Core.executeOrder(s, o2).errors.join('；'), /不可重复执行/);
});

test('关联流水：orderTransactions 只返回本工单的流水且按时间正序', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'T-1', items: [{ matCode: 'MAT-A', qty: 1 }, { matCode: 'MAT-B', qty: 2 }] }).order;
  Core.executeOrder(s, o, { now: T0 });
  Core.applyStocktake(s, 'MAT-B', 99, { now: T1 });      // 与工单无关
  const other = Core.createOrder(s, { type: 'LL', code: 'T-2', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  Core.executeOrder(s, other, { now: T2 });

  const txns = Core.orderTransactions(s, 'T-1');
  assert.equal(txns.length, 2, '只包含本工单的两条流水');
  assert.ok(txns.every(t => t.ref === 'T-1'));
  assert.ok(txns[0].ts <= txns[1].ts, '按时间正序');
});

test('执行历史：orderHistory 记录创建与每次执行批次', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'LL', code: 'H-1', date: '2026-09-15', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 1 }, operator: '甲', now: T0 });
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 2 }, operator: '乙', now: T1 });

  const hist = Core.orderHistory(o);
  assert.equal(hist.length, 3, '1 次创建 + 2 次执行');
  assert.equal(hist[0].kind, 'create');
  assert.equal(hist[1].kind, 'execute');
  assert.equal(hist[1].batch, 1);
  assert.equal(hist[1].operator, '甲');
  assert.equal(hist[2].batch, 2);
  assert.equal(hist[2].operator, '乙');
  assert.match(hist[2].text, /第 2 次执行/);
});

test('执行历史：取消与冲销也进入历史', () => {
  const s = mkState();
  const o1 = Core.createOrder(s, { type: 'LL', code: 'H-2', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  Core.cancelOrder(s, o1, { reason: '不要了' });
  const h1 = Core.orderHistory(o1);
  assert.equal(h1[h1.length - 1].kind, 'cancel');
  assert.match(h1[h1.length - 1].text, /不要了/);

  const o2 = Core.createOrder(s, { type: 'LL', code: 'H-3', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  Core.executeOrder(s, o2);
  Core.reverseOrder(s, o2, { reason: '发错货' });
  const h2 = Core.orderHistory(o2);
  assert.equal(h2[h2.length - 1].kind, 'reverse');
  assert.match(h2[h2.length - 1].text, /发错货/);
});

test('orderSummary：列表页摘要包含进度与批次', () => {
  const s = mkState();
  const o = Core.createOrder(s, { type: 'BH', code: 'S-1', date: '2026-09-15', items: [{ matCode: 'MAT-A', qty: 4 }] }).order;
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 1 } });
  const sum = Core.orderSummary(o);
  assert.equal(sum.code, 'S-1');
  assert.equal(sum.typeName, '补货工单');
  assert.equal(sum.statusLabel, '部分执行');
  assert.equal(sum.plannedTotal, 4);
  assert.equal(sum.executedTotal, 1);
  assert.equal(sum.remainingTotal, 3);
  assert.equal(sum.percent, 25);
  assert.equal(sum.batchCount, 1);
});

test('工单完整闭环：创建 → 部分执行 → 再执行 → 冲销，库存与流水全程一致', () => {
  const s = mkState();
  const a0 = stockOf(s, 'MAT-A'), b0 = stockOf(s, 'MAT-B');
  const o = Core.createOrder(s, { type: 'LL', code: 'FULL-1', items: [{ matCode: 'MAT-A', qty: 4 }, { matCode: 'MAT-B', qty: 2 }] }).order;

  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 1, 'MAT-B': 0 } });
  assert.equal(o.status, '部分执行');
  Core.executeOrder(s, o, { execQtyByCode: { 'MAT-A': 3, 'MAT-B': 2 } });
  assert.equal(o.status, '已执行');
  assert.equal(stockOf(s, 'MAT-A'), a0 - 4);
  assert.equal(stockOf(s, 'MAT-B'), b0 - 2);
  assert.equal(o.execBatches.length, 2);

  const rev = Core.reverseOrder(s, o, { reason: '整单作废' });
  assert.equal(rev.ok, true, rev.error);
  assert.equal(stockOf(s, 'MAT-A'), a0);
  assert.equal(stockOf(s, 'MAT-B'), b0);
  assert.equal(o.status, '已取消');

  // 流水：第 1 批只动 MAT-A，第 2 批动两种，冲销各回退一条 → 1 + 2 + 2 = 5 条
  const txns = Core.orderTransactions(s, 'FULL-1');
  assert.equal(txns.length, 5);
  assert.deepEqual(txns.map(t => t.matCode + ':' + t.delta), ['MAT-A:-1', 'MAT-A:-3', 'MAT-B:-2', 'MAT-A:4', 'MAT-B:2']);
  assert.equal(Core.replayAudit(s).ok, true, '全流程结束后回放校验仍须一致');
  // 执行历史完整可查：创建 + 2 批次 + 冲销
  assert.equal(Core.orderHistory(o).length, 4);
});

/* ================= Phase 4：30S 精确定位收口 ================= */

test('库位解析：货架区精确到架-层-位', () => {
  assert.deepEqual(Core.parseLocationCode('B-01-03-04'), {
    level: 'shelf', text: 'B区 1号货架 第3层 第4位', parts: { area: 'B', shelf: 1, layer: 3, pos: 4 }
  });
  assert.equal(Core.parseLocationCode('C-02-04-08').text, 'C区 2号货架 第4层 第8位');
});

test('库位解析：工位格与开放区块不混淆', () => {
  // W01-G02 与 K401-A03 形状相同，必须靠规则消歧
  assert.equal(Core.parseLocationCode('W01-G02').level, 'workstation');
  assert.equal(Core.parseLocationCode('W01-G02').text, '1号工位 第2格');
  assert.equal(Core.parseLocationCode('K401-A03').level, 'block');
  assert.equal(Core.parseLocationCode('K401-A03').text, 'K401 开放区 A通道 第3块位');
});

test('库位解析：台账 kind 优先于编码规则', () => {
  const s = { locations: [{ code: 'K401-A03', kind: '空地', desc: '401开放区 A通道 3号块位' }] };
  assert.equal(Core.resolveLocation(s, 'K401-A03').desc, '401开放区 A通道 3号块位');
  assert.equal(Core.resolveLocation(s, 'K401-A03').level, 'block');
});

test('库位解析：模块区与容器码', () => {
  assert.equal(Core.parseLocationCode('M-01').level, 'zone');
  assert.equal(Core.parseLocationCode('XK-001').level, 'container');
  assert.equal(Core.parseLocationCode('A4SH-015').level, 'container');
  assert.equal(Core.parseLocationCode('').level, 'unknown');
});

test('resolveLocation：容器解析到它所在的架-层-位', () => {
  const s = {
    locations: [{ code: 'B-02-04-08', kind: '货架', desc: 'B区 2号货架 第四层 第8位' }],
    containers: [{ code: 'XK-001', loc: 'B-02-04-08' }]
  };
  const r = Core.resolveLocation(s, 'XK-001');
  assert.equal(r.level, 'container');
  assert.ok(r.containerAt, '应补出容器所在库位');
  assert.equal(r.containerAt.code, 'B-02-04-08');
  assert.match(r.containerAt.text, /B区 2号货架/);
});

test('定位分级：有库位 = exact（架-层-位）', () => {
  const s = mkState();
  s.materials[0].loc = 'B-01-03-04';
  const d = Core.locateDetail(s, 'MAT-A');
  assert.equal(d.grade, 'exact');
  assert.equal(d.level, 'shelf');
  assert.equal(d.path, 'B区 1号货架 第3层 第4位');   // 台账无说明时也翻译成可读的架-层-位
});

test('定位分级：台账无说明时仍给出可读位置', () => {
  const s = mkState();
  s.materials[0].loc = 'B-01-03-04';
  s.locations = [];                      // 没有说明列
  const d = Core.locateDetail(s, 'MAT-A');
  assert.equal(d.grade, 'exact');
  assert.equal(d.level, 'shelf');
  assert.equal(s.materials[0].loc, 'B-01-03-04');
  // parseLocationCode 能把编码翻译成人话
  assert.equal(Core.parseLocationCode('B-01-03-04').text, 'B区 1号货架 第3层 第4位');
});

test('定位分级：只有容器且容器有库位 → 仍算精确', () => {
  const s = mkState();
  s.materials[0].loc = '';
  s.materials[0].container = 'XK-001';
  s.containers = [{ code: 'XK-001', loc: 'B-05-02-03' }];
  s.locations = [{ code: 'B-05-02-03', kind: '货架', desc: 'B区5号货架 第二层 第3位' }];
  const d = Core.locateDetail(s, 'MAT-A');
  assert.equal(d.grade, 'exact');
  assert.match(d.path, /B区5号货架 第二层 第3位/);
  assert.match(d.path, /容器 XK-001/);
});

test('定位分级：只有容器且容器未登记库位 → container', () => {
  const s = mkState();
  s.materials[0].loc = '';
  s.materials[0].container = 'XK-777';
  s.containers = [{ code: 'XK-777', loc: '' }];
  assert.equal(Core.locateDetail(s, 'MAT-A').grade, 'container');
});

test('定位分级：只有模块区 → zone（粗略）', () => {
  const s = mkState();
  s.materials[0].loc = '';
  s.materials[0].container = '';
  s.materials[0].zone = 'M-02';
  const d = Core.locateDetail(s, 'MAT-A');
  assert.equal(d.grade, 'zone');
  assert.equal(d.level, 'zone');
  assert.match(d.path, /模块区/);
});

test('定位分级：已领出的零件靠历史线索仍可定位（clue）', () => {
  const s = mkState();
  s.materials[0].loc = '';        // 已领出：台账里没有库位
  s.materials[0].container = '';
  s.materials[0].zone = '';
  Core.recordScan(s, { code: 'MAT-A', hit: true, loc: 'B-08-01-02', now: T0 });
  const d = Core.locateDetail(s, 'MAT-A');
  assert.equal(d.grade, 'exact', '历史扫码带位置 → 可直接落到架-层-位');
  assert.equal(d.loc, 'B-08-01-02');
});

test('定位分级：无位置但有流水 → clue，给出时间与位置', () => {
  const s = mkState();
  s.materials[0].loc = '';
  s.materials[0].container = '';
  s.materials[0].zone = '';
  Core.executeOrder(s, Core.createOrder(s, { type: 'LL', code: 'LOC-1', items: [{ matCode: 'MAT-A', qty: 1 }] }).order, { now: T1 });
  const d = Core.locateDetail(s, 'MAT-A');
  assert.equal(d.grade, 'clue', '没有位置线索时退化为时间线索');
  assert.match(d.path, /最近记录/);
});

test('定位分级：完全无记录 → none', () => {
  const s = mkState();
  s.materials[0].loc = '';
  s.materials[0].container = '';
  s.materials[0].zone = '';
  assert.equal(Core.locateDetail(s, 'MAT-A').grade, 'none');
  assert.equal(Core.locateDetail(s, 'NOT-EXIST').grade, 'none');
});

test('locateAudit【验收标准 9】随机抽 10 个零件，全部可定位且多数精确', () => {
  const s = mkState({ materials: [] });
  s.locations = [];
  s.containers = [];
  for (let i = 1; i <= 40; i++) {
    const hasLoc = i % 4 !== 0;                       // 3/4 有库位
    s.materials.push({
      code: 'P-' + String(i).padStart(2, '0'), name: '零件' + i, qty: i, minQty: 0, cost: 0,
      loc: hasLoc ? 'B-01-' + String((i % 4) + 1).padStart(2, '0') + '-01' : '',
      container: (i % 4 === 0) ? '' : '',
      zone: 'M-0' + ((i % 5) + 1)
    });
  }
  const rep = Core.locateAudit(s, { sample: 10, seed: 42 });
  assert.equal(rep.checked, 10);
  assert.equal(rep.total, 40);
  assert.equal(rep.ok, true, '不应有完全无法定位的零件');
  assert.equal(rep.summary.none, 0);
  assert.ok(rep.preciseRatio >= 0.5, '精确率应过半，实际 ' + rep.preciseRatio);
});

test('locateAudit：同 seed 抽样可复现，不同 seed 抽样不同', () => {
  const s = mkState({ materials: [] });
  for (let i = 0; i < 50; i++) s.materials.push({ code: 'P' + i, name: 'n' + i, qty: 1, minQty: 0, cost: 0, loc: 'B-01-01-01' });
  const a = Core.locateAudit(s, { sample: 10, seed: 7 }).results.map(r => r.code);
  const b = Core.locateAudit(s, { sample: 10, seed: 7 }).results.map(r => r.code);
  const c = Core.locateAudit(s, { sample: 10, seed: 99 }).results.map(r => r.code);
  assert.deepEqual(a, b, '同 seed 应抽到同一批');
  assert.notDeepEqual(a, c, '不同 seed 应抽出不同批次');
});

test('locateAudit：抽查数量超过总数时按总数取', () => {
  const s = mkState();
  const rep = Core.locateAudit(s, { sample: 100 });
  assert.equal(rep.checked, 2);
  assert.equal(rep.total, 2);
});

test('locateAudit：能标出无法定位的零件（负数用于验证告警真的会触发）', () => {
  const s = mkState({ materials: [
    { code: 'HAS-LOC', name: '有位置', qty: 1, minQty: 0, cost: 0, loc: 'B-01-01-01' },
    { code: 'NO-CLUE', name: '完全无线索', qty: 1, minQty: 0, cost: 0, loc: '', container: '', zone: '' }
  ] });
  const rep = Core.locateAudit(s, { sample: 10, seed: 1 });
  assert.equal(rep.ok, false, '存在无法定位的零件时 ok 必须为 false');
  assert.equal(rep.summary.none, 1);
  assert.ok(rep.results.find(r => r.code === 'NO-CLUE'));
});

test('回归：locateDetail 与扫码页、台账页看到的位置一致', () => {
  const s = mkState();
  s.materials[0].loc = 'B-01-05-06';
  s.materials[0].container = 'XK-001';
  s.materials[0].zone = 'M-03';
  const d = Core.locateDetail(s, 'MAT-A');
  const L = Core.locateMaterial(s, 'MAT-A');
  assert.equal(d.loc, L.loc);
  assert.equal(d.container, L.container);
  assert.equal(d.zone, L.zone);
  assert.equal(d.source, '物料台账');
});

/* ================= Phase 5：闲鱼数据合并（需求书 4.3） ================= */

const XY_LOCAL = () => ({
  materials: [{
    code: 'XY-001', cat: 'GJ', name: '旧名字', spec: 'PH2×100mm', xy: '', loc: 'B-01-01-01',
    container: 'XK-001', zone: 'M-01', qty: 5, minQty: 3, cost: 10, img: ''
  }],
  workorders: [], transactions: []
});

test('闲鱼字段映射：outer_id/product_id/标题/stock/售价/首图 全部对应正确', () => {
  const r = Core.normalizeXianyuRow({
    outer_id: 'XY-001', product_id: 'P1001', '标题': '螺丝刀 十字 PH2×100mm',
    stock: 12, '售价': 850, '首图': 'https://img.example/a.jpg'
  });
  assert.deepEqual(r, { code: 'XY-001', xy: 'P1001', name: '螺丝刀 十字 PH2×100mm', qty: 12, cost: 8.5, img: 'https://img.example/a.jpg' });
});

test('闲鱼字段映射：售价按 100 换算成成本，除数可配置', () => {
  assert.equal(Core.normalizeXianyuRow({ outer_id: 'A', '售价': 1290 }).cost, 12.9);
  assert.equal(Core.normalizeXianyuRow({ outer_id: 'A', '售价': 1290 }, { priceDivisor: 1 }).cost, 1290);
});

test('闲鱼字段映射：兼容英文键与大小写', () => {
  const r = Core.normalizeXianyuRow({ OUTER_ID: 'A', productId: 'P1', title: 'T', STOCK: '3', price: '500', picUrl: 'u' });
  assert.equal(r.code, 'A');
  assert.equal(r.xy, 'P1');
  assert.equal(r.name, 'T');
  assert.equal(r.qty, 3);
  assert.equal(r.cost, 5);
  assert.equal(r.img, 'u');
});

test('闲鱼合并：新商品建档，分类默认 QT', () => {
  const s = { materials: [] };
  const stat = Core.mergeXianyu(s, [{ outer_id: 'NEW-1', '标题': '新商品', stock: 7, '售价': 990, '首图': 'u' }]);
  assert.equal(stat.created, 1);
  const m = s.materials[0];
  assert.equal(m.code, 'NEW-1');
  assert.equal(m.cat, 'QT', '分类应默认 QT');
  assert.equal(m.name, '新商品');
  assert.equal(m.qty, 7);
  assert.equal(m.cost, 9.9);
  assert.equal(m.minQty, 0);
  assert.equal(m.loc, '');
});

test('闲鱼合并【核心】不覆盖本地已维护的分类/库位/容器/模块区/安全库存/规格', () => {
  const s = XY_LOCAL();
  Core.mergeXianyu(s, [{ outer_id: 'XY-001', product_id: 'P1', '标题': '新名字', stock: 0, '售价': 850 }]);
  const m = s.materials[0];
  assert.equal(m.cat, 'GJ', '分类不得被覆盖');
  assert.equal(m.loc, 'B-01-01-01', '库位不得被覆盖');
  assert.equal(m.container, 'XK-001', '容器不得被覆盖');
  assert.equal(m.zone, 'M-01', '模块区不得被覆盖');
  assert.equal(m.minQty, 3, '安全库存不得被覆盖');
  assert.equal(m.spec, 'PH2×100mm', '规格型号不得被覆盖（闲鱼不提供）');
});

test('闲鱼合并：数量与成本例外，外部值始终采用（0 表示售罄）', () => {
  const s = XY_LOCAL();
  Core.mergeXianyu(s, [{ outer_id: 'XY-001', stock: 0, '售价': 850 }]);
  assert.equal(s.materials[0].qty, 0, 'stock=0 表示售罄，必须采用');
  assert.equal(s.materials[0].cost, 8.5);
});

test('闲鱼合并：空值不覆盖旧值', () => {
  const s = XY_LOCAL();
  s.materials[0].xy = 'KEEP-XY';
  s.materials[0].img = 'keep.jpg';
  Core.mergeXianyu(s, [{ outer_id: 'XY-001', '标题': '', product_id: '', '首图': '', stock: 5, '售价': 1000 }]);
  const m = s.materials[0];
  assert.equal(m.name, '旧名字', '空标题不得清掉旧名称');
  assert.equal(m.xy, 'KEEP-XY', '空 product_id 不得清掉旧编号');
  assert.equal(m.img, 'keep.jpg', '空首图不得清掉旧图片');
});

test('闲鱼合并：幂等，重复执行不产生重复记录', () => {
  const s = XY_LOCAL();
  const rows = [{ outer_id: 'XY-001', product_id: 'P1', '标题': '螺丝刀', stock: 4, '售价': 850 }, { outer_id: 'XY-002', '标题': '新品', stock: 2, '售价': 500 }];
  const a = Core.mergeXianyu(s, rows);
  assert.equal(a.created, 1);
  assert.equal(a.updated, 1);
  assert.equal(s.materials.length, 2);

  const b = Core.mergeXianyu(s, rows);
  assert.equal(b.created, 0, '第二次不应再新建');
  assert.equal(b.updated, 0, '第二次不应再更新');
  assert.equal(b.unchanged, 2);
  assert.equal(s.materials.length, 2, '物料数不得增长');
});

test('闲鱼合并：缺少 outer_id 的行被跳过并给出原因', () => {
  const s = { materials: [] };
  const stat = Core.mergeXianyu(s, [{ '标题': '没有编码' }, { outer_id: 'OK', '标题': '正常', stock: 1 }]);
  assert.equal(stat.created, 1);
  assert.equal(stat.skipped.length, 1);
  assert.match(stat.skipped[0].reason, /缺少 outer_id/);
  assert.equal(s.materials.length, 1);
});

test('闲鱼合并：同一批里 outer_id 重复的行只取第一条并提示', () => {
  const s = { materials: [] };
  const stat = Core.mergeXianyu(s, [
    { outer_id: 'DUP', '标题': '第一次', stock: 1 },
    { outer_id: 'DUP', '标题': '第二次', stock: 9 }
  ]);
  assert.equal(stat.created, 1);
  assert.equal(stat.skipped.length, 1);
  assert.match(stat.skipped[0].reason, /重复/);
  assert.equal(s.materials[0].name, '第一次');
  assert.equal(s.materials[0].qty, 1);
});

test('闲鱼合并：数量非法（非数字）时保留原值而不是清零', () => {
  const s = XY_LOCAL();
  Core.mergeXianyu(s, [{ outer_id: 'XY-001', stock: '不是数字', '售价': 850 }]);
  assert.equal(s.materials[0].qty, 5, '非法 stock 不得把库存清零');
});

test('闲鱼合并：changes 记录可审计的字段变化', () => {
  const s = XY_LOCAL();
  const stat = Core.mergeXianyu(s, [{ outer_id: 'XY-001', '标题': '新名字', stock: 0, '售价': 850 }]);
  assert.equal(stat.changes.length, 1);
  assert.equal(stat.changes[0].kind, 'update');
  const joined = stat.changes[0].fields.join('；');
  assert.match(joined, /qty: 5 → 0/);
  assert.match(joined, /cost: 10 → 8\.5/);
  assert.match(joined, /name: 旧名字 → 新名字/);
});

/* ================= 云端合并 mergeRemote（飞书为真源） =================
   这一组是「网页端与飞书对齐」的核心语义。之前用的是并集合并（只加不删），
   飞书里删掉的记录会永远留在网页端 —— 这正是「云端的表和飞书没对齐」的头号原因。 */

/** 造一个只含 8 张表空数组的 state */
function mkSync(over) {
  const base = {
    materials: [], locations: [], containers: [], members: [],
    items: [], manuals: [], workorders: [], transactions: [], txnSeq: 0
  };
  return Object.assign(base, over || {});
}

test('合并：飞书有、本地没有 → 加入', () => {
  const st = mkSync();
  const r = Core.mergeRemote(st, { materials: [{ code: 'A', name: '甲' }] }, { syncedKeys: {} });
  assert.equal(r.created, 1);
  assert.equal(st.materials.length, 1);
  assert.equal(st.materials[0].name, '甲');
});

test('合并：两边都有 → 飞书覆盖本地', () => {
  const st = mkSync({ materials: [{ code: 'A', name: '本地名', qty: 1 }] });
  Core.mergeRemote(st, { materials: [{ code: 'A', name: '飞书名', qty: 2 }] }, { syncedKeys: { materials: ['A'] } });
  assert.equal(st.materials[0].name, '飞书名');
  assert.equal(st.materials[0].qty, 2);
});

test('合并：飞书为空值时不覆盖本地非空值', () => {
  const st = mkSync({ materials: [{ code: 'A', name: '本地名', spec: 'M3' }] });
  const r = Core.mergeRemote(st, { materials: [{ code: 'A', name: '', spec: '' }] }, { syncedKeys: { materials: ['A'] } });
  assert.equal(st.materials[0].name, '本地名', '空值不能把本地真值清掉');
  assert.equal(st.materials[0].spec, 'M3');
  assert.equal(r.keptLocal, 1);
});

test('合并【关键】飞书没有这一列 → 本地值原样保留（模块区的消失就是这么来的）', () => {
  const st = mkSync({
    materials: [{ code: 'A', name: '螺丝刀', zone: 'M-01' }],
    locations: [{ code: 'M-01', kind: '模块区', desc: '电控区' }]
  });
  // 物料台账没有「模块区」列 → pullState 不会产出 zone 键
  // 库位「类型」是单选[货架|工位|站点]，写不进「模块区」→ 回读是空串
  Core.mergeRemote(st, {
    materials: [{ code: 'A', name: '螺丝刀' }],
    locations: [{ code: 'M-01', kind: '', desc: '电控区' }]
  }, { syncedKeys: { materials: ['A'], locations: ['M-01'] } });
  assert.equal(st.materials[0].zone, 'M-01', '缺列时本地模块区必须保留');
  assert.equal(st.locations[0].kind, '模块区', '飞书该列为空时本地「模块区」不能被清成空');
});

test('合并【显式删除】allowDelete:true 时才把「上次同步有、这次没有」的删掉', () => {
  /* 注意：删除**不再是默认行为**（P3 改）。这里显式开 allowDelete 才走删的路径。
     默认行为见下面那个「默认绝不删」的用例 —— 那次改动的原因是：
     一次半截返回就能让全量拉取误删成批本地数据，且删完不留凭据。 */
  const st = mkSync({
    materials: [{ code: 'A' }, { code: 'GONE' }, { code: 'NEW' }]
  });
  const r = Core.mergeRemote(st, { materials: [{ code: 'A' }] },
    { syncedKeys: { materials: ['A', 'GONE'] }, allowDelete: true });
  const codes = st.materials.map(m => m.code).sort();
  assert.deepEqual(codes, ['A', 'NEW'], 'GONE 来自飞书且已被删 → 本地删；NEW 是本地新建 → 保留');
  assert.equal(r.deleted, 1);
  assert.deepEqual(r.pending.map(p => p.id), ['NEW']);
});

test('合并：首次同步（没有 syncedKeys）不删任何东西，全部记为待推送', () => {
  const st = mkSync({ locations: [{ code: 'C-01-01-01', kind: '货架' }] });
  const r = Core.mergeRemote(st, { locations: [] }, {});
  assert.equal(r.deleted, 0, '没有基线时不敢删，否则会把本地刚建的数据一次抹掉');
  assert.equal(st.locations.length, 1);
  assert.deepEqual(r.pending.map(p => p.id), ['C-01-01-01']);
});

test('合并：某张表这次没拉到（不是数组）→ 整表不动', () => {
  const st = mkSync({ materials: [{ code: 'A' }], members: [{ code: 'MB-1' }] });
  Core.mergeRemote(st, { materials: [] }, { syncedKeys: {} });
  assert.deepEqual(st.members.map(m => m.code), ['MB-1'], '没拉到的表不能被清空');
  assert.ok(!('members' in Core.mergeRemote(st, { materials: [] }, {}).syncedKeys));
});

test('合并【关键】protect 里的字段不被飞书旧值覆盖（工单「部分执行」被打回的场景）', () => {
  const st = mkSync({ workorders: [{ code: 'LL-1', status: '部分执行', execQty: [{ matCode: 'X', qty: 2 }] }] });
  const remote = { workorders: [{ code: 'LL-1', status: '未执行', execQty: [] }] };
  // 不加保护：飞书的旧值会把「部分执行」打回「未执行」
  const st2 = mkSync({ workorders: [{ code: 'LL-1', status: '部分执行', execQty: [{ matCode: 'X', qty: 2 }] }] });
  Core.mergeRemote(st2, remote, { syncedKeys: { workorders: ['LL-1'] } });
  assert.equal(st2.workorders[0].status, '未执行', '（对照）没有保护时确实会被打回');
  assert.deepEqual(st2.workorders[0].execQty, []);
  // 加了保护：本地为准
  const r = Core.mergeRemote(st, remote, { syncedKeys: { workorders: ['LL-1'] }, protect: { workorders: { 'LL-1': ['status', 'execQty'] } } });
  assert.equal(st.workorders[0].status, '部分执行', '受保护字段必须以本地为准');
  assert.deepEqual(st.workorders[0].execQty, [{ matCode: 'X', qty: 2 }]);
  assert.equal(r.protected, 1);
});

test('合并：流水按 seq 去重合并、新的在前、txnSeq 单调递增', () => {
  const st = mkSync({
    transactions: [{ seq: 1, matCode: 'A', delta: -1 }, { seq: 3, matCode: 'A', delta: -3 }],
    txnSeq: 3
  });
  const r = Core.mergeRemote(st, {
    transactions: [{ seq: 1, matCode: 'A', delta: -1 }, { seq: 2, matCode: 'A', delta: -2 }, { seq: 3, matCode: 'A', delta: -3 }]
  }, { syncedKeys: { transactions: [1, 3] } });
  assert.deepEqual(st.transactions.map(t => t.seq), [3, 2, 1], '新的在前');
  assert.equal(st.transactions.length, 3, 'seq=3 不能重复');
  assert.equal(st.txnSeq, 3);
  assert.equal(r.created, 1);
});

test('合并【Phase0·关键】流水绝不截断到 2000 条（截断会把不一致伪装成一致）', () => {
  const N = 2500;
  const remoteTxns = Array.from({ length: N }, (_, i) => ({ seq: N - i, matCode: 'A', delta: -1, balance: N - i - 1 }));
  const st = mkSync({ transactions: [], txnSeq: 0 });
  Core.mergeRemote(st, { transactions: remoteTxns }, { syncedKeys: { transactions: [] } });

  assert.equal(st.transactions.length, N, '必须完整保留 ' + N + ' 条，实测 ' + st.transactions.length);
  // 无 seq 的旧流水最危险：旧实现把它们拼在数组尾部，超限时**最先被无声扔掉**，
  // 而飞书里还在 → 每次同步都「拉取新增 N 条」→ 又被截掉 → 永久 churn。
  assert.ok(st.transactions.some(t => t.seq === 1), '最旧的 #1 也必须还在');
  assert.ok(st.transactions.every(t => t && t.seq != null), '不能丢掉任何带 seq 的流水');
});

test('合并【Phase0】无 seq 的旧流水同样不被丢弃', () => {
  const old = Array.from({ length: 2100 }, (_, i) => ({ seq: null, matCode: 'A', delta: 0, balance: 0, time: 't' + i }));
  const st = mkSync({ transactions: old, txnSeq: 0 });
  Core.mergeRemote(st, { transactions: [] }, { syncedKeys: { transactions: [] } });
  assert.equal(st.transactions.filter(t => t.seq == null).length, 2100, '无 seq 的旧流水一条都不能少');
});

test('合并【显式删除】流水在 allowDelete:true 时同样同步删除', () => {
  const st = mkSync({ transactions: [{ seq: 1 }, { seq: 2 }], txnSeq: 2 });
  Core.mergeRemote(st, { transactions: [{ seq: 1 }] },
    { syncedKeys: { transactions: [1, 2] }, allowDelete: true });
  assert.deepEqual(st.transactions.map(t => t.seq), [1]);
});

test('合并【P3 默认安全】不显式允许时绝不删，且把它记进 pendingDelete', () => {
  const st = mkSync({ materials: [{ code: 'A' }, { code: 'GONE' }] });
  const r = Core.mergeRemote(st, { materials: [{ code: 'A' }] }, { syncedKeys: { materials: ['A', 'GONE'] } });
  assert.equal(r.deleted, 0, '默认必须一条都不删');
  assert.deepEqual(st.materials.map(m => m.code).sort(), ['A', 'GONE'], '本地数据原样保留');
  assert.deepEqual(r.pendingDelete, [{ table: 'materials', id: 'GONE' }], '要列成「待人工核删」而不是悄悄删');
});

test('合并【P3 关键】待核删的键必须留在基线里，否则会被当成「本地新建」推回飞书', () => {
  const st = mkSync({ materials: [{ code: 'A' }, { code: 'GONE' }] });
  const r = Core.mergeRemote(st, { materials: [{ code: 'A' }] }, { syncedKeys: { materials: ['A', 'GONE'] } });
  assert.ok(r.syncedKeys.materials.includes('GONE'),
    '飞书删掉的键要留在 __syncedKeys 里 —— 留不下的话下一轮 autoPushPending 会把它重新建回飞书');
  assert.deepEqual(r.pending.map(p => p.id), [], '绝不能同时被当成待推送');
  // 再跑一轮，确认不会突然变成 pending
  const r2 = Core.mergeRemote(st, { materials: [{ code: 'A' }] }, { syncedKeys: r.syncedKeys });
  assert.deepEqual(r2.pending.map(p => p.id), [], '第二轮仍然不能变成待推送');
  assert.equal(r2.deleted, 0);
  assert.deepEqual(st.materials.map(m => m.code).sort(), ['A', 'GONE']);
});

test('合并【P3 闸门】即使 allowDelete:true，该表被证明没拉全也绝不删', () => {
  const st = mkSync({ materials: [{ code: 'A' }, { code: 'GONE' }] });
  const r = Core.mergeRemote(st, { materials: [{ code: 'A' }] },
    { syncedKeys: { materials: ['A', 'GONE'] }, allowDelete: true, complete: { materials: false } });
  assert.equal(r.deleted, 0, '分页没拉全时必须放弃判删（否则一次截断就批量误删）');
  assert.deepEqual(st.materials.map(m => m.code).sort(), ['A', 'GONE']);
  assert.deepEqual(r.pendingDelete, [{ table: 'materials', id: 'GONE' }]);

  // complete 为 null（拿不到 total，无法证明）同样不许删：「证明不了」不等于「没问题」
  const st3 = mkSync({ materials: [{ code: 'A' }, { code: 'GONE' }] });
  const r3 = Core.mergeRemote(st3, { materials: [{ code: 'A' }] },
    { syncedKeys: { materials: ['A', 'GONE'] }, allowDelete: true, complete: { materials: null } });
  assert.equal(r3.deleted, 0, 'complete=null 无法证明完整 → 不许删');

  // 同一份数据，证明拉全了 → 允许删
  const st2 = mkSync({ materials: [{ code: 'A' }, { code: 'GONE' }] });
  const r2 = Core.mergeRemote(st2, { materials: [{ code: 'A' }] },
    { syncedKeys: { materials: ['A', 'GONE'] }, allowDelete: true, complete: { materials: true } });
  assert.equal(r2.deleted, 1);
});

test('合并：记录本次飞书键集合，供下次判断「删除」用', () => {
  const st = mkSync();
  const r = Core.mergeRemote(st, { materials: [{ code: 'A' }, { code: 'B' }], members: [{ code: 'MB-1' }] }, {});
  assert.deepEqual(r.syncedKeys.materials.sort(), ['A', 'B']);
  assert.deepEqual(r.syncedKeys.members, ['MB-1']);
  assert.deepEqual(st.__syncedKeys.materials.sort(), ['A', 'B']);
});

test('合并【回归】幂等：同一份 remote 连续合并两次，第二次不再产生任何变更', () => {
  const st = mkSync({ materials: [{ code: 'A', name: '本地', qty: 1 }] });
  const remote = { materials: [{ code: 'A', name: '甲', qty: 2 }, { code: 'B', name: '乙', qty: 3 }] };
  const r1 = Core.mergeRemote(st, remote, { syncedKeys: {} });
  const snap = JSON.stringify(st.materials);
  const r2 = Core.mergeRemote(st, remote, { syncedKeys: st.__syncedKeys });
  assert.ok(r1.created + r1.updated > 0);
  assert.equal(r2.created, 0, '第二次不应再新建');
  assert.equal(r2.updated, 0, '第二次不应再更新');
  assert.equal(r2.deleted, 0, '第二次不应删除');
  assert.equal(JSON.stringify(st.materials), snap, '结果必须稳定');
});

test('合并【端到端】飞书删一条、改一条、加一条，本地三种结果同时正确', () => {
  const st = mkSync({
    members: [
      { code: 'MB-001', name: '陈曦' },        // 飞书侧已删除
      { code: 'MB-004', name: '旧名' },        // 飞书侧改名
      { code: 'MB-099', name: '本地新建' }     // 还没推上去
    ]
  });
  // syncedKeys = 上次同步时飞书有哪些键。MB-099 是本地新建、还没推上去，所以不在基线里。
  const r = Core.mergeRemote(st, {
    members: [{ code: 'MB-004', name: '卢王淳' }, { code: 'MB-500', name: '飞书新增' }]
  }, { syncedKeys: { members: ['MB-001', 'MB-004'] }, allowDelete: true });   // 删除路径已改为显式开启
  const by = Object.fromEntries(st.members.map(m => [m.code, m]));
  assert.equal(by['MB-001'], undefined, '飞书删了 → 本地也删');
  assert.equal(by['MB-004'].name, '卢王淳', '飞书改了 → 本地更新');
  assert.equal(by['MB-500'].name, '飞书新增', '飞书加了 → 本地加入');
  assert.equal(by['MB-099'].name, '本地新建', '本地新建还没推 → 保留');
  assert.deepEqual(r.pending.map(p => p.id), ['MB-099']);
  assert.equal(r.deleted, 1);
});

/* ============================================================================
 * P3-1 流水号身份：服务端 seq 必须回写到本地那条乐观流水
 *
 * 背景：本地 recordTransaction 用自己的计数器分配 seq，服务端 writeStock 另有一套
 * 「全表最大 +1」。两边在「另一台设备刚写过」或「超时重放被幂等挡回」时必然不同。
 * 不回写的后果是账本里同一次操作变成两条流水 —— 下面第一个用例就是那个场景的复现。
 * ========================================================================== */

test('reconcileTxnSeq【复现原 bug】不回写会让同一次操作变成两条流水', () => {
  // 本地乐观分配 seq=11；服务端（另一台设备刚写过）实际给了 seq=12
  const st = mkState();
  const txn = Core.recordTransaction(st, { type: '手工调整', matCode: 'MAT-A', delta: -2, balance: 3 });
  assert.equal(txn.seq, 1, '新 state 的 txnSeq 从 0 起，第一笔是 1');

  // 不调用 reconcileTxnSeq，直接按旧行为走一次 mergeRemote
  const remoteTxn = { seq: 2, matCode: 'MAT-A', delta: -2, balance: 3, type: '手工调整', ts: txn.ts };
  Core.mergeRemote(st, { transactions: [remoteTxn] }, { syncedKeys: {} });
  const seqs = st.transactions.map(t => t.seq);
  assert.equal(st.transactions.length, 2, '❌ 这就是 bug：一次操作在本地变成两条流水');
  assert.deepEqual(seqs.slice().sort((a, b) => a - b), [1, 2]);
});

test('reconcileTxnSeq【修复】回写后不会产生重复流水，且 txnSeq 抬到服务端之上', () => {
  const st = mkState();
  const txn = Core.recordTransaction(st, { type: '手工调整', matCode: 'MAT-A', delta: -2, balance: 3 });
  const r = Core.reconcileTxnSeq(st, { localSeq: txn.seq, serverSeq: 12, opId: 'op-1' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'updated');
  assert.equal(txn.seq, 12, '本地那条要改成服务端分配的号');
  assert.equal(txn.opId, 'op-1');
  assert.equal(st.txnSeq, 12, 'txnSeq 必须抬到 12，否则下一笔又会撞号');

  // 现在把服务端那条拉回来 → 不能再多出一条
  Core.mergeRemote(st, { transactions: [{ seq: 12, matCode: 'MAT-A', delta: -2, balance: 3, type: '手工调整' }] }, { syncedKeys: {} });
  assert.equal(st.transactions.length, 1, '回写之后不能出现第二条');
  assert.equal(st.transactions[0].seq, 12);
});

test('reconcileTxnSeq：本地已经有服务端那个号时合并掉乐观那条，不删权威那条', () => {
  const st = mkState();
  const mine = Core.recordTransaction(st, { type: '盘点', matCode: 'MAT-A', delta: 0, balance: 5 });
  // 自己写的那笔已经被拉回来了（服务端 seq=7），本地也有一条 7
  st.transactions.unshift({ seq: 7, matCode: 'MAT-A', delta: 0, balance: 5, type: '盘点', reason: '来自服务端' });
  const r = Core.reconcileTxnSeq(st, { localSeq: mine.seq, serverSeq: 7, opId: 'op-2' });
  assert.equal(r.action, 'merged');
  assert.equal(r.removed, 1);
  assert.equal(st.transactions.length, 1, '只能剩一条');
  assert.equal(st.transactions[0].seq, 7);
  assert.equal(st.transactions[0].reason, '来自服务端', '保留的是服务端那条（字段是权威值）');
});

test('reconcileTxnSeq：同号是 noop；找不到本地那条是 missing；非法参数不抛', () => {
  const st = mkState();
  const t = Core.recordTransaction(st, { type: '手工调整', matCode: 'MAT-A', delta: 1, balance: 6 });
  assert.equal(Core.reconcileTxnSeq(st, { localSeq: t.seq, serverSeq: t.seq }).action, 'noop');
  assert.equal(Core.reconcileTxnSeq(st, { localSeq: 999, serverSeq: 1000 }).action, 'missing');
  assert.equal(Core.reconcileTxnSeq(st, { localSeq: null, serverSeq: 3 }).ok, false);
  assert.equal(Core.reconcileTxnSeq(st, {}).ok, false);
  assert.equal(Core.reconcileTxnSeq(null, { localSeq: 1, serverSeq: 2 }).ok, false, 'state 不可用时要返回而不是抛');
  assert.equal(st.transactions.length, 1, '这些边界都不该改动流水');
});

test('reconcileTxnSeq：多设备并发写后各自回写，两边账本一致', () => {
  // 两台设备在同一个基线（txnSeq=5）上各写一笔；服务端仲裁成 6 与 7
  const mk = () => {
    const st = mkState();
    st.transactions = [];
    st.txnSeq = 5;
    return st;
  };
  const A = mk(), B = mk();
  const ta = Core.recordTransaction(A, { type: '手工调整', matCode: 'MAT-A', delta: -1, balance: 4 });
  const tb = Core.recordTransaction(B, { type: '手工调整', matCode: 'MAT-B', delta: -1, balance: 9 });
  assert.equal(ta.seq, 6); assert.equal(tb.seq, 6);       // 两边乐观号相同 —— 这正是要仲裁的原因
  Core.reconcileTxnSeq(A, { localSeq: ta.seq, serverSeq: 6, opId: 'a' });
  Core.reconcileTxnSeq(B, { localSeq: tb.seq, serverSeq: 7, opId: 'b' });

  // 两台设备最终都拉到这两条
  const all = [{ seq: 6, matCode: 'MAT-A', delta: -1, balance: 4 }, { seq: 7, matCode: 'MAT-B', delta: -1, balance: 9 }];
  Core.mergeRemote(A, { transactions: all }, { syncedKeys: {} });
  Core.mergeRemote(B, { transactions: all }, { syncedKeys: {} });
  assert.deepEqual(A.transactions.map(t => t.seq).sort((x, y) => x - y), [6, 7]);
  assert.deepEqual(B.transactions.map(t => t.seq).sort((x, y) => x - y), [6, 7]);
  assert.equal(A.transactions.length, 2, 'A 不能有重复流水');
  assert.equal(B.transactions.length, 2, 'B 不能有重复流水');
});

test('executeOrder / reverseOrder 的 applied 要带上 txn（否则调用方拿不到本地 seq 去回写）', () => {
  const st = mkState();
  st.workorders = [{ code: 'LL1', type: 'LL', date: '2026-01-01', status: '未执行', items: [{ matCode: 'MAT-A', qty: 2 }] }];
  const w = st.workorders[0];
  const r = Core.executeOrder(st, w, { execQtyByCode: { 'MAT-A': 2 } });
  assert.equal(r.ok, true);
  assert.ok(r.applied[0].txn && r.applied[0].txn.seq != null, 'executeOrder 必须把 txn 透出来');

  const rv = Core.reverseOrder(st, w, { reason: '测' });
  assert.equal(rv.ok, true);
  assert.ok(rv.applied[0].txn && rv.applied[0].txn.seq != null, 'reverseOrder 必须把 txn 透出来');
  const before = st.transactions.length;
  Core.reconcileTxnSeq(st, { localSeq: rv.applied[0].txn.seq, serverSeq: 99, opId: 'rv' });
  assert.equal(rv.applied[0].txn.seq, 99);
  assert.equal(st.transactions.length, before, '回写不该增减流水条数');
});
