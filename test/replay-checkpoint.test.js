'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CP = require('../lib/replay-checkpoint.js');
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
