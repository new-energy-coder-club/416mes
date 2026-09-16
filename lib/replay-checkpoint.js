/*!
 * lib/replay-checkpoint.js — Phase 1 账本回放 checkpoint
 *
 * checkpoint 只从“连续且已经核验通过”的位置产生：每 CHECKPOINT_EVERY 条保存一次
 * 每物料余额快照。缺口、重复 seq 或余额不符时绝不产生/使用 checkpoint。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MesReplayCheckpoint = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var EVERY = 1000;
  function ordered(txns) { return (txns || []).filter(t => t && Number.isFinite(Number(t.seq)) && Number(t.seq) > 0).slice().sort((a, b) => a.seq - b.seq); }
  function coverage(txns) {
    var a = ordered(txns), gaps = [];
    for (var i = 1; i < a.length; i++) if (a[i].seq > a[i - 1].seq + 1) gaps.push({ from: a[i - 1].seq + 1, to: a[i].seq - 1 });
    return { minSeq: a.length ? a[0].seq : null, maxSeq: a.length ? a[a.length - 1].seq : null, gaps: gaps, complete: !!a.length && a[0].seq === 1 && !gaps.length };
  }
  function build(txns, opts) {
    opts = opts || {}; var every = opts.every || EVERY, a = ordered(txns), cov = coverage(a);
    if (!cov.complete) return { checkpoints: [], coverage: cov, reason: 'incomplete' };
    var balances = Object.create(null), out = [];
    for (var i = 0; i < a.length; i++) {
      var t = a[i], before = balances[t.matCode];
      if (before == null) before = typeof t.balance === 'number' ? t.balance - t.delta : 0;
      var next = before + Number(t.delta || 0);
      if (typeof t.balance === 'number' && Math.abs(next - t.balance) > 1e-9) return { checkpoints: [], coverage: cov, reason: 'mismatch', badSeq: t.seq };
      balances[t.matCode] = next;
      if ((i + 1) % every === 0) out.push({ key: 'checkpoint-' + t.seq, seq: t.seq, balances: JSON.parse(JSON.stringify(balances)), coverage: { minSeq: 1, maxSeq: t.seq, complete: true }, version: 1 });
    }
    return { checkpoints: out, coverage: cov, reason: null };
  }
  function latestUsable(checkpoints, txns) {
    var cov = coverage(txns); if (!cov.complete) return null;
    return (checkpoints || []).filter(c => c && c.version === 1 && c.coverage && c.coverage.complete && c.seq <= cov.maxSeq).sort((a, b) => b.seq - a.seq)[0] || null;
  }
  return { EVERY: EVERY, coverage: coverage, build: build, latestUsable: latestUsable };
});
