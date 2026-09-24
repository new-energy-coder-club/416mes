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
  const KINDS = ['receive', 'issue', 'transfer', 'placeContainer', 'moveContainer', 'verifyLegacy', 'retire', 'activateLocation', 'activateContainer', 'registerItem', 'registerLocation', 'registerContainer', 'receiveBatch', 'issueBatch'];
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
  /* 2.63.0 Phase D（实体级分桶）：从请求派生「本命令会触碰哪些实体」的键集。
     两个命令的键集不相交 → 可安全并行（服务端 plan/回读仍是最终安全网）；
     相交 → 必须互斥。无码 registerItem 归 register:<分类> 特殊桶（发号需串行）。
     REPAIR_REQUIRED 不进分桶——它代表一致性存疑，保持全局屏障。 */
  function entityKeysOf(req) {
    const keys = new Set();
    const add = (t, c) => { if (c != null && c !== '') keys.add(t + ':' + c); };
    if (!req || !req.kind) return keys;
    if (req.itemCode) add('items', req.itemCode);
    if (req.containerCode) add('containers', req.containerCode);
    if (req.locationCode) add('locations', req.locationCode);
    if (req.entity && req.entity.code) add('items', req.entity.code);
    /* 2.77.0 批量（Phase 1）：批量命令键集 = N×items + M×containers——
       不补此段则批量键集为空，会被判与一切未决命令冲突（fail-safe 但不可用）。 */
    if (Array.isArray(req.items)) for (const e of req.items) {
      if (e && e.itemCode) add('items', e.itemCode);
      /* A2：批量收发不锁容器（同上理由）——容器写类操作不受影响 */
    }
    /* 2.79.0 A2（稳定多并发）：收发/批量收发的互斥键降级为**只锁 items**——
       plan 对收发只 change items（容器行从不被写，unique-items.js:177-208），
       锁容器只会制造同容器串行墙（N 台设备同盒互斥排队）。安全网：
       ① 每件 expected.itemVersion 严格守卫；② 写前重计划 TRIAL_PRECONDITION_CHANGED
       （并发容器移动落地后重计划必撞 CONTAINER_LOCATION_MISMATCH→拒绝）；
       ③ move/place/activate 容器操作保留 containers+locations 写键（它们真的改容器）。 */
    const isContainerMove = ['moveContainer', 'placeContainer', 'activateContainer', 'activateLocation'].includes(req.kind);
    const isItemOnlyOp = ['receive', 'issue', 'transfer', 'receiveBatch', 'issueBatch'].includes(req.kind);
    if (req.source) { if (!isItemOnlyOp && req.source.container) add('containers', req.source.container); if (isContainerMove && req.source.loc) add('locations', req.source.loc); }
    if (req.target) { if (!isItemOnlyOp && req.target.container) add('containers', req.target.container); if (isContainerMove && req.target.loc) add('locations', req.target.loc); }
    if (req.kind === 'registerItem' && !(req.entity && req.entity.code)) {
      const cat = String((req.entity && req.entity.category) || '').trim().toUpperCase();
      if (cat) keys.add('register:' + cat);
    }
    return keys;
  }
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
      /* 2.77.0 批量（Phase 1）：push 累加——批量分支对同表多次 change（每件一次）。
         单件命令每条只 change 一次，数组形状不变（17 条既有测试对 push 版全过）。 */
      (before[table] = before[table] || []).push({ code: row.code, ...controlled(table, row) });
      (after[table] = after[table] || []).push({ code: row.code, ...controlled(table, row), ...patch, version: row.version + 1, lastOpId: req.opId });
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
      // 3.7.0 C2（单端直提）：expected.locationStatus 比对删除——单端串行下本机镜像与云端
      // 瞬时错位（重拉前/同步在途）只会把「从 unknown 启用」误判成 STATE_CONFLICT；
      // 启用是幂等低危操作（v1 无 version、状态两向），目标态合法性（上一行）已足够。
      if (!['unknown', 'active'].includes(loc.status)) fail('STATE_CONFLICT');
      before.locations = [{ code: loc.code, status: loc.status }];
      after.locations = [{ code: loc.code, status: 'active' }];
    } else if (req.kind === 'activateContainer') {
      if (!admin) fail('FORBIDDEN');
      const c = uniqueForActivation(state, 'containers', req.containerCode);
      // active→active 是重确认：版本照常 +1，lastOpId 换成本操作——它就是新的凭据
      if (!['unknown', 'disabled', 'active'].includes(c.status)) fail('STATE_CONFLICT');
      const loc = unique(state, 'locations', req.target && req.target.loc); active(loc);
      /* S2（v3.3.0）：容器已是「启用 + 目标库位」= 幂等重确认，跳过版本前置——
         容器行只在移动/定位/启用时变更，本地镜像陈旧不该挡核实（用户实测「先确认的命令
         已生效」死循环主场景：上一次启用实际已 APPLIED 但本机 ACK 未落）。
         本次 APPLIED 日志本身就是同步合并要求的启用凭据（与 activateLocation 同语义）。
         真实变更（unknown 启用 / 换位 / 停用后重启）照旧要求版本一致 + 旧位确认。 */
      const idempotent = c.status === 'active' && c.loc === loc.code;
      if (!idempotent) {
        version(c, expected.containerVersion);
        // 容器旧 loc 同样是历史线索；现场确认后显式覆盖才允许纠正到实际库位
        if (c.loc && c.loc !== loc.code && req.confirmLegacyLocOverride !== true) fail('LEGACY_LOCATION_CONFLICT');
      }
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
    } else if (req.kind === 'receiveBatch' || req.kind === 'issueBatch') {
      /* 2.77.0 批量（Phase 1）：同库位（或进一步同容器）批量收发——
         形状：target/source 锚点 loc + items:[{itemCode, containerCode, expectedItemVersion, expectedContainerVersion}]。
         全有或全无：任一件 throw 即无 after 产出（plan 是纯函数，先于一切副作用）。
         错误带「@ 件码」供客户端高亮失败行。上限 50 件（事故半径控制）。 */
      const items = req.items;
      if (!Array.isArray(items) || !items.length) fail('BATCH_EMPTY');
      if (items.length > 50) fail('BATCH_TOO_LARGE');
      const anchor = req.kind === 'receiveBatch' ? req.target : req.source;
      if (!anchor || !anchor.loc) fail('MISSING_RELATION');
      const loc = unique(state, 'locations', anchor.loc); active(loc);
      if (req.kind === 'issueBatch' && req.target) fail('INVALID_TRANSITION');
      const seen = new Set();
      for (const e of items) {
        try {
          if (!e || !e.itemCode) fail('INVALID_CODE');
          const itemCode = code(e.itemCode);
          if (seen.has(itemCode)) fail('DUPLICATE_IN_BATCH');
          seen.add(itemCode);
          const item = unique(state, 'items', itemCode);
          version(item, e.expectedItemVersion);
          if (req.kind === 'receiveBatch') {
            if (!['pending', 'out', 'unknown'].includes(item.status)) fail('INVALID_TRANSITION');
            if (item.container && item.container !== e.containerCode) fail('SOURCE_MISMATCH', 'SOURCE_MISMATCH: ' + itemCode + ' 现存容器与声明不符');
            const target = pair(state, { loc: anchor.loc, container: e.containerCode }, e.expectedContainerVersion);
            change('items', item, { container: target.container.code, status: 'in_stock' });
            if (item.status === 'unknown' && item.loc) before.items[before.items.length - 1].loc = item.loc;
          } else {
            if (item.status !== 'in_stock') fail('INVALID_TRANSITION');
            if (!item.container || item.container !== e.containerCode) fail('SOURCE_MISMATCH', 'SOURCE_MISMATCH: ' + itemCode + ' 现存容器与声明不符');
            const src = pair(state, { loc: anchor.loc, container: e.containerCode }, e.expectedContainerVersion);
            if (src.container.code !== item.container) fail('SOURCE_MISMATCH');
            change('items', item, { container: '', status: 'out' });
          }
        } catch (err) { err.itemCode = e && e.itemCode; err.message = (err.message || err.code || 'ERROR') + ' @ ' + (e && e.itemCode || '?'); throw err; }
      }
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
  return { STATES, CONTROLLED, KINDS, normalize, migrate, unique, uniqueForActivation, entityKeysOf, controlled, currentPosition, plan, ordinaryFields };
});
