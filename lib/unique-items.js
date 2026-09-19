/* Unique physical items. Pure shared domain; no MAT accounting or network effects. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UniqueItems = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STATES = ['unknown', 'pending', 'in_stock', 'out', 'retired'];
  const CONTROLLED = {
    items: ['container', 'status', 'version', 'lastOpId'],
    containers: ['loc', 'status', 'version', 'lastOpId'],
    locations: ['status']
  };
  const KINDS = ['receive', 'issue', 'transfer', 'placeContainer', 'moveContainer', 'verifyLegacy', 'retire', 'activateLocation', 'activateContainer', 'registerItem', 'registerLocation', 'registerContainer'];
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  function fail(code, message) { const e = new Error(message || code); e.code = code; throw e; }
  function code(value) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 160) fail('INVALID_CODE');
    return value; // Never numerically coerce: 001 and 1 are different identities.
  }
  function normalize(table, row) {
    const r = clone(row || {});
    if (table === 'items') {
      if (!r.status) r.status = 'unknown';
      if (r.container == null) r.container = '';
      delete r.qty;
    }
    if (table === 'containers' || table === 'locations') { if (!r.status) r.status = 'unknown'; }
    if (table === 'items' || table === 'containers') {
      if (r.version == null || r.version === '') r.version = 0;
      if (r.lastOpId == null) r.lastOpId = '';
    }
    return r;
  }
  function migrate(state) {
    ['items', 'containers', 'locations'].forEach(t => { state[t] = (state[t] || []).map(r => normalize(t, r)); });
    state.itemOperations = state.itemOperations || [];
    return state;
  }
  function unique(state, table, key) {
    code(key);
    if (state.__itmConflicts && state.__itmConflicts[table + ':' + key]) fail('UNRESOLVED_ENTITY_CONFLICT', table + ': ' + key);
    const rows = (state[table] || []).filter(r => r.code === key);
    if (rows.length !== 1) fail(rows.length ? 'DUPLICATE_CODE' : 'NOT_FOUND', table + ': ' + key);
    return normalize(table, rows[0]);
  }
  function version(row, expected) {
    if (!Number.isSafeInteger(row.version) || row.version < 0 || !Number.isSafeInteger(expected) || expected !== row.version) fail('VERSION_CONFLICT');
    if (row.version === Number.MAX_SAFE_INTEGER) fail('VERSION_EXHAUSTED');
  }
  function active(row) { if (row.status !== 'active') fail('INACTIVE_ENTITY', row.code + ' 未核实启用或已停用'); }
  function pair(state, value, expected) {
    if (!value || typeof value !== 'object') fail('MISSING_RELATION');
    const loc = unique(state, 'locations', value.loc), container = unique(state, 'containers', value.container);
    active(loc); active(container);
    version(container, expected);
    if (container.loc !== loc.code) fail('CONTAINER_LOCATION_MISMATCH');
    return { loc, container };
  }
  function controlled(table, row) {
    const result = {};
    (CONTROLLED[table] || []).forEach(k => { result[k] = clone(row[k]); });
    return result;
  }
  function currentPosition(state, itemCode) {
    const item = unique(state, 'items', itemCode);
    if (item.status !== 'in_stock') return { item, container: null, location: null, historicalLoc: item.loc || '', legacy: item.status === 'unknown' };
    if (!item.container) fail('INVALID_IN_STOCK_RELATION');
    const container = unique(state, 'containers', item.container);
    const location = unique(state, 'locations', container.loc);
    return { item, container, location, historicalLoc: item.loc || '', legacy: false };
  }
  function plan(state, request, actor) {
    const req = clone(request || {});
    if (req.schemaVersion !== 1 || !KINDS.includes(req.kind)) fail('UNSUPPORTED_CONTRACT');
    code(req.opId);
    if (Object.hasOwn(req, 'qty') || Object.hasOwn(req, 'delta')) fail('ITM_HAS_NO_QTY');
    if (!actor || !actor.id || !Array.isArray(actor.roles) || !actor.roles.some(r => r === 'operator' || r === 'admin')) fail('FORBIDDEN');
    const admin = actor.roles.includes('admin');
    const expected = req.expected || {};
    const before = {}, after = {};
    function change(table, row, patch) {
      before[table] = [{ code: row.code, ...controlled(table, row) }];
      after[table] = [{ code: row.code, ...controlled(table, row), ...patch, version: row.version + 1, lastOpId: req.opId }];
    }
    if (['registerItem', 'registerLocation', 'registerContainer'].includes(req.kind)) {
      if (!admin) fail('FORBIDDEN');
      const table = { registerItem: 'items', registerLocation: 'locations', registerContainer: 'containers' }[req.kind];
      const key = code(req.entity && req.entity.code);
      if ((state[table] || []).some(r => r.code === key)) fail('CODE_ALREADY_REGISTERED');
      const row = ordinaryFields(table, req.entity);
      before[table] = [];
      after[table] = [{ ...row, ...(table === 'items' ? { container: '', status: 'pending', version: 1, lastOpId: req.opId } : table === 'containers' ? { loc: '', status: 'unknown', version: 1, lastOpId: req.opId } : { status: 'unknown' }) }];
    } else if (req.kind === 'activateLocation') {
      if (!admin) fail('FORBIDDEN');
      const loc = unique(state, 'locations', req.locationCode);
      // LOC v1 无 version、无禁用操作：unknown→active 是首次核实；active→active 是幂等重确认。
      // 幂等重确认不改实体，但 APPLIED 操作日志本身就是同步合并要求的启用凭据——
      // 历史上绕过操作协议直接激活（无凭据 active）造成的永久冲突死锁由此解锁。
      // retired/disabled 仍然拒绝：启用退役对象是业务事故，不是核实。
      if (!['unknown', 'active'].includes(loc.status)) fail('STATE_CONFLICT');
      if (loc.status === 'unknown' && expected.locationStatus !== loc.status) fail('STATE_CONFLICT');
      before.locations = [{ code: loc.code, status: loc.status }];
      after.locations = [{ code: loc.code, status: 'active' }];
    } else if (req.kind === 'activateContainer') {
      if (!admin) fail('FORBIDDEN');
      const c = unique(state, 'containers', req.containerCode);
      if (!['unknown', 'disabled'].includes(c.status)) fail('STATE_CONFLICT');
      version(c, expected.containerVersion);
      const loc = unique(state, 'locations', req.target && req.target.loc); active(loc);
      // 容器旧 loc 同样是历史线索；现场确认后显式覆盖才允许纠正到实际库位
      if (c.loc && c.loc !== loc.code && req.confirmLegacyLocOverride !== true) fail('LEGACY_LOCATION_CONFLICT');
      change('containers', c, { status: 'active', loc: loc.code });
    } else if (req.kind === 'placeContainer' || req.kind === 'moveContainer') {
      const c = unique(state, 'containers', req.containerCode);
      active(c); version(c, expected.containerVersion);
      const dest = unique(state, 'locations', req.target && req.target.loc); active(dest);
      if (req.kind === 'placeContainer') { if (c.loc) fail('ALREADY_PLACED'); }
      else {
        if (!req.source || req.source.loc !== c.loc) fail('SOURCE_MISMATCH');
        const source = unique(state, 'locations', c.loc); active(source);
        if (c.loc === dest.code) fail('NO_CHANGE');
      }
      change('containers', c, { loc: dest.code });
    } else {
      const item = unique(state, 'items', req.itemCode);
      if (!STATES.includes(item.status)) fail('INVALID_STATE');
      version(item, expected.itemVersion);
      if (req.kind === 'receive') {
        if (!['pending', 'out'].includes(item.status)) fail('INVALID_TRANSITION');
        const target = pair(state, req.target, expected.containerVersion);
        change('items', item, { container: target.container.code, status: 'in_stock' });
      } else if (req.kind === 'issue' || req.kind === 'transfer') {
        if (item.status !== 'in_stock') fail('INVALID_TRANSITION');
        const source = pair(state, req.source, expected.containerVersion);
        if (source.container.code !== item.container) fail('SOURCE_MISMATCH');
        let dest = '';
        if (req.kind === 'transfer') {
          dest = pair(state, req.target, expected.targetContainerVersion).container.code;
          if (dest === item.container) fail('NO_CHANGE');
        }
        change('items', item, { container: dest, status: dest ? 'in_stock' : 'out' });
      } else if (req.kind === 'verifyLegacy') {
        if (!admin) fail('FORBIDDEN');
        if (item.status !== 'unknown') fail('INVALID_TRANSITION');
        const target = pair(state, req.target, expected.containerVersion);
        // 旧 loc 只是历史线索，不是硬约束。实物现场确认优先：请求显式带
        // confirmLegacyLocOverride 时以实物扫描为准（before 里留旧值，日志可审计）。
        if (item.loc && item.loc !== target.loc.code && req.confirmLegacyLocOverride !== true) fail('LEGACY_LOCATION_CONFLICT');
        change('items', item, { container: target.container.code, status: 'in_stock' });
        if (item.loc) before.items[0].loc = item.loc;   // 旧位置是历史线索，进 before 供审计核对
      } else if (req.kind === 'retire') {
        if (!admin) fail('FORBIDDEN');
        // unknown 也可退役：否则「实物位置与旧记录不一致」的物品永远卡死无出口
        if (!['pending', 'out', 'unknown'].includes(item.status)) fail('INVALID_TRANSITION');
        change('items', item, { container: '', status: 'retired' });
      }
    }
    return { code: req.opId, kind: req.kind, request: req, before, after, operator: actor.id, phase: 'PREPARED' };
  }
  function ordinaryFields(table, record) {
    const fields = { items: ['code', 'name', 'spec', 'materialCode'], containers: ['code', 'type', 'spec'], locations: ['code', 'kind', 'desc', 'grants'] };
    if (table === 'itemOperations') fail('OPERATION_TABLE_READ_ONLY');
    if (!fields[table]) return clone(record);
    return Object.fromEntries(fields[table].filter(k => Object.hasOwn(record, k)).map(k => [k, clone(record[k])]));
  }
  return { STATES, CONTROLLED, KINDS, normalize, migrate, unique, controlled, currentPosition, plan, ordinaryFields };
});
