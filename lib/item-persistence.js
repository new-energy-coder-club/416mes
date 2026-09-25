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
      /* 2.62.0 Phase C：放弃无副作用的屏障拒绝命令（仅本地 outbox 条目；
         不写删除凭据——它没有产生任何飞书变更，历史在操作日志里仍可查）。 */
      async abandonCommand(opId) {
        return queue.run(async () => { ready(); await store.del('outbox', opId); });
      },
            /* 2.58.1 Phase6（清单治理）：清空全部草稿键（itmDraft:* 前缀）——
         只删草稿，绝不碰 outbox（已入队命令可能已 APPLIED，删卡即丢凭据）。 */
      async clearDrafts() {
        return queue.run(async () => {
          ready();
          const all = await store.getAll('syncMeta');
          const doomed = all.filter(m => m.key && m.key.startsWith('itmDraft:'));
          for (const m of doomed) await store.del('syncMeta', m.key);
          return doomed.length;
        });
      },
      enqueue(request, sessionId, draft) {
        const frozen = clone(request), frozenDraft = clone(draft);
        /* v3.12.0 device 归属：服务端 item-operation.js:172 一直读 `frozen.device` 写进操作日志，
           但客户端 7 处构造 request 全都忘了带 —— 线上 5 条操作日志的 device 恒为""。
           在这里统一补（而不是改 7 个构造点）：enqueue 是唯一的入队总闸。
           ⚠️ 域层不读 device（unique-items.js grep 零命中），所以它进 request/进 requestHash
           都不影响任何业务判定；而「同 opId 重放」的 payload 也带着同样的 device，幂等不受影响。 */
        if (frozen && !frozen.device) {
          try {
            const st = (typeof state !== 'undefined') ? state : null;
            const did = (st && st.deviceId) || (typeof localStorage !== 'undefined' ? (localStorage.getItem('mes416_device_id') || '') : '');
            if (did) frozen.device = String(did);
          } catch (_) { }
        }
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
          if (!command) error('RESULT_REQUEST_MISMATCH');
          /* P4 放宽：register* 且本地命令 entity.code 为空（服务端发号建档）时，
           * 服务端回填了 code，逐字比对必然不等——比较前剔除双方 entity.code，
           * 并校验回填码 === after 目标表首行 code，其余字段仍须严格一致。 */
          let cmdRequest = command.request, resRequest = frozen.request;
          const kind = (resRequest && resRequest.kind) || frozen.kind || '';
          if (canonical(cmdRequest) !== canonical(resRequest)) {
            const backfilled = kind.startsWith('register') && cmdRequest && cmdRequest.entity &&
              (cmdRequest.entity.code == null || cmdRequest.entity.code === '') &&
              resRequest && resRequest.entity && typeof resRequest.entity.code === 'string';
            if (!backfilled) error('RESULT_REQUEST_MISMATCH');
            const strip = r => { const c = clone(r); delete c.entity.code; return c; };
            if (canonical(strip(cmdRequest)) !== canonical(strip(resRequest))) error('RESULT_REQUEST_MISMATCH');
            if (frozen.phase === 'APPLIED') {
              const table = { registerItem: 'items', registerLocation: 'locations', registerContainer: 'containers' }[kind];
              const row = frozen.after && frozen.after[table] && frozen.after[table][0];
              if (!table || !row || row.code !== resRequest.entity.code) error('RESULT_REQUEST_MISMATCH');
            }
          }
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
                /* 刚 ACK 的 APPLIED 操作就是这次受控变更的凭据（item-sync.proof 只认它）。
                 * 因此随之解除该实体「未核验变更」冲突——否则本地会被冲突堵死，
                 * 连刚启用的编码都填不进作业行（用户实测：点启用后流程仍然走不动）。 */
                const stale = next.__itmConflicts && next.__itmConflicts[table + ':' + row.code];
                /* 2.49.5（审计 B7）：与 merge 的解除清单对齐——凭据覆盖到的冲突全部随 ACK 解除 */
                const ackClears = ['unverified-controlled-change', 'incomplete-controlled-group'];
                if (stale && ackClears.includes(stale.reason)) delete next.__itmConflicts[table + ':' + row.code];
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
