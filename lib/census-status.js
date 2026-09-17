(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CensusStatus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clone(v) { return JSON.parse(JSON.stringify(v || {})); }

  /**
   * 把一次 census 结果按表合并进持久状态；未扫描的表与不完整/失败表的 pending 均保留。
   */
  function mergeStatus(status, table, result) {
    status = clone(status || { tables: {}, lastRunAt: 0 });
    status.tables = status.tables || {};
    var prev = status.tables[table] || {};
    result = result || {};
    var next = Object.assign({}, prev, {
      complete: result.complete,
      scanned: result.scanned,
      total: result.total,
      blankKeys: result.blankKeys || 0,
      error: result.error || '',
      lastCheckedAt: result.lastCheckedAt || Date.now()
    });
    if (result.complete) next.lastCompleteAt = result.lastCompleteAt || next.lastCheckedAt;
    if (result.complete && Array.isArray(result.pendingKeys)) {
      next.pendingKeys = result.pendingKeys.slice();
      next.reason = result.reason || '';
    } else {
      next.pendingKeys = Array.isArray(prev.pendingKeys) ? prev.pendingKeys.slice() : [];
      next.reason = prev.reason || result.reason || '';
    }
    status.tables[table] = next;
    status.lastRunAt = result.lastRunAt || Date.now();
    return status;
  }

  function pendingFromStatus(status) {
    var out = {};
    Object.entries((status && status.tables) || {}).forEach(function (entry) {
      var k = entry[0], v = entry[1] || {};
      if (Array.isArray(v.pendingKeys) && v.pendingKeys.length) out[k] = { keys: v.pendingKeys.slice(), reason: v.reason || 'needs-human' };
    });
    return out;
  }

  return { mergeStatus: mergeStatus, pendingFromStatus: pendingFromStatus };
});
