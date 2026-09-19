/* Controlled groups are never field-wise merged. Shared by full and incremental paths. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./unique-items'), require('./item-persistence'));
  else root.ItemSync = factory(root.UniqueItems, root.ItemPersistence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (U, P) {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const same = (a, b) => P.canonical(a) === P.canonical(b);
  function group(table, r) { return U.controlled(table, U.normalize(table, r)); }
  function proof(table, row, logs) {
    if (table === 'locations') {
      // LOC v1 has no revision/op identity: only the defined one-way admin activation
      // is provable. Disable/re-enable needs a future versioned LOC contract.
      if (row.status !== 'active') return false;
      // 2.49.5：按 opId 去重后 ≥1 条 APPLIED activateLocation 即成立。
      // 此前 ===1：幂等重确认（active→active）会写出第二条日志 → 凭据永久失效 →
      // 库位被冲突标记、收发全锁死且不可自愈（审计 Bug1 探针 A1-A7）。
      // 重复实体行（同 opId 多条）仍按一次计，不放大凭据。
      const seen = new Set();
      for (const o of logs) {
        if (o.phase !== 'APPLIED' || o.kind !== 'activateLocation') continue;
        if (!(o.after && o.after.locations || []).some(r => r.code === row.code && r.status === 'active')) continue;
        if (seen.has(o.code)) continue;
        seen.add(o.code);
        if (seen.size >= 1) return true;
      }
      return false;
    }
    const candidates = logs.filter(o => o.phase === 'APPLIED' && (table === 'locations' || o.code === row.lastOpId) &&
      (o.after && o.after[table] || []).some(r => r.code === row.code && same(group(table, r), group(table, row))));
    return candidates.length === 1;
  }
  function merge(state, remote) {
    const ordinary = clone(remote), conflicts = [];
    state.__itmConflicts = state.__itmConflicts || {};
    state.itemOperations = state.itemOperations || [];
    function conflict(table, key, reason, local, observed) {
      const c = { table, key, reason, local: local && clone(local), observed: clone(observed) };
      conflicts.push(c); state.__itmConflicts[table + ':' + key] = c;
    }
    const logs = remote.itemOperations;
    if (Array.isArray(logs)) {
      const counts = new Map(); logs.forEach(o => counts.set(o.code, (counts.get(o.code) || 0) + 1));
      for (const incoming of logs) {
        const old = state.itemOperations.filter(o => o.code === incoming.code);
        if (counts.get(incoming.code) !== 1 || old.length > 1 || (remote.duplicates && remote.duplicates.itemOperations || []).some(d => d.key === incoming.code)) {
          conflict('itemOperations', incoming.code, 'duplicate-operation', old[0], incoming); continue;
        }
        const frozen = ['request', 'requestHash', 'before', 'after', 'operator'];
        if (old[0] && frozen.some(k => !same(old[0][k], incoming[k]))) {
          conflict('itemOperations', incoming.code, 'operation-payload-changed', old[0], incoming); continue;
        }
        const allowed = { PREPARED: ['PREPARED', 'APPLIED', 'REPAIR_REQUIRED', 'REJECTED'], REPAIR_REQUIRED: ['REPAIR_REQUIRED', 'APPLIED'], APPLIED: ['APPLIED'], REJECTED: ['REJECTED'] };
        if (!allowed[incoming.phase] || old[0] && !(allowed[old[0].phase] || []).includes(incoming.phase)) {
          conflict('itemOperations', incoming.code, 'invalid-operation-phase', old[0], incoming); continue;
        }
        if (!old.length) state.itemOperations.push(clone(incoming));
        else Object.assign(old[0], clone(incoming));
      }
    }
    delete ordinary.itemOperations; // append cache only; no generic deletion or merge
    const trustedLogs = state.itemOperations.filter(o => !state.__itmConflicts['itemOperations:' + o.code]);
    for (const table of ['locations', 'containers', 'items']) {
      if (!Array.isArray(remote[table])) continue;
      state[table] = state[table] || [];
      const counts = new Map(); remote[table].forEach(r => counts.set(r.code, (counts.get(r.code) || 0) + 1));
      ordinary[table] = [];
      for (const raw of remote[table]) {
        const matches = state[table].filter(r => r.code === raw.code), local = matches[0];
        if (matches.length > 1 || counts.get(raw.code) !== 1 || (remote.duplicates && remote.duplicates[table] || []).some(d => d.key === raw.code)) {
          conflict(table, raw.code, 'duplicate-entity', local, raw); continue;
        }
        const incoming = U.normalize(table, raw);
        // Missing group columns are distinct from explicit blanks: never fabricate a partial group.
        const complete = U.CONTROLLED[table].every(k => Object.hasOwn(raw, k));
        const legacy = !raw.lastOpId && (!raw.version || raw.version === 0) && (table === 'items' ? !raw.status || raw.status === 'unknown' : !raw.status || raw.status === 'unknown');
        let accept = false;
        if (legacy && (!local || (table === 'locations' ? !local.status || local.status === 'unknown' : !local.lastOpId && (!local.version || local.version === 0)))) accept = true;
        else if (complete && proof(table, incoming, trustedLogs)) {
          const validItem = table !== 'items' || U.STATES.includes(incoming.status) && (incoming.status === 'in_stock' ? !!incoming.container : !incoming.container);
          let relationValid = true;
          if (table === 'items' && incoming.status === 'in_stock') {
            const containers = (state.containers || []).filter(c => c.code === incoming.container);
            relationValid = containers.length === 1 && (state.locations || []).filter(l => l.code === containers[0].loc).length === 1;
          }
          if (table === 'containers' && incoming.loc) relationValid = (state.locations || []).filter(l => l.code === incoming.loc).length === 1;
          if (validItem && relationValid && (!local || table === 'locations' || incoming.version > local.version || same(group(table, local), group(table, incoming)))) accept = true;
        }
        if (local && same(group(table, local), group(table, incoming))) accept = false; // no mutation needed
        else if (!accept) conflict(table, raw.code, complete ? 'unverified-controlled-change' : 'incomplete-controlled-group', local, raw);
        let destination = local;
        if (!destination) {
          destination = U.normalize(table, { code: raw.code }); state[table].push(destination);
        }
        if (accept) {
          Object.assign(destination, group(table, incoming));
          const pending = state.__itmConflicts[table + ':' + raw.code];
          /* 2.49.5（审计 B2）：accept 落地 = 本轮已给出可证明的一致状态，该实体此前的冲突
             一律解除（含 duplicate-entity 粘滞——服务端去重后凭据到达却永不解锁的死锁）。
             若仍有重复/异常，本轮 conflict() 会在别处重新登记。 */
          if (pending) delete state.__itmConflicts[table + ':' + raw.code];
        }
        // Ordinary merge sees locally chosen group values, never unverified remote fragments.
        const clean = { ...raw, ...group(table, destination) };
        if (table === 'items') delete clean.qty;
        ordinary[table].push(clean);
      }
    }
    return { ordinary, conflicts };
  }
  return { merge, proof };
});
