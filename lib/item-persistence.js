/* Browser-local command durability. Never a server/global coordination facility. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./unique-items'));
  else root.ItemPersistence = factory(root.UniqueItems);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (U) {
  'use strict';
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const TABLES = ['materials', 'locations', 'containers', 'members', 'items', 'manuals', 'workorders', 'necOrders', 'itemOperations'];
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  function error(code) { const e = new Error(code); e.code = code; throw e; }
  function createQueue() {
    let tail = Promise.resolve();
    return { run(task) { const result = tail.then(task); tail = result.catch(() => {}); return result; }, drain() { return tail; } };
  }
  // One editing tab per origin. Hold Web Lock for the whole page lifetime, not merely a transaction.
  async function acquireTab(locks, name) {
    if (!locks || typeof locks.request !== 'function') return { acquired: false, release() {} };
    let release;
    const held = new Promise(resolve => { release = resolve; });
    return new Promise(resolve => {
      locks.request(name || 'mes416-state-writer', { ifAvailable: true }, async lock => {
        if (!lock) { resolve({ acquired: false, release() {} }); return; }
        resolve({ acquired: true, release }); await held;
      }).catch(() => resolve({ acquired: false, release() {} }));
    });
  }
  async function writeSnapshot(tx, state) {
    const records = [];
    TABLES.forEach(table => (state[table] || []).forEach(row => {
      if (row && row.code != null && row.code !== '') records.push({ table, key: String(row.code), value: clone(row) });
    }));
    await tx.replaceAll('records', records);
    await tx.replaceAll('transactions', (state.transactions || []).filter(t => t && t.seq != null));
    await tx.put('syncMeta', { key: 'state-v1', value: clone(state) });
  }
  function restore(lsState, idbState, dirty, commands) {
    const state = clone((!dirty && idbState) || lsState || idbState || {});
    if (idbState) {
      if (idbState.__base) state.__base = clone(idbState.__base);
      // LS may be newer for ordinary names, but never supersedes IDB-confirmed relationships.
      for (const table of ['items', 'containers', 'locations']) {
        state[table] = state[table] || [];
        for (const durable of idbState[table] || []) {
          const matches = state[table].filter(r => r.code === durable.code);
          if (!matches.length) state[table].push(clone(durable));
          else if (matches.length === 1) Object.assign(matches[0], U.controlled(table, U.normalize(table, durable)));
        }
      }
      state.itemOperations = clone(idbState.itemOperations || []);
      state.__itmPending = clone(idbState.__itmPending || {});
    }
    state.__itmPending = state.__itmPending || {};
    (commands || []).filter(c => c.op === 'itemOperation').forEach(c => {
      state.__itmPending[c.id] = { opId: c.id, status: c.status || 'pending', request: clone(c.request) };
    });
    return U.migrate(state);
  }
  function create(opts) {
    const { store, getState, publish } = opts;
    const queue = opts.queue || createQueue();
    function ready() {
      if (!store || store.kind !== 'indexeddb') error('ITM_REQUIRES_INDEXEDDB');
      if (!opts.canWrite || !opts.canWrite()) error('ITM_REQUIRES_SINGLE_WRITER_TAB');
    }
    function commit(mutator) {
      return queue.run(async () => {
        ready();
        const next = clone(getState());
        const result = await store.transaction(['records', 'transactions', 'syncMeta', 'outbox'], async tx => {
          const result = await mutator(tx, next);
          await writeSnapshot(tx, next); return result;
        });
        publish(next); return result;
      });
    }
    return {
      queue,
      saveDraft(sessionId, draft) {
        if (!sessionId || typeof sessionId !== 'string') return Promise.reject(new Error('INVALID_SESSION'));
        const frozen = clone(draft);
        return queue.run(async () => { ready(); await store.put('syncMeta', { key: 'itmDraft:' + sessionId, value: frozen }); });
      },
      enqueue(request, sessionId, draft) {
        const frozen = clone(request), frozenDraft = clone(draft);
        return commit(async (tx, next) => {
          if (!frozen || !frozen.opId) error('MISSING_OP_ID');
          const existing = await tx.get('outbox', frozen.opId);
          if (existing && canonical(existing.request) !== canonical(frozen)) error('OP_ID_PAYLOAD_CONFLICT');
          const cached = (next.itemOperations || []).find(o => o.code === frozen.opId);
          if (cached) error('OP_ID_ALREADY_RESOLVED');
          const command = existing || { id: frozen.opId, op: 'itemOperation', request: frozen, status: 'pending', tries: 0 };
          await tx.put('outbox', command);
          next.__itmPending = next.__itmPending || {};
          next.__itmPending[frozen.opId] = { opId: frozen.opId, request: frozen, status: command.status };
          if (sessionId) await tx.put('syncMeta', { key: 'itmDraft:' + sessionId, value: { ...frozenDraft, locked: true, opId: frozen.opId } });
          return clone(command);
        });
      },
      acknowledge(result) {
        const frozen = clone(result);
        return commit(async (tx, next) => {
          if (!frozen || !['APPLIED', 'REJECTED'].includes(frozen.phase)) error('RESULT_NOT_FINAL');
          const command = await tx.get('outbox', frozen.code);
          if (!command || canonical(command.request) !== canonical(frozen.request)) error('RESULT_REQUEST_MISMATCH');
          if (frozen.phase === 'APPLIED') {
            for (const [table, rows] of Object.entries(frozen.after || {})) {
              if (!U.CONTROLLED[table]) error('INVALID_RESULT_TABLE');
              for (const row of rows) {
                const matches = (next[table] || []).filter(r => r.code === row.code);
                if (matches.length === 0 && frozen.kind && frozen.kind.startsWith('register') && frozen.request.entity && frozen.request.entity.code === row.code) {
                  next[table] = next[table] || []; next[table].push(clone(row)); continue;
                }
                if (matches.length !== 1) error('RESULT_ENTITY_AMBIGUOUS');
                const current = matches[0];
                const equal = (a, b) => canonical(U.controlled(table, a)) === canonical(U.controlled(table, b));
                if (table !== 'locations') {
                  if (!Number.isSafeInteger(row.version) || row.lastOpId !== frozen.code) error('RESULT_INVALID_VERSION');
                  if (current.version > row.version) {
                    // A late ACK may finish the old command, but may never roll back a newer proven snapshot.
                    const proof = (next.itemOperations || []).filter(o => o.code === current.lastOpId && o.phase === 'APPLIED');
                    if (proof.length !== 1 || !(proof[0].after && proof[0].after[table] || []).some(r => r.code === current.code && equal(r, current))) error('CURRENT_SNAPSHOT_UNVERIFIED');
                    continue;
                  }
                  if (current.version === row.version) {
                    if (!equal(current, row)) error('RESULT_SAME_VERSION_CONFLICT');
                    continue;
                  }
                  const before = (frozen.before && frozen.before[table] || []).find(r => r.code === row.code);
                  if (row.version !== current.version + 1 || !before || !equal(current, before)) error('RESULT_PRECONDITION_CONFLICT');
                } else {
                  const before = (frozen.before && frozen.before[table] || []).find(r => r.code === row.code);
                  if (!equal(current, row) && (!before || !equal(current, before))) error('RESULT_PRECONDITION_CONFLICT');
                }
                Object.assign(current, U.controlled(table, row));
              }
            }
          }
          next.itemOperations = (next.itemOperations || []).filter(o => o.code !== frozen.code).concat([frozen]);
          next.__itmPending = next.__itmPending || {}; delete next.__itmPending[frozen.code];
          await tx.del('outbox', frozen.code);
          return frozen;
        });
      },
      markUnknown(opId, message) {
        return commit(async (tx, next) => {
          const command = await tx.get('outbox', opId); if (!command) error('COMMAND_NOT_FOUND');
          command.status = 'needs_attention'; command.lastError = String(message || '结果待确认');
          await tx.put('outbox', command);
          next.__itmPending = next.__itmPending || {};
          next.__itmPending[opId] = { opId, status: 'needs_attention', request: command.request };
        });
      },
      async recover() {
        const commands = (await store.getAll('outbox')).filter(c => c.op === 'itemOperation');
        const drafts = (await store.getAll('syncMeta')).filter(m => m.key.startsWith('itmDraft:'));
        return { commands, drafts }; // Caller never auto-replays recovered commands.
      }
    };
  }
  return { TABLES, canonical, createQueue, acquireTab, writeSnapshot, restore, create };
});
