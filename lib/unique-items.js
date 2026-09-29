/* Unique physical items. Pure shared domain; no MAT accounting or network effects. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UniqueItems = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STATES = ['unknown', 'pending', 'in_stock', 'out', 'retired'];
  /* P2（子位写入路径）：CONTROLLED 扩列。
     · items += 'loc'：子位直存（在库 ⇒ container XOR loc）成为受控事实，由 change() 快照与
       显式双写共同维护；apply() 按 hasOwn 落列，显式 '' 会真正清掉飞书「库位码」遗留值。
     · locations += 'role','parentContainer'：子位标记（角色/所属容器码）成为受控事实，
       唯一写入方是 activateLocation 的子位化标注（§A2）。 */
  const CONTROLLED = {
    items: ['container', 'loc', 'status', 'version', 'lastOpId'],
    containers: ['loc', 'status', 'version', 'lastOpId'],
    locations: ['status', 'role', 'parentContainer']
  };
  const KINDS = ['receive', 'issue', 'transfer', 'placeContainer', 'moveContainer', 'verifyLegacy', 'retire', 'activateLocation', 'activateContainer', 'registerItem', 'registerLocation', 'registerContainer', 'receiveBatch', 'issueBatch'];
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  function fail(code, message) { const e = new Error(message || code); e.code = code; throw e; }
  function code(value) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 160) fail('INVALID_CODE');
    return value; // Never numerically coerce: 001 and 1 are different identities.
  }
  /* v3.13.12（发现 Q）：文本字段（名称/规格/说明等）只做「清洗」，不做「拒绝」。
     以前域层对 name/spec 零校验：5000 字符、控制符、HTML 串全部原样接受。
     沿链路实测（UI/Excel/CSV/标签）都没造成危害，但控制符会一路带到飞书，
     且让日志与展示出现不可见字符。这里用最保守的策略：
       · 控制符（含 NUL/CR/LF 之外的 C0/C1）→ 直接剔除
       · 长度上限 500（远超正常名称，又挡住粘贴事故）
     不 reject 的原因：名称是自由文本，用户粘错内容不该让整次建档失败，
     清洗后的值仍然可用，且 userId 可见地看到结果。 */
  function text(value, max) {
    if (value == null) return '';
    const raw = typeof value === 'string' ? value : String(value);
    const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const limit = max || 500;
    return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned;
  }
  function normalize(table, row) {
    const r = clone(row || {});
    if (table === 'items') {
      if (!r.status) r.status = 'unknown';
      if (r.container == null) r.container = '';
      if (r.loc == null) r.loc = '';
      delete r.qty;
    }
    if (table === 'containers' || table === 'locations') { if (!r.status) r.status = 'unknown'; }
    if (table === 'locations') {
      /* P2（A1b 命门）：role/parentContainer 默认空串——历史 APPLIED 流水（旧 4 字段/1 字段
         CONTROLLED）与实时行经 group() 归一后两侧一致，否则旧日志凭据全量失效、
         merge 报 server-snapshot-unverified 级别的 unverified-controlled-change 锁死。 */
      if (r.role == null) r.role = '';
      if (r.parentContainer == null) r.parentContainer = '';
    }
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
    /* 容器库位模型 P1（只读定位扩展）：it.loc 非空 = 物品直存库位（容器子位），直读优先，
       绕过 item.container → containers.loc 的旧推导；it.loc 为空走旧容器链，行为不变。
       本阶段 it.loc 没有任何写入方（真实数据恒为空），此分支只影响读取定位。
       container 恒为 null：直存物品不在任何容器里；historicalLoc 置空串：
       it.loc 已是权威现状，不再是「历史线索」。 */
    if (item.loc) {
      const location = unique(state, 'locations', item.loc);
      return { item, container: null, location, historicalLoc: '', legacy: false };
    }
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
      /* P2（A2）子位化标注：req.role / req.parentContainer 为顶层显式字段。
         鉴别器：仅 role==='容器子位' 触发子位化（无 sub 键参与，container==='' 绝不触发）；
         其余显式 role 值在 FREE 行上忽略（activate 只负责启用，不静默改写角色）；
         子位行 activate 时原样携带 role/parentContainer（幂等重确认不丢从属）。 */
      const marking = req.role === '容器子位';
      let nextRole = loc.role, nextParent = loc.parentContainer;
      if (marking) {
        /* 标记必须显式带父容器码；子位行带空父容器 = 试图解除从属但未给解除形态 → 拒绝 */
        if (!req.parentContainer) {
          if (loc.role === '容器子位') fail('SUBLOC_UNBIND_UNSPECIFIED', loc.code + ' 已是容器子位，解除从属须用专门形态');
          fail('MISSING_RELATION', 'parentContainer: 子位化必须显式声明父容器');
        }
        const parent = unique(state, 'containers', req.parentContainer);
        active(parent);
        /* LOC_ALREADY_BOUND 预检查（A-3 增量A）：该库位已从属**别的**父容器仍拒绝；
           「自身占用」放行——旧模型里父容器行仍以 loc 绑着此格（bound.code ===
           req.parentContainer）属迁移期残留，同一计划内先显式清掉（after.containers
           显式 loc:''，CONTROLLED 字段集不变）再落子位化：一条命令、一条 APPLIED
           日志同时证明「子位标注 + 旧绑定清除」，天然是迁移凭据。他者占用仍拒绝。 */
        if (loc.parentContainer && loc.parentContainer !== req.parentContainer) fail('LOC_ALREADY_BOUND', loc.code + ' 已从属容器 ' + loc.parentContainer);
        const bound = (state.containers || []).find(r => r.loc === loc.code);
        if (bound && bound.code !== req.parentContainer) fail('LOC_ALREADY_BOUND', loc.code + ' 已被容器 ' + bound.code + ' 绑定（旧模型占位）');
        if (bound) change('containers', normalize('containers', bound), { loc: '' });
        nextRole = '容器子位';
        nextParent = req.parentContainer;
      } else if (loc.role === '容器子位' && req.role != null && req.role !== '容器子位') {
        /* A-3（增量B）解除从属专门形态：activateLocation{ locationCode, role:'自由位',
           parentContainer:'', confirmSublocUnbind:true }。缺形态（其余 role 值 / 缺
           confirmSublocUnbind）仍 SUBLOC_UNBIND_UNSPECIFIED —— 子位不能经 activate
           静默降级。形态合法但格下仍有在库物品（it.loc===此格 && status==='in_stock'）
           → SUBLOC_OCCUPIED，先移出再解绑。通过后双重清除：role 与 parentContainer
           一并置空（下方快照已用 nextRole/nextParent，CONTROLLED 字段集不变）。 */
        const unbindForm = req.role === '自由位' && req.parentContainer === '' && req.confirmSublocUnbind === true;
        if (!unbindForm) fail('SUBLOC_UNBIND_UNSPECIFIED', loc.code + ' 已是容器子位，role=' + req.role + ' 未给解除从属形态');
        const occupant = (state.items || []).find(it => it.status === 'in_stock' && it.loc === loc.code);
        if (occupant) fail('SUBLOC_OCCUPIED', loc.code + ' 子位下仍有在库物品 ' + occupant.code + '，先移出再解除从属');
        nextRole = '';
        nextParent = '';
      }
      before.locations = [{ code: loc.code, status: loc.status, role: loc.role, parentContainer: loc.parentContainer }];
      after.locations = [{ code: loc.code, status: 'active', role: nextRole, parentContainer: nextParent }];
    } else if (req.kind === 'activateContainer') {
      if (!admin) fail('FORBIDDEN');
      const c = uniqueForActivation(state, 'containers', req.containerCode);
      // active→active 是重确认：版本照常 +1，lastOpId 换成本操作——它就是新的凭据
      if (!['unknown', 'disabled', 'active'].includes(c.status)) fail('STATE_CONFLICT');
      /* A-2（容器库位模型重构）：纯启用——不解析 req.target、不写/不校验 loc，
         容器与库位的从属唯一落点是定位/移库（placeContainer/moveContainer）与
         activateLocation 的子位化标注（A-3）；after 显式携带 loc:''，绝不保留旧值
         （CONTROLLED.containers 字段集不变，值可变）。
         S2（v3.3.0）幂等语义随之收窄为只看 status：容器已 active = 幂等重确认，
         跳过版本前置——本地镜像陈旧不该挡核实（用户实测「先确认的命令已生效」
         死循环主场景：上一次启用实际已 APPLIED 但本机 ACK 未落）；本次 APPLIED
         日志本身就是同步合并要求的启用凭据（与 activateLocation 同语义）。
         真实变更（unknown/disabled → active）照旧要求版本一致；
         LEGACY_LOCATION_CONFLICT 旧位确认随 target 一起删除
         （verifyLegacy 的同名守卫保留，只管物品旧线索）。 */
      const idempotent = c.status === 'active';
      if (!idempotent) version(c, expected.containerVersion);
      change('containers', c, { status: 'active', loc: '' });
    } else if (req.kind === 'placeContainer') {
      /* ⚠ 冻结（Phase A 批次3，v3.13.31）：容器定位/移库的扫码与 UI 入口已删除（item-scan.js
         sequences、item-ui.js 重建白名单、index.html 下拉），但本命令体**原样保留**——
         在飞操作表里的历史命令仍需可重放/可审计，操作记录页仍按操作类型渲染。
         Phase D 不得删除本分支；也不要改 KINDS 或 item-schema 的操作类型 options。
         新代码一律走 activateContainer（纯启用）+ activateLocation（子位标注）。 */
      /* 2.57.0 Phase4（定位反转）：定位的对象就是「未绑定库位」的容器——
         unknown 容器在本操作内原子启用+定位（version+1、lastOpId 即凭据）；
         已绑定库位的容器拒绝并引导改用「容器移库」。
         uniqueForActivation：unknown 容器在服务端快照可能带 server-snapshot-unverified
         标记，定位操作本身就是生成凭据的现场核实，不能被冲突守卫拦死（否则死循环）。 */
      const c = uniqueForActivation(state, 'containers', req.containerCode);
      if (!['unknown', 'active'].includes(c.status)) fail('STATE_CONFLICT');
      version(c, expected.containerVersion);
      const dest = unique(state, 'locations', req.target && req.target.loc); active(dest);
      if (dest.role === '容器子位') fail('LOC_ROLE_MISMATCH', dest.code + ' 是容器子位，容器不能定位到子位');
      if (c.loc) fail('ALREADY_PLACED', '容器已绑定库位 ' + c.loc + '，如需移动请改用「容器移库」');
      change('containers', c, { status: 'active', loc: dest.code });
    } else if (req.kind === 'moveContainer') {
      /* ⚠ 冻结（Phase A 批次3，v3.13.31）：同 placeContainer——入口已删、命令体保留供
         历史命令重放与审计，Phase D 不得删除。 */
      const c = unique(state, 'containers', req.containerCode);
      active(c); version(c, expected.containerVersion);
      const dest = unique(state, 'locations', req.target && req.target.loc); active(dest);
      if (dest.role === '容器子位') fail('LOC_ROLE_MISMATCH', dest.code + ' 是容器子位，容器不能移动到子位');
      if (!req.source || req.source.loc !== c.loc) fail('SOURCE_MISMATCH');
      const source = unique(state, 'locations', c.loc); active(source);
      if (c.loc === dest.code) fail('NO_CHANGE');
      change('containers', c, { loc: dest.code });
    } else if (req.kind === 'receiveBatch' || req.kind === 'issueBatch') {
      /* 2.77.0 批量（Phase 1）：批量收发——
         入库须同目标库位锚点；**出库自 TASK-06 起不限库位**（扫物品码即可出库），
         每件库位由 containerCode 反查容器现状。
         原「同库位（或进一步同容器）」描述——
         形状：target/source 锚点 loc + items:[{itemCode, containerCode, expectedItemVersion, expectedContainerVersion}]。
         全有或全无：任一件 throw 即无 after 产出（plan 是纯函数，先于一切副作用）。
         错误带「@ 件码」供客户端高亮失败行。上限 50 件（事故半径控制）。 */
      const items = req.items;
      if (!Array.isArray(items) || !items.length) fail('BATCH_EMPTY');
      if (items.length > 50) fail('BATCH_TOO_LARGE');
      const anchor = req.kind === 'receiveBatch' ? req.target : req.source;
      /* TASK-06 方案 A：issueBatch 的 source.loc 为可选兼容字段（跨库位混拣）。
         入库仍严格锚定目标库位（东西要放到某个架子上）。
         出库每件库位由 containerCode 反查容器现状，不与 anchor.loc 比对。 */
      if (req.kind === 'receiveBatch' && (!anchor || !anchor.loc)) fail('MISSING_RELATION');
      /* 仅校验锚点库位可用性（旧客户端仍会带），不参与逐件比对（TASK-06 起出库不限库位）。 */
      if (anchor && anchor.loc) {
        const anchorLoc = unique(state, 'locations', anchor.loc); active(anchorLoc);
        /* P3（A4 批量镜像）：子位锚点仅由显式 anchor.sub===true 键控（鉴别器红线：
           container==='' 绝不触发子位路径），必须是活跃「容器子位」——与单条 receive
           同判（unique→active→role 顺序）。锚点级 fail-fast：锚点错则整批无意义。
           出库 source 锚点是兼容展示字段（TASK-06），不做此判。 */
        if (req.kind === 'receiveBatch' && anchor.sub === true && anchorLoc.role !== '容器子位')
          fail('LOC_ROLE_MISMATCH', anchorLoc.code + ' 不是容器子位，物品不能直存该库位');
      }
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
            if (anchor.sub === true) {
              /* P3（A4 批量镜像）：子位锚点下逐件直存——条目无容器步骤，带 containerCode
                 即旧客户端误用（子位入库无容器版本可派）→ INVALID_CODE。
                 与单条 receive 子位分支同判：不校验 item.container，change 显式清空。 */
              if (e.containerCode) fail('INVALID_CODE');
              change('items', item, { container: '', loc: anchor.loc, status: 'in_stock' });
            } else {
              if (item.container && item.container !== e.containerCode) fail('SOURCE_MISMATCH', 'SOURCE_MISMATCH: ' + itemCode + ' 现存容器与声明不符');
              const target = pair(state, { loc: anchor.loc, container: e.containerCode }, e.expectedContainerVersion);
              /* P3（P2 溢出修复）：显式清空 loc——out 件残留的历史子位 loc 若不清，
                 落库后 in_stock 行 container+loc 双写破坏 XOR 不变量（B1 合并永久冲突）。 */
              change('items', item, { container: target.container.code, loc: '', status: 'in_stock' });
            }
            if (item.status === 'unknown' && item.loc) before.items[before.items.length - 1].loc = item.loc;
          } else {
            if (item.status !== 'in_stock') fail('INVALID_TRANSITION');
            if (e.sub === true) {
              /* P3（A5 批量镜像）：条目级子位出库（仅显式 e.sub===true 键控）——
                 源校验与单条 issue 同判且同序：声明子位与物品现存一致（SOURCE_MISMATCH）
                 先于 unique/active（NOT_FOUND/INACTIVE_ENTITY）与角色门禁（LOC_ROLE_MISMATCH）。
                 子位无版本：expectedContainerVersion 忽略；条目带 containerCode 同为
                 旧客户端误用 → INVALID_CODE。出库不动 loc：保留子位历史线索（与单条同款）。 */
              if (e.containerCode) fail('INVALID_CODE');
              if (!item.loc || e.locCode !== item.loc) fail('SOURCE_MISMATCH', 'SOURCE_MISMATCH: ' + itemCode + ' 现存子位 ' + (item.loc || '?') + ' 与声明不符');
              const srcLoc = unique(state, 'locations', e.locCode); active(srcLoc);
              if (srcLoc.role !== '容器子位') fail('LOC_ROLE_MISMATCH', srcLoc.code + ' 不是容器子位');
              change('items', item, { container: '', status: 'out' });
            } else {
              if (!item.container || item.container !== e.containerCode) fail('SOURCE_MISMATCH', 'SOURCE_MISMATCH: ' + itemCode + ' 现存容器与声明不符');
              /* TASK-06 方案 A：每件库位由 containerCode 反查容器现状，不与 source.loc 比对。
                 校验容器启用 + 版本前置（与 pair 同等安全等级），不比对 anchor 库位。 */
              const srcCtn = unique(state, 'containers', e.containerCode);
              active(srcCtn);
              version(srcCtn, e.expectedContainerVersion);
              /* TASK-06R 审计补位：跨库位混拣后「这一批动了哪些库位」必须能一条日志答出来。
                 容器之后还会被移库，只进 before 作历史线索，不进 after、不参与判定（与入库分支同款）。
                 ⚠️ 必须在 change() **之后**补——before.items 是 change() 内部才 push 的（见 :124-129）。 */
              change('items', item, { container: '', status: 'out' });
              if (srcCtn.loc && before.items.length) before.items[before.items.length - 1].loc = srcCtn.loc;
            }
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
        /* P2（A4）子位入库：仅 req.target.sub===true 显式键控（鉴别器红线：
           container==='' 绝不触发子位分支，CLM-6.1–6.5 旧形状拒绝原样保留）。
           互斥双写：container 显式清空 + loc 写子位码（apply 只写 hasOwn 列 → 两者都真实落库）。
           目标必须是活跃的「容器子位」（与 B2 同步侧同判，fail-fast）。 */
        if (req.target && req.target.sub === true) {
          const destLoc = unique(state, 'locations', req.target.loc); active(destLoc);
          if (destLoc.role !== '容器子位') fail('LOC_ROLE_MISMATCH', destLoc.code + ' 不是容器子位，物品不能直存该库位');
          change('items', item, { container: '', loc: destLoc.code, status: 'in_stock' });
        } else {
          const target = pair(state, req.target, expected.containerVersion);
          change('items', item, { container: target.container.code, loc: '', status: 'in_stock' });
        }
        if (item.status === 'unknown' && item.loc) before.items[0].loc = item.loc;
      } else if (req.kind === 'issue' || req.kind === 'transfer') {
        if (item.status !== 'in_stock') fail('INVALID_TRANSITION');
        /* P2（A5）子位路径由 req.source.sub===true / req.target.sub===true 显式键控。
           互斥不变量：在库 ⇒ container XOR loc（恰好一真一空）。 */
        if (req.source && req.source.sub === true) {
          /* 子位直存物品：源校验 = 声明子位与物品现状一致 + 子位存在且活跃（子位无版本） */
          if (!item.loc || req.source.loc !== item.loc) fail('SOURCE_MISMATCH', 'SOURCE_MISMATCH: 物品现存子位 ' + (item.loc || '?') + ' 与声明不符');
          const srcLoc = unique(state, 'locations', req.source.loc); active(srcLoc);
          if (srcLoc.role !== '容器子位') fail('LOC_ROLE_MISMATCH', srcLoc.code + ' 不是容器子位');
        } else {
          const source = pair(state, req.source, expected.containerVersion);
          if (source.container.code !== item.container) fail('SOURCE_MISMATCH');
        }
        if (req.kind === 'transfer') {
          if (req.target && req.target.sub === true) {
            /* 目标子位：container 显式清空 + loc 写子位码 */
            const destLoc = unique(state, 'locations', req.target.loc); active(destLoc);
            if (destLoc.role !== '容器子位') fail('LOC_ROLE_MISMATCH', destLoc.code + ' 不是容器子位，物品不能直存该库位');
            if (destLoc.code === item.loc) fail('NO_CHANGE');
            change('items', item, { container: '', loc: destLoc.code, status: 'in_stock' });
          } else {
            // 2.49.5：目标与当前容器相同的重扫，先于版本校验判 NO_CHANGE——
            // 否则目标版本过期时误报 VERSION_CONFLICT，误导排障（审计 Bug3）。
            if (req.target && req.target.container && req.target.container === item.container) fail('NO_CHANGE');
            const dest = pair(state, req.target, expected.targetContainerVersion).container.code;
            if (dest === item.container) fail('NO_CHANGE');
            change('items', item, { container: dest, loc: '', status: 'in_stock' });
          }
        } else {
          change('items', item, { container: '', status: 'out' });   // 不动 loc：出库物品保留子位历史线索
        }
      } else if (req.kind === 'verifyLegacy') {
        /* 2.58.0 deprecated：UI 入口已移除（receive 直接接受 unknown）；
           分支保留——历史命令/日志必须可重放。 */
        if (!admin) fail('FORBIDDEN');
        if (item.status !== 'unknown') fail('INVALID_TRANSITION');
        const target = pair(state, req.target, expected.containerVersion);
        // 旧 loc 只是历史线索，不是硬约束。实物现场确认优先：请求显式带
        // confirmLegacyLocOverride 时以实物扫描为准（before 里留旧值，日志可审计）。
        if (item.loc && item.loc !== target.loc.code && req.confirmLegacyLocOverride !== true) fail('LEGACY_LOCATION_CONFLICT');
        /* P2（A6 同款）：容器入库路径显式清 loc——controlled 快照会携带 unknown 行的历史 loc，
           不显式清空会产出 in_stock 双写行（container+loc 同真），被 B1 的 XOR 校验隔离成永久冲突。 */
        change('items', item, { container: target.container.code, loc: '', status: 'in_stock' });
        if (item.loc) before.items[0].loc = item.loc;   // 旧位置是历史线索，进 before 供审计核对
      } else if (req.kind === 'retire') {
        if (!admin) fail('FORBIDDEN');
        // unknown 也可退役：否则「实物位置与旧记录不一致」的物品永远卡死无出口
        if (!['pending', 'out', 'unknown'].includes(item.status)) fail('INVALID_TRANSITION');
        /* P2（A6）双清除：受控组含 loc 后，retired 行必须显式清空 loc（与 container 同款），
           否则快照携带的旧 loc 存活，currentPosition 的 historicalLoc 显示陈旧子位。 */
        change('items', item, { container: '', loc: '', status: 'retired' });
      }
    }
    return { code: req.opId, kind: req.kind, request: req, before, after, operator: actor.id, phase: 'PREPARED' };
  }
  /* v3.13.12（发现 Q）：自由文本字段清单 —— 只含真正由人手填的字段 */
  const FREE_TEXT_FIELDS = {
    items: ['name', 'spec'], containers: ['type', 'spec'], locations: ['kind', 'desc'],
    members: ['name', 'dept', 'role', 'group', 'phone', 'note'], manuals: ['name', 'spec'],
    materials: ['name', 'spec', 'cat', 'img'], necOrders: ['title', 'owner', 'note'],
    workorders: ['reason']
  };
  function ordinaryFields(table, record) {
    /* 容器库位模型 P0：locations 白名单加 role（库位角色，单选[自由位|容器子位]）——
       只通管道（建档/同步/补丁可携带该字段），本阶段无命令会写入它；
       parentContainer 故意不进白名单：它是 P2 activateLocation 的系统落笔字段，
       不能让人经普通建档/补丁路径改。 */
    const fields = { items: ['code', 'name', 'spec', 'materialCode'], containers: ['code', 'type', 'spec'], locations: ['code', 'kind', 'desc', 'grants', 'role'] };
    if (table === 'itemOperations') fail('OPERATION_TABLE_READ_ONLY');
    if (!fields[table]) return clone(record);
    /* v3.13.12（发现 Q）：自由文本字段过 text() 清洗（剔控制符 + 限长 500）。
       以前域层对 name/spec 零校验：5000 字符、控制符、HTML 串全部原样接受，
       会一路带到飞书并让日志/展示出现不可见字符。code/version/status 等
       受控与标识字段绝不走这里。 */
    const freeText = FREE_TEXT_FIELDS[table] || [];
    return Object.fromEntries(fields[table].filter(k => Object.hasOwn(record, k)).map(k => {
      const v = clone(record[k]);
      return [k, freeText.includes(k) ? text(v) : v];
    }));
  }
  return { STATES, CONTROLLED, KINDS, normalize, migrate, unique, uniqueForActivation, entityKeysOf, controlled, currentPosition, plan, ordinaryFields };
});
