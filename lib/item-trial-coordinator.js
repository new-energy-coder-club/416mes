const U = require('./unique-items');
'use strict';
/**
 * 飞书试运行协调器：不提供跨Vercel实例原子锁，只把操作表作为共享可见凭据。
 * 适用于单操作员、同一时刻一条命令的现场试运行；不能宣称严格并发安全。
 */
function create(repository) {
  const prepared = new Map();
  return {
    contract: 'feishu-trial-best-effort-v1',
    verified: false,
    async claim(command) {
      /* 2.70.0 M1（并发方案）：两条精确查询替代全表扫——
         ① 重放检测：operations(opId)（searchRecords 精确查，需看到已完结行）
         ② 冲突裁决：unsettledOperations（状态过滤，只看未决行）
         表增长到几千行后两者都保持 1-2 次请求。 */
      const same = repository.operations
        ? await repository.operations(command.opId)
        : (await repository.allOperations()).filter(r => r.code === command.opId);   /* 测试 stub 无精确查询时回退 */
      if (same.length > 1) return { conflict: true };
      if (same.length === 1) {
        return { existing: true, conflict: same[0].requestHash !== command.requestHash };
      }
      const rows = repository.unsettledOperations
        ? await repository.unsettledOperations()
        : (await repository.allOperations()).filter(r => ['PREPARED', 'REPAIR_REQUIRED'].includes(r.phase));
      /* 2.63.0 Phase D（实体级分桶）：REPAIR_REQUIRED 仍全局屏障（一致性存疑）；
         PREPARED 行解析实体键集，与本命令键集相交才互斥——不同实体可并行，
         写前 TRIAL_PRECONDITION_CHANGED 重计划检查（item-operation.js）仍是最终安全网。 */
      const myKeys = U.entityKeysOf(command.request);
      /* P2b（用户实测：单设备也报并发冲突、命令提交不了）：陈旧 PREPARED 过期放行——
         serverless 单次执行上限 60s，10 分钟前的 PREPARED 行不可能是「在途命令」
         （进程早已消亡），只会把后续一切命令堵死。实体正确性仍由写前重计划兜底。
         REPAIR_REQUIRED 保持屏障，但 settle 收口通道已可达（get 对 REPAIR_REQUIRED 暴露 operation）。 */
      const STALE_MS = 10 * 60 * 1000;
      const now = Date.now();
      const unsettled = rows.filter(r => ['PREPARED', 'REPAIR_REQUIRED'].includes(r.phase));
      const blocking = unsettled.filter(r => {
        if (r.phase === 'REPAIR_REQUIRED') return true;
        const ts = Date.parse(r.requestedAt || '');
        if (Number.isFinite(ts) && now - ts > STALE_MS) return false;
        const other = U.entityKeysOf(r.request || {});
        if (!other.size || !myKeys.size) return true;   // 解析不出键集时保守互斥（仅限未过期行）
        for (const k of other) if (myKeys.has(k)) return true;
        return false;
      });
      if (blocking.length) return { acquired: false, existing: false, unsettled: blocking };
      prepared.set(command.opId, structuredClone(command));
      return { acquired: true };
    },
    async get(opId) {
      const rows = await repository.operations(opId);
      if (rows.length > 1) return { conflict: true, result: { code: opId, phase: 'REPAIR_REQUIRED', error: '重复操作ID，试运行暂停' } };
      if (rows.length === 1) {
        const row = rows[0];
        /* P2c：REPAIR_REQUIRED 行也要向 settle 暴露 operation——否则 2.52.1 路径把日志行写成
           REPAIR_REQUIRED 后（跨实例、内存 prepared 已丢），人工收口永远 UNRESOLVED_OPERATION_BARRIER，
           屏障成为死锁（settle 自身有 readAfter 核对，安全性不受影响）。 */
        return { ...prepared.get(opId), operator: row.operator || 'trial',
          operation: ['PREPARED', 'REPAIR_REQUIRED'].includes(row.phase) ? row : undefined,
          result: ['APPLIED', 'REJECTED'].includes(row.phase) ? row : undefined };
      }
      return prepared.get(opId);
    },
    async prepare(opId, operation) { prepared.set(opId, { ...(prepared.get(opId) || {}), operation: structuredClone(operation) }); },
    async progress() {},
    async finish(opId, result) { prepared.set(opId, { ...(prepared.get(opId) || {}), result: structuredClone(result) }); },
    async uncertain(opId, error) { prepared.set(opId, { ...(prepared.get(opId) || {}), error: String(error) }); },
    async claimRecovery() { return false; }
  };
}
module.exports = { create };
