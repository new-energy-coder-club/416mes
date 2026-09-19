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
  /* 核实启用操作本身是「生成凭据」的现场核实。服务端快照会给无凭据启用的实体打上冲突标记
     （item-repository.snapshot），若让 unique() 的冲突守卫拦截 activate* 自己，凭据永远无法产生，
     实体永久锁死（实测：B-01-01-01 等历史直改数据）。计划期间对目标实体自身临时豁免、还原。 */
  function uniqueForActivation(state, table, key) {
    const mapKey = table + ':' + key, saved = state.__itmConflicts && state.__itmConflicts[mapKey];
    const tolerable = saved && ['server-location-unverified', 'server-snapshot-unverified', 'unverified-controlled-change'].includes(saved.reason);
    if (tolerable) delete state.__itmConflicts[mapKey];
    try { return unique(state, table, key); } finally { if (tolerable) state.__itmConflicts[mapKey] = saved; }
  }
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
      const loc = uniqueForActivation(state, 'locations', req.locationCode);
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
      const c = uniqueForActivation(state, 'containers', req.containerCode);
      // active→active 是重确认：版本照常 +1，lastOpId 换成本操作——它就是新的凭据
      if (!['unknown', 'disabled', 'active'].includes(c.status)) fail('STATE_CONFLICT');
      version(c, expected.containerVersion);
      const loc = unique(state, 'locations', req.target && req.target.loc); active(loc);
      // 容器旧 loc 同样是历史线索；现场确认后显式覆盖才允许纠正到实际库位
      if (c.loc && c.loc !== loc.code && req.confirmLegacyLocOverride !== true) fail('LEGACY_LOCATION_CONFLICT');
      change('containers', c, { status: 'active', loc: loc.code });
    } else if (req.kind === 'placeContainer') {
      /* 2.57.0 Phase4（定位反转）：定位的对象就是「未绑定库位」的容器——
         unknown 容器在本操作内原子启用+定位（version+1、lastOpId 即凭据）；
         已绑定库位的容器拒绝并引导改用「容器移库」。
         uniqueForActivation：unknown 容器在服务端快照可能带 server-snapshot-unverified
         标记，定位操作本身就是生成凭据的现场核实，不能被冲突守卫拦死（否则死循环）。 */
      const c = uniqueForActivation(state, 'containers', req.containerCode);
      if (!['unknown', 'active'].includes(c.status)) fail('STATE_CONFLICT');
      version(c, expected.containerVersion);
      const dest = unique(state, 'locations', req.target && req.target.loc); active(dest);
      if (c.loc) fail('ALREADY_PLACED', '容器已绑定库位 ' + c.loc + '，如需移动请改用「容器移库」');
      change('containers', c, { status: 'active', loc: dest.code });
    } else if (req.kind === 'moveContainer') {
      const c = unique(state, 'containers', req.containerCode);
      active(c); version(c, expected.containerVersion);
      const dest = unique(state, 'locations', req.target && req.target.loc); active(dest);
      if (!req.source || req.source.loc !== c.loc) fail('SOURCE_MISMATCH');
      const source = unique(state, 'locations', c.loc); active(source);
      if (c.loc === dest.code) fail('NO_CHANGE');
      change('containers', c, { loc: dest.code });
    } else {
      const item = unique(state, 'items', req.itemCode);
      if (!STATES.includes(item.status)) fail('INVALID_STATE');
      version(item, expected.itemVersion);
      if (req.kind === 'receive') {
        /* 2.58.0 Phase5（旧物品核实并入入库）：unknown 旧档案物品直接入库——
           扫描目标库位即现场确认；旧 loc 线索留 before 供审计（与 verifyLegacy 同语义）。
           verifyLegacy 分支保留（历史命令可重放）。 */
        if (!['pending', 'out', 'unknown'].includes(item.status)) fail('INVALID_TRANSITION');
        const target = pair(state, req.target, expected.containerVersion);
        change('items', item, { container: target.container.code, status: 'in_stock' });
        if (item.status === 'unknown' && item.loc) before.items[0].loc = item.loc;
      } else if (req.kind === 'issue' || req.kind === 'transfer') {
        if (item.status !== 'in_stock') fail('INVALID_TRANSITION');
        const source = pair(state, req.source, expected.containerVersion);
        if (source.container.code !== item.container) fail('SOURCE_MISMATCH');
        let dest = '';
        if (req.kind === 'transfer') {
          // 2.49.5：目标与当前容器相同的重扫，先于版本校验判 NO_CHANGE——
          // 否则目标版本过期时误报 VERSION_CONFLICT，误导排障（审计 Bug3）。
          if (req.target && req.target.container && req.target.container === item.container) fail('NO_CHANGE');
          dest = pair(state, req.target, expected.targetContainerVersion).container.code;
          if (dest === item.container) fail('NO_CHANGE');
        }
        change('items', item, { container: dest, status: dest ? 'in_stock' : 'out' });
      } else if (req.kind === 'verifyLegacy') {
        /* 2.58.0 deprecated：UI 入口已移除（receive 直接接受 unknown）；
           分支保留——历史命令/日志必须可重放。 */
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
