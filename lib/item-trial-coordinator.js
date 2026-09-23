'use strict';
/**
 * 飞书试运行协调器（v3.3.0 拆锁重构）：不再做任何互斥裁决——
 * 「同项先确认者赢、后到者作废」的正确性由三层独立机制保证（与互斥无关）：
 *   ① opId 幂等 + requestHash 冲突（本文件 claim 的全部剩余职责）；
 *   ② expected 版本前置 + 写前重计划 TRIAL_PRECONDITION_CHANGED（item-operation.js）；
 *   ③ 写后回读 SNAPSHOT_READBACK_MISMATCH + 过期僵尸自动三态收口（item-operation.js）。
 * 旧版互斥（未决行阻塞 + 写前 conflictsWith/iAmLoser 输家裁决）已删除：
 * 它防的「多设备同实体竞争」在需求书范围外（416MES开发需求书.md:37），
 * 而它制造的幻影屏障/僵尸行/虚假并发拒绝恰是历次用户实测问题的全部来源。
 */
function create(repository) {
  const prepared = new Map();
  return {
    contract: 'feishu-trial-best-effort-v1',
    verified: false,
    async claim(command) {
      /* 重放检测：同 opId 已有日志行 → 幂等回读既有结果（不同载荷 → 冲突）。
         searchRecords 精确查（表增长后仍 1-2 次请求）。 */
      const same = repository.operations
        ? await repository.operations(command.opId)
        : (await repository.allOperations()).filter(r => r.code === command.opId);   /* 测试 stub 无精确查询时回退 */
      if (same.length > 1) return { conflict: true };
      if (same.length === 1) {
        return { existing: true, conflict: same[0].requestHash !== command.requestHash };
      }
      prepared.set(command.opId, structuredClone(command));
      return { acquired: true };
    },
    async get(opId) {
      const rows = await repository.operations(opId);
      if (rows.length > 1) return { conflict: true, result: { code: opId, phase: 'REPAIR_REQUIRED', error: '重复操作ID，试运行暂停' } };
      if (rows.length === 1) {
        const row = rows[0];
        /* 未决行（PREPARED/REPAIR_REQUIRED）也暴露 operation——settle 人工收口与
           过期僵尸自动收口（item-operation.js autoSettleStalePrepared）都靠它定位。 */
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
