'use strict';
const crypto = require('node:crypto');
const U = require('./unique-items');
const { canonical } = require('./item-persistence');
const hash = request => crypto.createHash('sha256').update(canonical(request)).digest('hex');
function fail(code, status = 409) { const e = new Error(code); e.status = status; throw e; }
/** coordinator must persist global ownership, immutable commands and barriers BEFORE external writes.
 * No production memory implementation is provided. A claim never expires into permission to write.
 */
function create({ repository, coordinator, authenticate, enabled = false }) {
  async function auth(req) { const actor = authenticate && await authenticate(req); if (!actor || !actor.id) fail('UNAUTHENTICATED', 401); return actor; }
  function available() {
    if (!enabled || !coordinator || coordinator.contract !== 'durable-global-barrier-v1' || !coordinator.verified) fail('ITM_COORDINATION_UNAVAILABLE', 503);
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
    const frozen = JSON.parse(JSON.stringify(request));
    const digest = hash(frozen);
    const claim = await coordinator.claim({ opId: frozen.opId, requestHash: digest, request: frozen, operator: actor.id });
    if (claim.conflict) fail('OP_ID_PAYLOAD_CONFLICT');
    if (!claim.acquired) {
      if (claim.existing) return lookup(frozen.opId, actor);
      fail('UNRESOLVED_OPERATION_BARRIER');
    }
    let sideEffectsPossible = false;
    try {
      await repository.validateSchema();
      const logs = await repository.operations(frozen.opId);
      if (logs.length) fail('UNEXPECTED_EXISTING_OPERATION');
      const state = await repository.snapshot(frozen);
      const plan = U.plan(state, frozen, actor);
      const operation = { ...plan, requestHash: digest, itemCode: frozen.itemCode || '', containerCode: frozen.containerCode || '', device: String(frozen.device || ''), requestedAt: new Date().toISOString(), progress: { step: 'prepared' } };
      // Persist intent before the first request: even a crash during log creation leaves a barrier.
      await coordinator.prepare(frozen.opId, operation);
      sideEffectsPossible = true;
      const recordId = await repository.prepare(operation);
      await coordinator.progress(frozen.opId, { recordId, step: 'log-created' });
      await repository.apply(operation.after, operation);
      const actual = await repository.readAfter(operation.after);
      if (canonical(actual) !== canonical(operation.after)) fail('SNAPSHOT_READBACK_MISMATCH');
      const result = { ...operation, phase: 'APPLIED', finishedAt: new Date().toISOString(), progress: { recordId, step: 'verified' } };
      await repository.finish(recordId, result);
      await coordinator.finish(frozen.opId, result);
      return result;
    } catch (e) {
      if (sideEffectsPossible) {
        await coordinator.uncertain(frozen.opId, String(e.message));
        return { code: frozen.opId, request: frozen, phase: 'REPAIR_REQUIRED', error: String(e.message) };
      }
      // No write was issued, but a preexisting log is not evidence of no effects.
      if (e.message === 'UNEXPECTED_EXISTING_OPERATION') {
        await coordinator.uncertain(frozen.opId, e.message);
        return { code: frozen.opId, phase: 'REPAIR_REQUIRED', error: e.message };
      }
      const result = { code: frozen.opId, request: frozen, requestHash: digest, phase: 'REJECTED', operator: actor.id, error: e.message };
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
  return { post, get, recover };
}
module.exports = { create, hash };
