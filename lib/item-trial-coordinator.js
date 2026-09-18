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
      const rows = await repository.allOperations();
      const same = rows.filter(r => r.code === command.opId);
      if (same.length > 1) return { conflict: true };
      if (same.length === 1) {
        return { existing: true, conflict: same[0].requestHash !== command.requestHash };
      }
      const unsettled = rows.filter(r => ['PREPARED', 'REPAIR_REQUIRED'].includes(r.phase));
      if (unsettled.length) return { acquired: false, existing: false, unsettled };
      prepared.set(command.opId, structuredClone(command));
      return { acquired: true };
    },
    async get(opId) {
      const rows = await repository.operations(opId);
      if (rows.length > 1) return { conflict: true, result: { code: opId, phase: 'REPAIR_REQUIRED', error: '重复操作ID，试运行暂停' } };
      if (rows.length === 1) {
        const row = rows[0];
        return { ...prepared.get(opId), operator: row.operator || 'trial', operation: row.phase === 'PREPARED' ? row : undefined,
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
