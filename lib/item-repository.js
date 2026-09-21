'use strict';
const Schema = require('./item-schema');
const U = require('./unique-items');
function create(api) {
  async function auth() { return api.tenantToken(); }
  async function all(table) {
    /* 2.82.0 C2（压测发现）：并发写期间读表会拿到 incomplete 分页——瞬态，重试一次即过 */
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
      const result = await api.listRecordsEx(await auth(), api.TABLES[table]);
      if (result.complete !== true) { lastErr = Error('INCOMPLETE_TABLE:' + table); continue; }
      return result.items;
    }
    throw lastErr;
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
    /* 2.70.0 M1（并发方案）：未决操作查询——searchRecords 按状态过滤，
       表增长到几千行后冲突裁决仍是 1-2 次请求（全表扫会线性放大到几十页）。
       search 不可用时退回 allOperations 全量（调用方自行过滤）。 */
    async unsettledOperations() {
      try {
        const d = await api.searchRecords(await auth(), api.TABLES.itemOperations, {
          pageSize: 500,
          filter: { conjunction: 'or', conditions: [
            { field_name: '处理阶段', operator: 'is', value: ['PREPARED'] },
            { field_name: '处理阶段', operator: 'is', value: ['REPAIR_REQUIRED'] }
          ] }
        });
        return (d.items || []).map(r => ({ ...api.TABLE_DEFS.itemOperations.down(r.fields), recordId: r.record_id }));
      } catch (e) {
        return (await this.allOperations()).filter(o => ['PREPARED', 'REPAIR_REQUIRED'].includes(o.phase));
      }
    },
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
      /* 2.79.0 A1：searchRecords 精确查操作ID（1 次请求替代全表分页扫）；
         能力判定先于取 token（stub 无 search 能力时不产生多余凭证刷新），失败退回全表扫 */
      if (api.searchRecords) {
        try {
          const d = await api.searchRecords(await auth(), api.TABLES.itemOperations, {
            pageSize: 20,
            filter: { conjunction: 'and', conditions: [{ field_name: '操作ID', operator: 'is', value: [String(opId)] }] }
          });
          return (d.items || []).map(r => ({ ...api.TABLE_DEFS.itemOperations.down(r.fields), recordId: r.record_id }));
        } catch (e) { /* search 不可用/权限缺失 → 全表扫 */ }
      }
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
      const created = await api.batchCreate(await auth(), api.TABLES.itemOperations, [{ fields }]);
      /* 2.79.0 A1（稳定多并发）：record_id 直接取 batchCreate 响应（旧实现丢弃响应再全表扫找回）；
         回读用 readRecord 按 id 直读（1 次请求；刚写的行用 search 会有索引延迟，直读安全）。 */
      const recordId = (created && created.records && created.records[0] && created.records[0].record_id) || null;
      const raw = recordId && api.readRecord
        ? { record_id: recordId, fields: await api.readRecord(await auth(), api.TABLES.itemOperations, recordId) }
        : await exactRaw('itemOperations', operation.code);   // 测试 stub 无 readRecord 时回退全表扫
      if (api.T(raw.fields['请求摘要']) !== operation.requestHash) throw Error('LOG_READBACK_MISMATCH');
      return raw.record_id;
    },
    async apply(after, operation) {
      /* 2.74.0 Phase 0（批量方案前置）：每表一次扫描建 code→record 索引，
         单次 batchCreate/batchUpdate 写整表的所有行——
         旧实现每行 exactRaw（全表分页扫）+ 单行 batchUpdate，
         N 行 = N×2 次全表扫 + N 次写（N=20 时 40+ 次往返）。
         现在与 N 无关：每表 1 次读 + 1 次写。单件行为完全不变。 */
      for (const [table, records] of Object.entries(after)) {
        if (!U.CONTROLLED[table]) throw Error('INVALID_CONTROLLED_TABLE');
        const def = api.TABLE_DEFS[table];
        const isRegister = operation && operation.kind.startsWith('register');
        if (isRegister) {
          /* 建档：先整批查重（一次扫描），再整批建 */
          const existing = new Set((await all(table)).map(r => api.T(r.fields[def.key])));
          const creating = [];
          for (const row of records) {
            if (existing.has(String(row.code))) throw Error('CODE_ALREADY_REGISTERED:' + row.code);
            const fields = def.up(row);
            Object.keys(fields).forEach(k => { if (fields[k] === null || fields[k] === '' || fields[k] === undefined) delete fields[k]; });
            if (table !== 'items' && fields['状态'] === 'unknown') delete fields['状态'];
            creating.push({ fields });
          }
          if (creating.length) await api.batchCreate(await auth(), api.TABLES[table], creating);
          continue;
        }
        /* 更新：一次扫描建索引，聚合所有行的字段变更，单次 batchUpdate */
        const index = new Map((await all(table)).map(r => [api.T(r.fields[def.key]), r.record_id]));
        const updates = [];
        for (const row of records) {
          const recordId = index.get(String(row.code));
          if (!recordId) throw Error('AMBIGUOUS_RECORD:' + table + ':' + row.code);
          const fields = {};
          for (const [local, col] of def.fields) {
            if (U.CONTROLLED[table].includes(local) && Object.hasOwn(row, local)) fields[col] = row[local];
          }
          // Direct dedicated update: explicit '' is retained; no generic coerce/drop path.
          updates.push({ record_id: recordId, fields });
        }
        if (updates.length) await api.batchUpdate(await auth(), api.TABLES[table], updates);
      }
    },
    async readAfter(after) {
      /* 2.74.0 Phase 0：每表一次扫描建索引（与 apply 同款）——
         旧实现每行 exactRaw 全表扫，N 行 = N 次全表扫。 */
      const result = {};
      for (const [table, records] of Object.entries(after)) {
        const def = api.TABLE_DEFS[table];
        const index = new Map((await all(table)).map(r => [api.T(r.fields[def.key]), r]));
        result[table] = [];
        for (const row of records) {
          const raw = index.get(String(row.code));
          if (!raw) throw Error('AMBIGUOUS_RECORD:' + table + ':' + row.code);
          const mapped = U.normalize(table, def.down(raw.fields));
          result[table].push(Object.fromEntries(Object.keys(row).map(k => [k, mapped[k]])));
        }
      }
      return result;
    },
    async finish(recordId, operation) {
      const fields = { '处理阶段': operation.phase, '完成时间': Date.parse(operation.finishedAt), '执行进度': JSON.stringify(operation.progress || {}), '错误与恢复说明': operation.error || '' };
      await api.batchUpdate(await auth(), api.TABLES.itemOperations, [{ record_id: recordId, fields }]);
      /* 2.79.0 A1：recordId 在参数里——按 id 直读回读（替代全表扫） */
      const raw = api.readRecord
        ? { record_id: recordId, fields: await api.readRecord(await auth(), api.TABLES.itemOperations, recordId) }
        : await exactRaw('itemOperations', operation.code);
      if (raw.record_id !== recordId || api.T(raw.fields['处理阶段']) !== operation.phase || api.T(raw.fields['请求摘要']) !== operation.requestHash) throw Error('LOG_FINAL_READBACK_MISMATCH');
    }
  };
}
module.exports = { create };
