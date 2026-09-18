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
      const candidates = logs.filter(o => o.phase === 'APPLIED' && o.kind === 'activateLocation' &&
        (o.after && o.after.locations || []).some(r => r.code === row.code && r.status === 'active'));
      return candidates.length === 1;
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
          if (pending && ['unverified-controlled-change', 'incomplete-controlled-group'].includes(pending.reason)) delete state.__itmConflicts[table + ':' + raw.code];
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
