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
    var balances = Object.create(null), out = [], deltaSum = 0, balanceSum = 0;
    for (var i = 0; i < a.length; i++) {
      var t = a[i], before = balances[t.matCode];
      if (before == null) before = typeof t.balance === 'number' ? t.balance - t.delta : 0;
      var next = before + Number(t.delta || 0);
      if (typeof t.balance === 'number' && Math.abs(next - t.balance) > 1e-9) return { checkpoints: [], coverage: cov, reason: 'mismatch', badSeq: t.seq };
      balances[t.matCode] = next;
      deltaSum += Number(t.delta || 0);
      if (typeof t.balance === 'number') balanceSum += t.balance;
      /* prefixCount / deltaSum 是**前缀指纹**：消费方靠它判断「这份 checkpoint 之后
         前缀有没有被人改过」。没有指纹就会出现下面这种静默错误：
         有人在飞书里直接改了一条旧流水的「变动」→ 前缀其实变了，
         但 checkpoint 还"看起来"可用 → 从它起算的重放**跳过那段被改坏的数据**，
         于是校验报「一切正常」。账本是只增不改的，但这个假设必须被验证而不是被信任。 */
      if ((i + 1) % every === 0) out.push({
        key: 'checkpoint-' + t.seq, seq: t.seq, balances: JSON.parse(JSON.stringify(balances)),
        prefixCount: i + 1, deltaSum: Math.round(deltaSum * 1e6) / 1e6,
        balanceSum: Math.round(balanceSum * 1e6) / 1e6,
        coverage: { minSeq: 1, maxSeq: t.seq, complete: true }, version: 2
      });
    }
    return { checkpoints: out, coverage: cov, reason: null };
  }
  /**
   * 挑一份**可安全使用**的 checkpoint。
   * 前置：全局覆盖完整（有缺口/重复就一律不用 —— 从缺口的账本上起算毫无意义）。
   * 并且必须验证前缀指纹：条数与变动之和都要与当下完全一致。
   * 任何对不上都返回 null，让调用方退回全量重放（慢但正确）。
   */
  function latestUsable(checkpoints, txns) {
    var cov = coverage(txns); if (!cov.complete) return null;
    var a = ordered(txns);
    var cands = (checkpoints || [])
      .filter(c => c && (c.version === 1 || c.version === 2) && c.coverage && c.coverage.complete
        && Number.isFinite(Number(c.seq)) && Number(c.seq) <= cov.maxSeq)
      .sort((x, y) => Number(y.seq) - Number(x.seq));
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var prefix = a.filter(t => Number(t.seq) <= Number(c.seq));
      if (c.prefixCount != null && prefix.length !== c.prefixCount) continue;      // 前缀条数变了
      if (c.deltaSum != null) {
        var sum = 0;
        for (var j = 0; j < prefix.length; j++) sum += Number(prefix[j].delta || 0);
        if (Math.abs(Math.round(sum * 1e6) / 1e6 - c.deltaSum) > 1e-9) continue;    // 前缀里的值被改过
      }
      return c;
    }
    return null;
  }
  return { EVERY: EVERY, coverage: coverage, build: build, latestUsable: latestUsable };
});
