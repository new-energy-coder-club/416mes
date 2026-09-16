'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../mes-core.js');
const CP = require('../lib/replay-checkpoint.js');

function txns(n) {
  const bal = Object.create(null);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const matCode = 'M' + (i % 10);
    const delta = i % 3 === 0 ? -1 : 2;
    bal[matCode] = (bal[matCode] || 1000) + delta;
    out.push({ seq: i, matCode, delta, balance: bal[matCode], type: '压测', time: '2026-09-16 00:00:00' });
  }
  return out.reverse(); // 生产 state 的约定：新的在前
}

test('Phase1 压测：5 万条流水不截断、coverage 完整、checkpoint 每千条生成', () => {
  const transactions = txns(50000);
  const t0 = Date.now();
  const audit = Core.replayAudit({ transactions }, { expectedMaxSeq: 50000 });
  const ms = Date.now() - t0;
  assert.equal(audit.status, 'complete-valid', JSON.stringify(audit.coverage));
  assert.equal(audit.transactions, 50000);
  assert.equal(audit.coverage.complete, true);
  const cps = CP.build(transactions);
  assert.equal(cps.checkpoints.length, 50);
  assert.equal(cps.checkpoints.at(-1).seq, 50000);
  // Node CI 慢机给足余量；Worker 接线负责避免浏览器主线程卡顿。
  assert.ok(ms < 5000, '5万条纯回放应在 5s 内，实测 ' + ms + 'ms');
});

test('Phase1 压测：挖掉中间 100 条仍必须准确报告缺口', () => {
  const transactions = txns(50000).filter(t => t.seq < 20000 || t.seq > 20099);
  const r = Core.replayAudit({ transactions }, { expectedMaxSeq: 50000 });
  assert.equal(r.status, 'incomplete');
  assert.deepEqual(r.coverage.gaps, [{ from: 20000, to: 20099 }]);
});
