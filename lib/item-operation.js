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
function create({ repository, coordinator, authenticate, enabled = false, mode = 'strict', feishuMetrics = null }) {
  /* v3.12.0 操作人身份（用户拍板「每成员一身份、右上角直接切换、不做身份验证」）：
     试运行模式原先一律记 `trial-unverified`，右上角选中的成员根本进不了操作日志。
     现在允许客户端用 **X-416mes-Operator header** 声明身份，服务端据此记录 operator。

     ⚠️ 为什么用 header 而不是 request 字段：
       `digest = hash(frozen)`（:106）会把 **整个 request** 算进 requestHash，任何新字段都会让
       「同 opId 重放」因 payload 不一致而 OP_ID_PAYLOAD_CONFLICT，直接破坏幂等重试
       （客户端超时重提是常态）。header 不在 request 主体里，天然不影响幂等。

     ⚠️ 安全性：这是**声明式**身份（无密钥校验），用途是「谁在页面上按的」这一业务留痕，
     不是访问控制。同源标记 X-416mes-Same-Origin 仍是唯一网关（api 层已校验）。
     真实分权仍走 ITM_OPERATOR_TOKENS（api/feishu/item-operation.js）。 */
  /* v3.13.4（发现 C）：写前重计划的 before/after 比对必须**顺序无关**。
     plan 的 before/after 数组顺序继承 state.items 遍历顺序，而 repository.snapshot()
     走飞书 listRecords（无 orderBy 保证）——两次快照顺序漂移会让
     canonical 字节串不等，把「实质无变」误报成 TRIAL_PRECONDITION_CHANGED（而重试新 opId 仍然会撞同样的底。
     固化小底：按主键（itemCode/container/code）排序后比对，只看实质内容是否变化。 */
  function stableKey(row) {
    return String((row && (row.itemCode || row.code || row.containerCode || row.entityCode)) || '');
  }
  function normalizeSnapshot(arr) {
    const list = Array.isArray(arr) ? arr.slice() : [];
    return list
      .slice()
      .sort((a, b) => (stableKey(a) < stableKey(b) ? -1 : stableKey(a) > stableKey(b) ? 1 : 0));
  }
  function snapshotChanged(a, b) {
    return canonical(normalizeSnapshot(a)) !== canonical(normalizeSnapshot(b));
  }
  const OPERATOR_HEADER = 'x-416mes-operator';
  const DEVICE_HEADER = 'x-416mes-device';
  const OPERATOR_MAX = 80;
  const DEVICE_MAX = 64;
  /* v3.13.1（BUG-11/12 修复）：device 也改走 header。
     原先 v3.12.0 是在 enqueue() 里把 device 补进 request 副本 —— 结果「落库的那份有 device、
     提交/回执的那份没有」，`item-persistence.js:142` 的 canonical 一致性校验直接判
     RESULT_REQUEST_MISMATCH，导致**工单执行成功后本地不记账**（BUG-10/12）。
     device 本来就不参与任何业务判定（域层 grep 零命中），走 header 与 operator 同思路：
     不进 request 主体 → 不影响 requestHash、也不影响回执一致性校验。 */
  function declaredDevice(req) {
    try {
      const raw = req && req.headers ? (req.headers[DEVICE_HEADER] || req.headers['X-416mes-Device']) : '';
      const v = Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
      const s = v.replace(/[\r\n\t]/g, '').trim().slice(0, DEVICE_MAX);
      return /^[A-Za-z0-9 _\-.]+$/.test(s) ? s : '';
    } catch (_) { return ''; }
  }
  function declaredOperator(req) {
    try {
      const raw = req && req.headers ? (req.headers[OPERATOR_HEADER] || req.headers['X-416mes-Operator']) : '';
      const v = Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
      /* 客户端传的是 percent-encoding（因为 HTTP header 只能是 ByteString，
         中文姓名无法直接传）—— 先还原，再校验。 */
      let decoded = '';
      try { decoded = decodeURIComponent(v); } catch (_) { decoded = ''; }
      const s = decoded.replace(/[\r\n\t]/g, '').trim().slice(0, OPERATOR_MAX);
      /* 仅允许常见中西文、数字、空格与几个标点（防注入与不可见字符） */
      return /^[A-Za-z0-9 \u4e00-\u9fa5_\-.()·]*$/.test(s) ? s : '';
    } catch (_) { return ''; }
  }
  async function auth(req) {
    if (mode === 'feishu-trial' && !authenticate) {
      const op = declaredOperator(req);
      return { id: op || 'trial-unverified', roles: ['admin', 'operator'], unverified: true };
    }
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
  /* S3（v3.3.0，Phase D2 落地）：过期僵尸自动三态收口——
     PREPARED 行超过 10 分钟（serverless 单次执行不可能还在途，进程早已消亡）：
     回读目标快照一致 → APPLIED（apply 已落、finish 未落的半途）；
     回读操作前快照一致 → 未检出任何实际写入 → REJECTED（作废）；
     两者都不一致 → 检出部分写入 → REPAIR_REQUIRED（仅该命令实体，人工核对）。
     best-effort：异常跳过该行、下一条命令再试；重复行（logs.length!==1）留给人工。
     旧模型只「忽略过期行」却永不清理（v2.62-P2b 的 10 分钟豁免），僵尸行在飞书表里永久积累。 */
  const STALE_PREPARED_MS = 10 * 60 * 1000;
  async function sweepStalePrepared() {
    const rows = repository.unsettledOperations
      ? await repository.unsettledOperations()
      : (await repository.allOperations()).filter(o => o && ['PREPARED', 'REPAIR_REQUIRED'].includes(o.phase));
    const now = Date.now();
    const stale = rows.filter(o => o && o.phase === 'PREPARED'
      && Number.isFinite(Date.parse(o.requestedAt || ''))
      && now - Date.parse(o.requestedAt) > STALE_PREPARED_MS);
    for (const row of stale) {
      try {
        const logs = await repository.operations(row.code);
        if (logs.length !== 1) continue;
        const operation = logs[0];
        if (operation.phase !== 'PREPARED' || !operation.after || !operation.before) continue;
        const actual = await repository.readAfter(operation.after);
        let verdict;
        if (canonical(actual) === canonical(operation.after)) verdict = { phase: 'APPLIED' };
        else if (canonical(await repository.readAfter(operation.before)) === canonical(operation.before)) verdict = { phase: 'REJECTED', error: '过期未决命令自动收口：核对实体后未检出实际写入，按作废处理' };
        else verdict = { phase: 'REPAIR_REQUIRED', error: '过期未决命令自动收口：检出部分写入，需人工核对' };
        const finished = { ...operation, phase: verdict.phase, error: verdict.error, finishedAt: new Date().toISOString(), progress: Object.assign({}, operation.progress, { step: 'auto-settled' }) };
        await repository.finish(operation.recordId, finished);
        await coordinator.finish(operation.code, finished);
      } catch (_) { /* 单行收口失败不阻塞主流程 */ }
    }
  }
  async function post(req, request) {
    /* 2.81.0 C1：每命令飞书调用埋点——AsyncLocalStorage 隔离并发（未注入时直跑） */
    if (feishuMetrics) return feishuMetrics.run({ calls: 0, rateLimited: 0, startedAt: Date.now() }, () => _post(req, request));
    return _post(req, request);
  }
  async function _post(req, request) {
    /* v3.13.1：header 来源单独留一份 —— 后面写 operation 时 request 已被 clone 成 frozen，
       拿不到 headers 了（device 走 header，见 declaredDevice）。 */
    const headerSource = req;
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
    if (claim.existing) {
      /* v3.5.0（用户实测死锁）：同 opId 重放在云端未决（PREPARED）时 lookup 恒返回
         REPAIR_REQUIRED「原命令未决」——重放永远不会出结果。先收口超时未决行再查询：
         行龄 >10 分钟即被 sweep 判定终态，重放拿到真实结果，死循环消失。
         sweep 只依赖仓储接口（allOperations/operations/readAfter/finish），不限模式。 */
      try { await sweepStalePrepared(); } catch (_) { }
      return lookup(frozen.opId, actor);
    }
    if (!claim.acquired) {
      /* 3.7.0 C4：UNRESOLVED_OPERATION_BARRIER 在 feishu-trial 模式不可达——trial 协调器
         claim 只会返回 {acquired}/{existing,conflict}/{conflict}，前两者已在上方处理。
         本分支仅作为 strict 协调器（durable-global-barrier-v1，生产未启用）的
         fail-closed 出口：未取得写权绝不下探执行。 */
      const firstUnsettled = (await repository.allOperations())
        .find(o => ['PREPARED', 'REPAIR_REQUIRED'].includes(o.phase));
      const who = firstUnsettled ? '（未决：' + (firstUnsettled.kind || '?') + ' @ ' +
        String(firstUnsettled.requestedAt || '').slice(11, 19) + '）' : '';
      fail('UNRESOLVED_OPERATION_BARRIER' + who);
    }
    let sideEffectsPossible = false;
    /* S3（v3.3.0）：僵尸自动收口放在 claim 之后、一切校验之前——即使本命令稍后
       被首检拒绝，过期未决行也已被顺带收口（旧实现放在 prepare 之后，
       首检就失败的命令永远轮不到清理，僵尸行继续积累）。 */
    if (mode === 'feishu-trial') { try { await sweepStalePrepared(); } catch (_) { } }
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
      const operation = { ...plan, requestHash: digest, itemCode: frozen.itemCode || '', containerCode: frozen.containerCode || '', device: (declaredDevice(headerSource) || String(frozen.device || '')), requestedAt: new Date().toISOString(), progress: { step: 'prepared' } };
      // Persist intent before the first request: even a crash during log creation leaves a barrier.
      await coordinator.prepare(frozen.opId, operation);
      sideEffectsPossible = true;
      const recordId = await repository.prepare(operation);
      await coordinator.progress(frozen.opId, { recordId, step: 'log-created' });
      if (mode === 'feishu-trial') {
        /* v3.3.0 拆锁（用户实测 4 轮并发问题的共同根因）：互斥裁决整体移除——
           ① claim 的未决行阻塞（幻影屏障/僵尸行堵死一切）；
           ② 写前 conflictsWith/iAmLoser 输家定序（单设备被自己上一条超时命令判为 loser，
              客户端再编造「先确认的命令已生效」——叙事与事实均不成立）。
           正确性由独立机制保证：expected 版本前置（plan 首检）+ 写前重计划（本处保留，
           apply 前最后安全网）+ 写后回读 + 僵尸自动收口（claim 后已执行）。
           日志行降级为「审计 + 幂等凭据」，不再是锁。 */
        let preWriteError = null;
        try {
          const currentPlan = U.plan(await repository.snapshot(frozen), frozen, actor);
          if (snapshotChanged(currentPlan.before, plan.before) || snapshotChanged(currentPlan.after, plan.after)) preWriteError = 'TRIAL_PRECONDITION_CHANGED';
        } catch (e) { preWriteError = 'TRIAL_PRECONDITION_CHANGED: ' + e.message; }
        if (preWriteError) {
          const rejected = { code: frozen.opId, request: frozen, requestHash: digest, kind: frozen.kind, phase: 'REJECTED', operator: actor.id, error: preWriteError, requestedAt: operation.requestedAt, finishedAt: new Date().toISOString(), ...retryPolicyFor(preWriteError) };
          const _m2 = feishuMetrics && feishuMetrics.getStore();
          rejected.progress = Object.assign({ step: 'rejected', retry: retryPolicyFor(preWriteError) }, _m2 ? { metrics: { calls: _m2.calls, rateLimited: _m2.rateLimited || 0, durationMs: Date.now() - _m2.startedAt } } : {});   /* B2 策略 + C1 埋点 */
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
      const _m = feishuMetrics && feishuMetrics.getStore();
      const result = { ...operation, phase: 'APPLIED', finishedAt: new Date().toISOString(), progress: Object.assign({ recordId, step: 'verified' }, _m ? { metrics: { calls: _m.calls, rateLimited: _m.rateLimited || 0, durationMs: Date.now() - _m.startedAt } } : {}) };
      await repository.finish(recordId, result);
      await coordinator.finish(frozen.opId, result);
      return result;
    } catch (e) {
      if (sideEffectsPossible) {
        if (mode === 'feishu-trial') {
          /* 3.7.0 C3（单端直提，图三元凶修复）：apply 异常不再一律落 REPAIR_REQUIRED——
             残留未决行 10 分钟后被 sweep 判 REJECTED「自动收口」，用户看到卡自动消失+被拒。
             同请求内立即回读定性（飞书写是同步的，回读即最新观测；绝不重放 apply）：
             after 匹配 → APPLIED（写已落、finish 未落的半途）；
             before 匹配 → REJECTED（未检出实际写入，提交中断未生效，可直接重试）；
             都不匹配/回读本身失败 → REPAIR_REQUIRED（真未知，仅写入半途，概率极低）。 */
          try {
            const rows = await repository.operations(frozen.opId);
            if (rows.length === 1) {
              const cur = rows[0];
              if (['REJECTED', 'APPLIED'].includes(cur.phase)) return cur;
              let verdict = null;
              if (cur.after && cur.before) {
                try {
                  if (canonical(await repository.readAfter(cur.after)) === canonical(cur.after)) verdict = { ...cur, phase: 'APPLIED' };
                  else if (canonical(await repository.readAfter(cur.before)) === canonical(cur.before)) verdict = { ...cur, phase: 'REJECTED', error: '提交中断，未生效（回读未检出实际写入）；可直接重试' };
                } catch (_) { verdict = null; }
              }
              const finished = verdict || { ...cur, phase: 'REPAIR_REQUIRED', error: String(e.message) };
              finished.finishedAt = new Date().toISOString();
              await repository.finish(cur.recordId, finished);
              return finished;
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
      const _m4 = feishuMetrics && feishuMetrics.getStore();
      const result = { code: frozen.opId, request: frozen, requestHash: digest, kind: frozen.kind, phase: 'REJECTED', operator: actor.id, error: e.message, requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...retryPolicyFor(e.message), progress: Object.assign({ step: 'rejected' }, _m4 ? { metrics: { calls: _m4.calls, rateLimited: _m4.rateLimited || 0, durationMs: Date.now() - _m4.startedAt } } : {}) };
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
      const _m3 = feishuMetrics && feishuMetrics.getStore();
      const result = { ...operation, phase: 'APPLIED', finishedAt: new Date().toISOString(), progress: Object.assign({}, operation.progress, _m3 ? { metrics: { calls: _m3.calls, rateLimited: _m3.rateLimited || 0, durationMs: Date.now() - _m3.startedAt } } : {}) };
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
  /* v3.3.0 拆锁后 TRIAL_CONCURRENT 不再由服务端产生（保留识别兼容历史残留行）；
     版本类拒绝语义不变：换新 opId 重建（客户端单轮重建，无自动退避）。 */
  const t = String(errText || '');
  if (/TRIAL_CONCURRENT|VERSION_CONFLICT|TRIAL_PRECONDITION_CHANGED/.test(t)) {
    return { retryable: false, newOpIdRequired: true, retryAfterMs: 0, policy: { maxAuto: 0, backoffMs: [], strategy: 'rescan-or-rebuild' } };
  }
  if (/UNRESOLVED_OPERATION_BARRIER/.test(t)) {
    return { retryable: true, newOpIdRequired: false, retryAfterMs: 0, policy: { maxAuto: 0, backoffMs: [], strategy: 'settle-then-resubmit' } };
  }
  return { retryable: false, newOpIdRequired: false, retryAfterMs: 0, policy: { maxAuto: 0, backoffMs: [], strategy: 'manual' } };
}
module.exports = { create, hash };
