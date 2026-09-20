'use strict';
const Schema = require('./item-schema');
const U = require('./unique-items');
function create(api) {
  async function auth() { return api.tenantToken(); }
  async function all(table) {
    const result = await api.listRecordsEx(await auth(), api.TABLES[table]);
    if (result.complete !== true) throw Error('INCOMPLETE_TABLE:' + table);
    return result.items;
  }
  async function exactRaw(table, code) {
    const records = await all(table);
    const def = api.TABLE_DEFS[table];
    const matches = records.filter(r => api.T(r.fields[def.key]) === code);
    if (matches.length !== 1) throw Error('AMBIGUOUS_RECORD:' + table + ':' + code);
    return matches[0];
  }
  return {
    async validateSchema() { const report = await Schema.inspect(api); if (!report.schemaValid) throw Error('ITM_SCHEMA_INVALID:' + JSON.stringify(report.problems)); },
    async allOperations() { return (await all('itemOperations')).map(r => ({ ...api.TABLE_DEFS.itemOperations.down(r.fields), recordId: r.record_id })); },
    /* 2.69.0 M2：精确查操作ID 是否已有日志行（searchRecords 1 次请求，替代全表扫） */
    async operationExists(opId) {
      try {
        const d = await api.searchRecords(await auth(), api.TABLES.itemOperations, {
          pageSize: 1,
          filter: { conjunction: 'and', conditions: [{ field_name: '操作ID', operator: 'is', value: [String(opId)] }] }
        });
        return (d.items || []).length > 0;
      } catch (e) { return (await this.operations(opId)).length > 0; }   // search 不可用退回全表扫
    },
    async operations(opId) {
      const records = await all('itemOperations');
      return records.filter(r => api.T(r.fields['操作ID']) === opId).map(r => ({ ...api.TABLE_DEFS.itemOperations.down(r.fields), recordId: r.record_id }));
    },
    async snapshot() {
      const state = await api.pullState();
      for (const t of ['items', 'containers', 'locations', 'itemOperations']) {
        if (!state.completeness || !state.completeness[t] || !state.completeness[t].complete) throw Error('INCOMPLETE_TABLE:' + t);
        if (state.duplicates && state.duplicates[t] && state.duplicates[t].length) throw Error('DUPLICATE_ENTITY:' + t);
      }
      U.migrate(state);
      const sync = require('./item-sync');
      state.__itmConflicts = {};
      for (const table of ['items', 'containers']) for (const row of state[table]) {
        if ((row.version > 0 || row.lastOpId || table === 'items' && ['in_stock', 'out', 'retired'].includes(row.status)) && !sync.proof(table, row, state.itemOperations)) {
          state.__itmConflicts[table + ':' + row.code] = { reason: 'server-snapshot-unverified' };
        }
      }
      for (const row of state.locations) if (row.status === 'active' && !sync.proof('locations', row, state.itemOperations)) state.__itmConflicts['locations:' + row.code] = { reason: 'server-location-unverified' };
      return state;
    },
    async prepare(operation) {
      const fields = api.TABLE_DEFS.itemOperations.up(operation);
      // Optional date/text fields are absent during PREPARED, not invalid empty date values.
      for (const key of Object.keys(fields)) if (fields[key] === null || fields[key] === undefined || fields[key] === '') delete fields[key];
      await api.batchCreate(await auth(), api.TABLES.itemOperations, [{ fields }]);
      const raw = await exactRaw('itemOperations', operation.code);
      if (api.T(raw.fields['请求摘要']) !== operation.requestHash) throw Error('LOG_READBACK_MISMATCH');
      return raw.record_id;
    },
    async apply(after, operation) {
      for (const [table, records] of Object.entries(after)) {
        if (!U.CONTROLLED[table]) throw Error('INVALID_CONTROLLED_TABLE');
        for (const row of records) {
          if (operation && operation.kind.startsWith('register')) {
            const existing = (await all(table)).filter(r => api.T(r.fields[api.TABLE_DEFS[table].key]) === row.code);
            if (existing.length) throw Error('CODE_ALREADY_REGISTERED');
            const fields = api.TABLE_DEFS[table].up(row);
            Object.keys(fields).forEach(k => { if (fields[k] === null || fields[k] === '' || fields[k] === undefined) delete fields[k]; });
            if (table !== 'items' && fields['状态'] === 'unknown') delete fields['状态'];
            await api.batchCreate(await auth(), api.TABLES[table], [{ fields }]);
            continue;
          }
          const raw = await exactRaw(table, row.code), fields = {};
          for (const [local, col] of api.TABLE_DEFS[table].fields) {
            if (U.CONTROLLED[table].includes(local) && Object.hasOwn(row, local)) fields[col] = row[local];
          }
          // Direct dedicated update: explicit '' is retained; no generic coerce/drop path.
          await api.batchUpdate(await auth(), api.TABLES[table], [{ record_id: raw.record_id, fields }]);
        }
      }
    },
    async readAfter(after) {
      const result = {};
      for (const [table, records] of Object.entries(after)) {
        result[table] = [];
        for (const row of records) {
          const raw = await exactRaw(table, row.code), mapped = U.normalize(table, api.TABLE_DEFS[table].down(raw.fields));
          result[table].push(Object.fromEntries(Object.keys(row).map(k => [k, mapped[k]])));
        }
      }
      return result;
    },
    async finish(recordId, operation) {
      const fields = { '处理阶段': operation.phase, '完成时间': Date.parse(operation.finishedAt), '执行进度': JSON.stringify(operation.progress || {}), '错误与恢复说明': operation.error || '' };
      await api.batchUpdate(await auth(), api.TABLES.itemOperations, [{ record_id: recordId, fields }]);
      const raw = await exactRaw('itemOperations', operation.code);
      if (raw.record_id !== recordId || api.T(raw.fields['处理阶段']) !== operation.phase || api.T(raw.fields['请求摘要']) !== operation.requestHash) throw Error('LOG_FINAL_READBACK_MISMATCH');
    }
  };
}
module.exports = { create };
