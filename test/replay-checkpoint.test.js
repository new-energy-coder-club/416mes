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

/* ================= v3.13.14：为「第三道前缀指纹 Σbalance」补测试锁 =================
   背景：DSH 在大数据量排查中手工实测发现——CHECKPOINT.latestUsable 只校验
   prefixCount + deltaSum，第三道 Σbalance 指纹实际在 mes-core.js:1590，
   且实测确认它能拦住「只改 balance 不改 delta」的篡改。
   但该行为此前**零测试覆盖**（grep balanceSum 在 checkpoint 用例中 0 命中），
   一旦有人在 mes-core 重构时删掉那一段，没有任何测试会报警。 */

test('v3.13.14：只改 balance（delta 不变）也必须否决 checkpoint 并退回全量', () => {
  const clean = txns(2000);
  const cps = CP.build(clean).checkpoints;
  assert.ok(cps.length >= 1, '先造出 checkpoint（2000 条 → seq 1000/2000）');
  const cp = cps[cps.length - 1];
  // 篡改某条 balance，保持 delta 与条数都不变
  const tampered = JSON.parse(JSON.stringify(clean));
  tampered[500].balance = 12345;
  // latestUsable 层：只按 prefixCount+deltaSum 判定，**仍会选中**（这是设计，不是缺陷）
  const picked = CP.latestUsable(cps, tampered);
  assert.equal(picked && picked.seq, cp.seq, 'latestUsable 层仍选中（两道指纹）');
  // mes-core 层：第三道 Σbalance 指纹必须否决它，退回全量比对
  const rep = Core.replayAudit({ transactions: tampered, materials: [] }, { fromCheckpoint: cp, assumeOrdered: true });
  assert.equal(rep.fromCheckpoint, null, '必须否决被篡改前缀的 checkpoint');
  assert.equal(rep.skipped, 0, '不得跳过任何前缀');
  assert.equal(rep.compared, 2000, '必须全量比对');
  assert.equal(rep.ok, false, '必须检出 mismatch');
  assert.equal(rep.status, 'mismatch');
});

test('v3.13.14：干净数据下 checkpoint 正常生效（不被第三道指纹误伤）', () => {
  const clean = txns(2000);
  const cp = CP.build(clean).checkpoints.slice(-1)[0];
  const rep = Core.replayAudit({ transactions: clean, materials: [] }, { fromCheckpoint: cp, assumeOrdered: true });
  assert.equal(rep.ok, true, '干净数据必须通过');
  assert.equal(rep.fromCheckpoint, cp.seq, '必须采用 checkpoint');
  assert.equal(rep.skipped, 2000, '前缀必须被跳过（这才是 checkpoint 的性能意义）');
  assert.equal(rep.compared, 0);
});

test('v3.13.14：改 delta 同样被否决（第三道指纹之外的另两道路径仍有效）', () => {
  const clean = txns(2000);
  const cp = CP.build(clean).checkpoints.slice(-1)[0];
  const tampered = JSON.parse(JSON.stringify(clean));
  tampered[500].delta = 99;
  const picked = CP.latestUsable(CP.build(clean).checkpoints, tampered);
  assert.equal(picked, null, '改 delta 会破坏 deltaSum → latestUsable 层就已拒绝');
  const rep = Core.replayAudit({ transactions: tampered, materials: [] }, { fromCheckpoint: cp, assumeOrdered: true });
  assert.equal(rep.fromCheckpoint, null);
  assert.equal(rep.ok, false);
});

test('v3.13.14：mes-core 必须实际存在 Σbalance 校验代码（防重构误删）', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'mes-core.js'), 'utf8');
  assert.match(src, /cp\.balanceSum != null/, 'mes-core 必须校验 balanceSum（第三道指纹）');
  assert.match(src, /prefix\[q2\]\.balance/, '必须逐条累加前缀 balance');
  /* 注释里写明了这道指纹的由来（2.52.1 k3 审计 MAT-2），一并 assert 防止注释与代码被一起删掉 */
  assert.match(src, /MAT-2/, '必须保留 MAT-2 案底注释');
});
