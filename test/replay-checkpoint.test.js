'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CP = require('../lib/replay-checkpoint.js');
const Core = require('../mes-core.js');
function txns(n) { return Array.from({ length: n }, (_, i) => ({ seq: i + 1, matCode: i % 2 ? 'B' : 'A', delta: 1, balance: Math.floor(i / 2) + 1 })); }

test('checkpoint：每 1000 条连续且正确流水保存一次快照', () => {
  const r = CP.build(txns(2500));
  assert.equal(r.reason, null);
  assert.deepEqual(r.checkpoints.map(x => x.seq), [1000, 2000]);
  assert.equal(r.checkpoints[0].coverage.complete, true);
});
test('checkpoint：中间缺 #500~#600 时不得生成或使用快照', () => {
  const r = CP.build(txns(1000).filter(x => x.seq < 500 || x.seq > 600));
  assert.equal(r.reason, 'incomplete');
  assert.deepEqual(r.checkpoints, []);
  assert.equal(CP.latestUsable([{ seq: 1000, version: 1, coverage: { complete: true } }], txns(1000).filter(x => x.seq !== 600)), null);
});
test('checkpoint：余额篡改时不得生成快照', () => {
  const a = txns(1000); a[700].balance = 999;
  const r = CP.build(a);
  assert.equal(r.reason, 'mismatch');
  assert.equal(r.badSeq, 701);
});
test('checkpoint：只选择最新合法 checkpoint', () => {
  const a = txns(2500); const r = CP.build(a);
  assert.equal(CP.latestUsable(r.checkpoints, a).seq, 2000);
});

/* ============================================================================
 * P7-4：checkpoint 必须真的被消费，而且不能掩盖被改坏的前缀
 * ========================================================================== */

function mkLedger(n, matCode) {
  // 每物料余额：从期初 0 开始，每条 +1
  const txns = [];
  for (let i = 1; i <= n; i++) txns.push({ seq: i, matCode: matCode || 'M', delta: 1, balance: i, ts: new Date(1700000000000 + i * 1000).toISOString(), type: '手工调整' });
  return txns;
}

test('checkpoint【P7 核心】replayAudit 从快照起算，结果与全量重放完全一致', () => {
  const txns = mkLedger(2500);
  const st = { materials: [{ code: 'M', qty: 2500 }], transactions: txns, txnSeq: 2500 };
  const built = CP.build(txns);
  assert.ok(built.checkpoints.length >= 2, '2500 条应产生 2 份以上快照');
  const cp = CP.latestUsable(built.checkpoints, txns);
  assert.ok(cp, '应挑出一份可用快照');
  assert.equal(cp.seq, 2000, '取最新的那份（每 1000 条一份）');

  const full = Core.replayAudit(st);
  const inc = Core.replayAudit(st, { fromCheckpoint: cp });
  assert.equal(inc.fromCheckpoint, 2000, '必须真的从快照起算');
  assert.ok(inc.skipped >= 2000, '应跳过 2000 条：实际 ' + inc.skipped);
  assert.equal(inc.compared, full.compared - 2000, '实际比较的条数应少 2000');
  assert.deepEqual(inc.mismatches, full.mismatches, '结论必须与全量重放一致');
  assert.equal(inc.status, full.status);
  assert.equal(inc.ok, full.ok);
});

test('checkpoint【P7 关键】前缀被人改过时绝不使用快照（否则会跳过被改坏的数据）', () => {
  const txns = mkLedger(2500);
  const built = CP.build(txns);
  const cp = CP.latestUsable(built.checkpoints, txns);
  assert.ok(cp);

  // 场景一：在快照之前悄悄改掉一条流水的「变动」（余额随之不符）
  const tampered = txns.map(t => (t.seq === 500 ? Object.assign({}, t, { delta: 99 }) : t));
  assert.equal(CP.latestUsable(built.checkpoints, tampered), null,
    '前缀的变动之和变了 → 必须判定快照失效');
  const st2 = { materials: [{ code: 'M', qty: 2500 }], transactions: tampered, txnSeq: 2500 };
  const r2 = Core.replayAudit(st2, { fromCheckpoint: cp });
  assert.equal(r2.fromCheckpoint, null, '指纹不符时必须退回全量重放');
  assert.ok(r2.mismatches.length > 0, '而且必须**报出**那条被改坏的数据（这正是快照会掩盖的东西）');

  // 场景二：前缀里少了一条（有人删了行）
  const missing = txns.filter(t => t.seq !== 700);
  assert.equal(CP.latestUsable(built.checkpoints, missing), null, '前缀条数变了 → 快照失效');
});

test('checkpoint【P7】账本有缺口时不用快照（从缺口起算没有意义）', () => {
  const txns = mkLedger(2500).filter(t => t.seq !== 5);
  const built = CP.build(txns);
  assert.equal(built.reason, 'incomplete', '有缺口时 build 本身就不产出快照');
  assert.equal(built.checkpoints.length, 0);
  assert.equal(CP.latestUsable(built.checkpoints, txns), null);
  const st = { materials: [{ code: 'M', qty: 2499 }], transactions: txns, txnSeq: 2500 };
  const r = Core.replayAudit(st, { fromCheckpoint: { version: 1, seq: 1000, balances: { M: 1000 }, coverage: { complete: true }, prefixCount: 1000, deltaSum: 1000 } });
  assert.equal(r.fromCheckpoint, null, '全局覆盖不完整时不接受任何快照');
});

test('checkpoint【P7】快照里没有的物料仍按「自身期初」起算（新物料不能算错）', () => {
  // M 在前 1000 条，N 只在 1001 之后出现
  const txns = mkLedger(1500, 'M').concat([
    { seq: 1501, matCode: 'N', delta: 5, balance: 5, ts: new Date(1700000000000 + 1501 * 1000).toISOString(), type: '手工调整' }
  ]);
  const built = CP.build(txns);
  const cp = CP.latestUsable(built.checkpoints, txns);
  assert.ok(cp, '有快照可用');
  assert.equal(cp.balances.N, undefined, 'N 在快照时点还不存在');
  const st = { materials: [{ code: 'M', qty: 1500 }, { code: 'N', qty: 5 }], transactions: txns, txnSeq: 1501 };
  const full = Core.replayAudit(st);
  const inc = Core.replayAudit(st, { fromCheckpoint: cp });
  assert.deepEqual(inc.mismatches, full.mismatches, 'N 的期初应由它自己的首条反推，结论必须一致');
  assert.equal(inc.ok, full.ok);
});
