/*!
 * lib/incremental.js — Phase 2 增量协议的纯逻辑（UMD，无网络、无 DOM）
 *
 * 为什么单独拆出来：增量最容易错的地方不是请求怎么写，而是
 *   ① 水位怎么推进（同一毫秒有并列记录时会漏）
 *   ② 翻页什么时候可以停（停早了漏数据，停晚了一直翻）
 *   ③ 删除什么时候允许判（一次半截扫描就能清空现场台账）
 * 这三件事都是纯函数，必须能在 Node 里穷举验证，而不是靠真机撞。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MesIncremental = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 水位初值：ts=0 表示「什么都没有」，因此任何记录都算新 */
  function createWatermark() { return { ts: 0, seen: [] }; }

  function tsOf(rec, tsField) {
    if (!rec) return 0;
    const v = rec[tsField];
    const n = typeof v === 'number' ? v : (v && v.value != null ? Number(v.value) : NaN);
    return Number.isFinite(n) ? n : 0;
  }
  function idOf(rec, idField) {
    if (!rec) return '';
    const v = rec[idField];
    return v == null ? '' : String(v);
  }

  /**
   * 这条记录是否比水位「新」。
   *
   * 关键：**同一毫秒内不能只用时间戳判断**。飞书系统字段是毫秒精度，
   * 批量导入时大量记录会落在同一个毫秒上；如果只比 ts，同一毫秒里
   * 后面几条会被永久漏掉（水位已经推到那毫秒了）。
   * 所以水位是「时间戳 + 该毫秒内已见 id 集合」。
   */
  function isRecordNewer(rec, tsField, idField, wm) {
    const t = tsOf(rec, tsField);
    if (t > wm.ts) return true;
    if (t < wm.ts) return false;
    return (wm.seen || []).indexOf(idOf(rec, idField)) < 0;
  }

  /** 从一批记录里筛出「比水位新」的（保持原顺序） */
  function filterNewer(records, tsField, idField, wm) {
    return (records || []).filter(r => isRecordNewer(r, tsField, idField, wm));
  }

  /**
   * 倒序翻页能否停下。
   *
   * 服务端按「最后更新时间 desc」返回，因此页面内 ts 单调不增。
   * 两个停止条件，满足任一即可：
   *   ① **短页**：返回条数 < 请求的 pageSize —— 服务端已经没有更多行了
   *      （不加这一条就会为了确认「到底还有没有」多打一次空请求）
   *   ② **整页都早于水位**：最后一条也严格早于水位，说明这页里没有任何新数据。
   *      用「最后一条」而不是「任意一条」，是为了避免同毫秒并列时把边界那几条切掉。
   */
  function shouldStopPaging(page, tsField, wm, pageSize) {
    if (!Array.isArray(page) || page.length === 0) return true;
    if (pageSize && page.length < pageSize) return true;
    return tsOf(page[page.length - 1], tsField) < wm.ts;
  }

  /**
   * 推进水位。
   *
   * 取这批记录里的最大 ts；同一毫秒的 id 全部记下来。
   * 只有当最大 ts 严格大于原水位时才丢弃旧的 seen —— 否则保留并集，
   * 因为同一毫秒的记录可能分两次拉回来。
   */
  function advanceWatermark(wm, records, tsField, idField) {
    wm = wm || createWatermark();
    let ts = wm.ts || 0;
    let advanced = false;
    (records || []).forEach(r => { const t = tsOf(r, tsField); if (t > ts) { ts = t; advanced = true; } });
    const seen = new Set(advanced ? [] : (wm.seen || []));
    (records || []).forEach(r => { if (tsOf(r, tsField) === ts) { const id = idOf(r, idField); if (id) seen.add(id); } });
    return { ts: ts, seen: Array.from(seen) };
  }

  /**
   * 键集合对账 → 删除裁定（方案 §五 的三重闸门）。
   *
   * @param {string[]} prevKeys 上次同步时飞书持有的键（__syncedKeys）
   * @param {string[]} nextKeys 本次完整扫描拿到的键
   * @param {object} opts {
   *   complete,                // 分页是否完整成功且收到数 == total；false 时**绝不判删**
   *   tableId,
   *   ratio, abs,              // 阈值：超过任一转人工确认
   *   ledgerConfirmed,         // 主数据是否已连续两次完整 census 都缺
   *   humanOnly,               // 只能人工裁决（已执行/已取消工单）
   * }
   */
  function censusDecision(prevKeys, nextKeys, opts) {
    opts = opts || {};
    const tableId = opts.tableId || '';
    const ratio = opts.ratio == null ? 0.05 : opts.ratio;
    const abs = opts.abs == null ? 50 : opts.abs;

    // 闸门 4：流水是 append-only 台账，记录消失应报「数据不完整」，不是静默删本地
    if (tableId === 'transactions') {
      return { deletions: [], toConfirm: [], reason: 'append-only-excluded', missing: [] };
    }
    // 闸门 1：分页必须完整；任一页失败/超时/半扫 → 放弃判定
    if (!opts.complete) {
      return { deletions: [], toConfirm: [], reason: 'census-incomplete', missing: [] };
    }
    const prev = new Set((prevKeys || []).map(String));
    const next = new Set((nextKeys || []).map(String));
    const missing = [];
    prev.forEach(k => { if (!next.has(k)) missing.push(k); });
    if (!missing.length) return { deletions: [], toConfirm: [], reason: 'none', missing: [] };

    // 闸门 5：已执行 / 已取消的工单记录消失，必须人工裁决 ——
    // 这类记录背后是已经发生的库存变动，自动删掉会让台账失去凭据。
    if (opts.humanOnly) {
      return { deletions: [], toConfirm: missing, reason: 'needs-human', missing };
    }
    // 闸门 2：阈值保护
    const threshold = Math.max(abs, Math.ceil(prev.size * ratio));
    if (missing.length > threshold) {
      return { deletions: [], toConfirm: missing, reason: 'over-threshold', threshold, missing };
    }
    // 闸门 3：主数据要连续两次完整 census 都缺才自动确认
    if (!opts.ledgerConfirmed) {
      return { deletions: [], toConfirm: missing, reason: 'need-second-census', threshold, missing };
    }
    return { deletions: missing, toConfirm: [], reason: 'ok', threshold, missing };
  }

  /**
   * 闸门 3 的判据：这次缺的键，是否「上一次完整 census 也缺」。
   * 只认交集 —— 上一次缺 A、这次缺 B，说明是两次不同的抖动，不能确认删除。
   */
  function secondCensusConfirms(prevMissing, missing) {
    const p = new Set((prevMissing || []).map(String));
    const m = (missing || []).map(String);
    if (!m.length || !p.size) return false;
    return m.every(k => p.has(k));
  }

  /**
   * 变更探测的判定：探测结果比水位新，或条数变了（有增/删）→ 需要拉取。
   */
  function probeSaysChanged(probe, wm) {
    if (!probe) return false;
    const latest = Number(probe.latest || 0);
    if (latest > (wm.ts || 0)) return true;
    if (probe.total != null && wm.total != null && Number(probe.total) !== Number(wm.total)) return true;
    return false;
  }

  return {
    createWatermark: createWatermark,
    tsOf: tsOf, idOf: idOf,
    isRecordNewer: isRecordNewer,
    filterNewer: filterNewer,
    shouldStopPaging: shouldStopPaging,
    advanceWatermark: advanceWatermark,
    censusDecision: censusDecision,
    secondCensusConfirms: secondCensusConfirms,
    probeSaysChanged: probeSaysChanged
  };
});
