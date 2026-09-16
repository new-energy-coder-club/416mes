/*
 * lib/replay-audit-worker.js — 账本回放 Worker
 *
 * 协议：
 *   in  { requestId, state, options }
 *   out { requestId, ok:true, result } | { requestId, ok:false, error }
 *
 * Worker 不接收 IDB handle（不可克隆）；主线程从 IDB 读出纯数据后再投递。
 * 不支持 Worker 的环境由主线程调用 MesCore.replayAudit，结果结构完全一致。
 */
'use strict';
try { importScripts('../mes-core.js'); } catch (_) { /* Node 可只做语法检查 */ }
self.onmessage = function (ev) {
  var p = ev.data || {};
  try {
    if (!self.MesCore || typeof self.MesCore.replayAudit !== 'function') throw new Error('MesCore.replayAudit 不可用');
    var result = self.MesCore.replayAudit(p.state || { transactions: [] }, p.options || {});
    self.postMessage({ requestId: p.requestId, ok: true, result: result });
  } catch (e) {
    self.postMessage({ requestId: p.requestId, ok: false, error: String((e && e.message) || e) });
  }
};
