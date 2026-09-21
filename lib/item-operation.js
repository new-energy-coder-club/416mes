'use strict';
const crypto = require('node:crypto');
const U = require('./unique-items');
const ItemLink = require('./item-link');
const { canonical } = require('./item-persistence');
const hash = request => crypto.createHash('sha256').update(canonical(request)).digest('hex');
function fail(code, status = 409) { const e = new Error(code); e.status = status; throw e; }
/** coordinator must persist global ownership, immutable commands and barriers BEFORE external writes.
 * No production memory implementation is provided. A claim never expires into permission to write.
 */
function create({ repository, coordinator, authenticate, enabled = false, mode = 'strict' }) {
  async function auth(req) {
    if (mode === 'feishu-trial' && !authenticate) return { id: 'trial-unverified', roles: ['admin', 'operator'], unverified: true };
    const actor = authenticate && await authenticate(req); if (!actor || !actor.id) fail('UNAUTHENTICATED', 401); return actor;
  }
  function available() {
    const strictReady = coordinator && coordinator.contract === 'durable-global-barrier-v1' && coordinator.verified;
    const trialReady = mode === 'feishu-trial' && coordinator && coordinator.contract === 'feishu-trial-best-effort-v1';
    if (!enabled || !(strictReady || trialReady)) fail('ITM_COORDINATION_UNAVAILABLE', 503);
  }
  async function lookup(opId, actor) {
    const accepted = await coordinator.get(opId);
    if (!Array.isArray(actor.roles) || !actor.roles.some(r => ['operator', 'admin', 'service'].includes(r))) fail('FORBIDDEN', 403);
    if (accepted && accepted.operator !== actor.id && !actor.roles.some(r => ['admin', 'service'].includes(r))) fail('FORBIDDEN', 403);
    if (accepted && accepted.result) return accepted.result;
    return accepted ? { code: opId, phase: 'REPAIR_REQUIRED', error: '原命令未决，不能自动重发' } : { code: opId, phase: 'UNKNOWN', error: '未查到不代表未执行' };
  }
  async function post(req, request) {
    const actor = await auth(req); available();
    if (!request || request.schemaVersion !== 1 || typeof request.opId !== 'string' || !request.opId || request.opId.length > 160) fail('INVALID_REQUEST', 400);
    if (!actor.roles || !actor.roles.some(r => ['admin', 'operator'].includes(r))) fail('FORBIDDEN', 403);
    /* 服务端发号前置块（定稿 §3.1）：registerItem 不带码时在 hash/claim 之前分配物品码。
     * 必须在本层编排（而非 unique-items.plan）——plan 在 claim 之后，改码会使 requestHash 与日志脱节。 */
    if (request.kind === 'registerItem' && !(request.entity && request.entity.code)) {
      // 幂等短路（P5）：同 opId 超时重试直接返回原受理结果，绝不重新 max+1 发号
      const accepted = await coordinator.get(request.opId);
      if (accepted) return lookup(request.opId, actor);
      const entity = request.entity;
      if (!entity || typeof entity !== 'object') fail('INVALID_REQUEST', 400);
      const category = entity.category;
      if (ItemLink.catIndex(String(category == null ? '' : category).trim().toUpperCase()) === null) fail('BAD_CATEGORY', 400);
      const state0 = await repository.snapshot();
      try {
        entity.code = ItemLink.nextItemCode(state0.items, category);
      } catch (e) {
        if (e && e.code === 'SERIAL_EXHAUSTED') fail('SERIAL_EXHAUSTED', 409);
        throw e;
      }
    } else if (request.kind === 'registerItem' && request.entity && typeof request.entity.code === 'string') {
      // 手动码（P3）：命中结构化格式必须规范形，且不得与快照同 (cat,serial) 异写法撞车
      const manual = request.entity.code;
      const parsed = ItemLink.parseItemCode(manual);
      if (parsed) {
        if (ItemLink.toItemCode(parsed) !== manual) fail('NON_CANONICAL_ITEM_CODE', 400);
        const state0 = await repository.snapshot();
        const clash = (state0.items || []).some(r => {
          if (!r || r.code === manual) return false; // 同码精确撞车留给 plan 的 CODE_ALREADY_REGISTERED
          const p = ItemLink.parseItemCode(r.code);
          return p && p.cat === parsed.cat && p.serial === parsed.serial;
        });
        if (clash) fail('DUPLICATE_SHORTLINK_IDENTITY', 409);
      }
    }
    const frozen = JSON.parse(JSON.stringify(request));
    if (mode === 'feishu-trial') {
      try { await repository.validateSchema(); } catch (e) { fail('试运行表结构尚未补齐：' + e.message, 503); }
    }
    const digest = hash(frozen);
    const claim = await coordinator.claim({ opId: frozen.opId, requestHash: digest, request: frozen, operator: actor.id });
    if (claim.conflict) fail('OP_ID_PAYLOAD_CONFLICT');
    if (!claim.acquired) {
      if (claim.existing) return lookup(frozen.opId, actor);
      /* 2.62.0 Phase C：屏障错误附带头一条未决命令的信息，用户知道在等谁 */
      const firstUnsettled = (await repository.allOperations())
        .find(o => ['PREPARED', 'REPAIR_REQUIRED'].includes(o.phase));
      const who = firstUnsettled ? '（未决：' + (firstUnsettled.kind || '?') + ' @ ' +
        String(firstUnsettled.requestedAt || '').slice(11, 19) + '）' : '';
      fail('UNRESOLVED_OPERATION_BARRIER' + who);
    }
    let sideEffectsPossible = false;
    try {
      /* 2.69.0 M2（调用数减半）：trial 模式的 validateSchema 已在 claim 前做过（不重复）；
         strict 模式仍需在此校验（它没有前置检查点）。Schema.inspect 用 listFieldsCached 后开销大降。 */
      if (mode !== 'feishu-trial') await repository.validateSchema();
      /* 2.69.0 M2：operationExists 用 searchRecords 精确查操作ID（1 次请求），
         替代 operations(opId) 的全表扫（N 页）。trial 模式下 preWrite 的
         allOperations 仍需全量（冲突裁决要看全部未决行）。 */
      const exists = repository.operationExists
        ? await repository.operationExists(frozen.opId)
        : (await repository.operations(frozen.opId)).length > 0;   /* 测试 stub 无 search 能力时回退 */
      if (exists) fail('UNEXPECTED_EXISTING_OPERATION');
      const state = await repository.snapshot(frozen);
      const plan = U.plan(state, frozen, actor);
      const operation = { ...plan, requestHash: digest, itemCode: frozen.itemCode || '', containerCode: frozen.containerCode || '', device: String(frozen.device || ''), requestedAt: new Date().toISOString(), progress: { step: 'prepared' } };
      // Persist intent before the first request: even a crash during log creation leaves a barrier.
      await coordinator.prepare(frozen.opId, operation);
      sideEffectsPossible = true;
      const recordId = await repository.prepare(operation);
      await coordinator.progress(frozen.opId, { recordId, step: 'log-created' });
      if (mode === 'feishu-trial') {
        /* 2.49.5（审计 Bug2）：trial 前置检查（并发屏障/前置变更/重计划）全部发生在实体写入之前，
           唯一副作用是这条日志行。此前这些失败被标 REPAIR_REQUIRED（未决）——未决行让 trial 协调器
           阻塞一切新命令，且 recover 三层恢复通道全部不可达，队列永久死锁。
           现改为终态 REJECTED（相位表允许 PREPARED→REJECTED）：日志行收口、不再产生屏障。 */
        let preWriteError = null;
        /* 2.70.0 M1：冲突裁决只看未决行（状态过滤查询，表增长后不再线性放大） */
        const visible = repository.unsettledOperations
          ? await repository.unsettledOperations()
          : await repository.allOperations();
        const myKeys = U.entityKeysOf(frozen);
        const conflictsWith = list => list.some(o => {
          if (o.code === frozen.opId || !['PREPARED', 'REPAIR_REQUIRED'].includes(o.phase)) return false;
          if (o.phase === 'REPAIR_REQUIRED') return true;
          const other = U.entityKeysOf(o.request || {});
          if (!other.size || !myKeys.size) return true;
          for (const k of other) if (myKeys.has(k)) return true;
          return false;
        });
        let conflictsVisible = conflictsWith(visible);
        /* 2.80.0 B3（稳定多并发）：确定性让位——冲突时按 (requestedAt, opId) 字典序定序，
           我是最小者（winner）立即继续；是 loser 则在预算内等 winner 达终态（而非对称互杀）。
           loser 等到放行后重计划必撞版本变化 → TRIAL_PRECONDITION_CHANGED → retryable 拒绝
           → 客户端安全重拉重建后必然成功（A3 错峰保证重试不再互撞）。 */
        if (conflictsVisible) {
          const myKey = String(operation.requestedAt || '') + '|' + String(frozen.opId || '');
          const iAmLoser = visible.some(o => {
            if (o.code === frozen.opId || !['PREPARED', 'REPAIR_REQUIRED'].includes(o.phase)) return false;
            const otherKey = String(o.requestedAt || '') + '|' + String(o.code || '');
            return otherKey < myKey;
          });
          if (iAmLoser) {
            const deadline = Date.now() + 20000;   /* 预算 20s：函数 60s 上限 - 本命令已耗时 - 安全垫 */
            while (Date.now() < deadline && conflictsVisible) {
              await new Promise(r2 => setTimeout(r2, 1500 + Math.floor(Math.random() * 1000)));
              const vis2 = repository.unsettledOperations ? await repository.unsettledOperations() : await repository.allOperations();
              conflictsVisible = conflictsWith(vis2);
            }
            /* 2.68.0（P0-2 修正）：预算耗尽仍冲突——显式拒绝（retryable，客户端错峰重建） */
            if (conflictsVisible) preWriteError = 'TRIAL_CONCURRENT_OPERATION_DETECTED';
          }
          /* winner 路径：立即继续——loser 的 PREPARED 行由 loser 自己的预检/重试收场 */
        }
        if (!preWriteError) {
          try {
            const currentPlan = U.plan(await repository.snapshot(frozen), frozen, actor);
            if (canonical(currentPlan.before) !== canonical(plan.before) || canonical(currentPlan.after) !== canonical(plan.after)) preWriteError = 'TRIAL_PRECONDITION_CHANGED';
          } catch (e) { preWriteError = 'TRIAL_PRECONDITION_CHANGED: ' + e.message; }
        }
        if (preWriteError) {
          const rejected = { code: frozen.opId, request: frozen, requestHash: digest, kind: frozen.kind, phase: 'REJECTED', operator: actor.id, error: preWriteError, requestedAt: operation.requestedAt, finishedAt: new Date().toISOString(), ...retryPolicyFor(preWriteError) };
          /* 2.52.1（k3 审计）：finalize 独立兜底——finish 失败如实降 REPAIR_REQUIRED，
             但绝不让它落进外层 catch 把日志行改写成 REPAIR_REQUIRED（终态倒退=屏障复活）。 */
          try { await repository.finish(recordId, rejected); }
          catch (e2) { return { code: frozen.opId, request: frozen, phase: 'REPAIR_REQUIRED', error: '拒绝结果未能保存，请查询原操作ID；' + e2.message }; }
          try { await coordinator.finish(frozen.opId, rejected); } catch (_) { }
          return rejected;
        }
      }
      await repository.apply(operation.after, operation);
      const actual = await repository.readAfter(operation.after);
      if (canonical(actual) !== canonical(operation.after)) fail('SNAPSHOT_READBACK_MISMATCH');
      const result = { ...operation, phase: 'APPLIED', finishedAt: new Date().toISOString(), progress: { recordId, step: 'verified' } };
      await repository.finish(recordId, result);
      await coordinator.finish(frozen.opId, result);
      return result;
    } catch (e) {
      if (sideEffectsPossible) {
        if (mode === 'feishu-trial') {
          try {
            const rows = await repository.operations(frozen.opId);
            if (rows.length === 1) {
              /* 2.52.1（k3 审计）：日志行已是终态（REJECTED/APPLIED）时不覆盖为 REPAIR_REQUIRED——
                 终态倒退会让相位表判 invalid-operation-phase 并重新引入未决行屏障。 */
              if (['REJECTED', 'APPLIED'].includes(rows[0].phase)) return rows[0];
              await repository.finish(rows[0].recordId, { ...rows[0], phase: 'REPAIR_REQUIRED', finishedAt: new Date().toISOString(), error: String(e.message) });
            }
          } catch (_) { /* Never retry entity writes on uncertain transport. */ }
        }
        await coordinator.uncertain(frozen.opId, String(e.message));
        return { code: frozen.opId, request: frozen, phase: 'REPAIR_REQUIRED', error: String(e.message) };
      }
      // No write was issued, but a preexisting log is not evidence of no effects.
      if (e.message === 'UNEXPECTED_EXISTING_OPERATION') {
        await coordinator.uncertain(frozen.opId, e.message);
        return { code: frozen.opId, phase: 'REPAIR_REQUIRED', error: e.message };
      }
      const result = { code: frozen.opId, request: frozen, requestHash: digest, kind: frozen.kind, phase: 'REJECTED', operator: actor.id, error: e.message, requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...retryPolicyFor(e.message) };
      if (mode === 'feishu-trial') {
        try { await repository.prepare(result); } catch (_) { return { code: frozen.opId, request: frozen, phase: 'REPAIR_REQUIRED', error: '拒绝结果未能保存，请查询原操作ID；' + e.message }; }
      }
      await coordinator.finish(frozen.opId, result); return result;
    }
  }
  async function get(req, opId) {
    const actor = await auth(req); available();
    if (typeof opId !== 'string' || !opId) fail('MISSING_OP_ID', 400);
    return lookup(opId, actor); // GET is strictly read-only, never repair as a side effect.
  }
  async function recover(req, opId) {
    const actor = await auth(req); available(); if (!Array.isArray(actor.roles) || !actor.roles.includes('service')) fail('FORBIDDEN', 403);
    const accepted = await coordinator.get(opId);
    if (!accepted || !accepted.operation) fail('UNRESOLVED_OPERATION_BARRIER');
    if (accepted.result) return accepted.result;
    // Recovery needs an atomic durable recovery claim; absence is fail-closed.
    if (!coordinator.claimRecovery || !await coordinator.claimRecovery(opId)) fail('RECOVERY_BUSY');
    const operation = accepted.operation;
    try {
      const logs = await repository.operations(opId);
      if (logs.length !== 1 || logs[0].requestHash !== operation.requestHash) fail('LOG_AMBIGUOUS');
      const actual = await repository.readAfter(operation.after);
      if (canonical(actual) !== canonical(operation.after)) fail('UNKNOWN_REQUEST_MAY_STILL_ARRIVE');
      // Never replay apply(): only finalize a fully matched after snapshot.
      const result = { ...operation, phase: 'APPLIED', finishedAt: new Date().toISOString() };
      await repository.finish(logs[0].recordId, result); await coordinator.finish(opId, result); return result;
    } catch (e) { await coordinator.uncertain(opId, e.message); return { code: opId, phase: 'REPAIR_REQUIRED', error: e.message }; }
  }
  /* 2.70.0 M3（并发方案）：人工收口——admin 对卡在 PREPARED/REPAIR_REQUIRED 的操作，
     核对实体实际状态后收口：状态与目标一致→APPLIED；不一致→REJECTED（如实标记）。
     与 recover 的区别：recover 要求 service 角色 + durable 认领（生产事故通道）；
     settle 是 admin 的日常治理工具（trial 模式屏障的出口）。 */
  async function settle(req, opId) {
    const actor = await auth(req); available();
    if (!Array.isArray(actor.roles) || !actor.roles.includes('admin')) fail('FORBIDDEN', 403);
    const accepted = await coordinator.get(opId);
    if (!accepted || !accepted.operation) fail('UNRESOLVED_OPERATION_BARRIER');
    if (accepted.result) return accepted.result;
    const operation = accepted.operation;
    try {
      const logs = await repository.operations(opId);
      if (logs.length !== 1 || logs[0].requestHash !== operation.requestHash) fail('LOG_AMBIGUOUS');
      const actual = await repository.readAfter(operation.after);
      const matched = canonical(actual) === canonical(operation.after);
      const result = { ...operation, phase: matched ? 'APPLIED' : 'REJECTED',
        error: matched ? undefined : '人工收口：实体实际状态与目标快照不一致（可能已被其他操作覆盖），命令标记为未生效',
        finishedAt: new Date().toISOString() };
      await repository.finish(logs[0].recordId, result); await coordinator.finish(opId, result);
      return result;
    } catch (e) { await coordinator.uncertain(opId, e.message); return { code: opId, phase: 'REPAIR_REQUIRED', error: e.message }; }
  }
  return { post, get, recover, settle, mode };
}
function retryPolicyFor(errText) {
  /* 2.80.0 B2（稳定多并发）：重试规范协议化——REJECTED 带结构化字段，
     客户端读字段而非正则匹配错误文本（旧客户端缺字段时回退正则，兼容）。 */
  const t = String(errText || '');
  const transient = /TRIAL_CONCURRENT|UNRESOLVED_OPERATION_BARRIER|VERSION_CONFLICT|TRIAL_PRECONDITION_CHANGED/.test(t);
  return transient
    ? { retryable: true, newOpIdRequired: true, retryAfterMs: 1500, policy: { maxAuto: 8, backoffMs: [1500, 10000, 20000, 30000, 40000, 50000, 60000, 70000], strategy: 'device-hash-slot' } }
    : { retryable: false, newOpIdRequired: false, retryAfterMs: 0, policy: { maxAuto: 0, backoffMs: [], strategy: 'manual' } };
}
module.exports = { create, hash };
