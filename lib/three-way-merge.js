/*!
 * lib/three-way-merge.js — Phase 3 三方合并（UMD，纯逻辑：无网络、无 DOM）
 *
 * 为什么需要 base：今天的合并是**两方**的 —— 飞书来的值只要本地有值就覆盖。
 * 于是「飞书批量改了 5000 行」和「本地同时改的那 20 行」无法区分，
 * 只能全部问人（≥500 条待确认）。有了 base 才知道**是谁改的**：
 *
 *   local === base          → 本地没动过 → 直接采纳远端（自动快进，不打扰人）
 *   remote === base         → 远端没动过 → 保留本地
 *   local === remote        → 两边改成一样的 → 无冲突
 *   三者互不相同            → 真双改 → 才需要人确认
 *
 * 三份裁定共同指出的两个陷阱，这里都正面处理：
 *   ① **base 跨设备不存在**：换设备/清缓存就没有 base。此时**降级为保守策略**
 *      （等价于两方合并，多问人），绝不假装自己知道谁改了什么。
 *   ② **base 是每客户端各一份 → merge 不是良定义函数**：两台设备可能算出不同结果。
 *      所以 planMerge 是纯函数、可复算、可审计，最终靠「谁后写谁赢」收敛。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MesThreeWay = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MERGE_TABLES = [
    { key: 'materials', id: 'code' },
    { key: 'locations', id: 'code' },
    { key: 'containers', id: 'code' },
    { key: 'members', id: 'code' },
    { key: 'items', id: 'code' },
    { key: 'manuals', id: 'code' },
    { key: 'workorders', id: 'code' },
    { key: 'transactions', id: 'seq' }
  ];
  var EPS = 1e-9;

  function isBlank(v) { return v === '' || v === null || v === undefined; }
  function eq(a, b) {
    if (isBlank(a) && isBlank(b)) return true;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < EPS;
    return a === b;
  }
  function keyOf(rec, id) {
    if (!rec) return null;
    var v = rec[id];
    if (v === undefined || v === null || v === '') return null;
    return String(v);
  }
  function indexBy(list, id) {
    var m = Object.create(null);
    (list || []).forEach(function (r) { var k = keyOf(r, id); if (k) m[k] = r; });
    return m;
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  /**
   * 三方合并计划（纯函数，不改任何入参）。
   *
   * @param {object} base   上次同步时的已确认基线（可为 null → 降级为两方保守策略）
   * @param {object} local  本地当前
   * @param {object} remote 飞书当前
   * @param {object} [opts] { protect, tables }
   * @returns {{
   *   writes:Array,        // 可自动应用的字段写入（远端单方改 / 新增 / 远端清空）
   *   conflicts:Array,     // 真双改，需要人工裁决
   *   groups:Array,        // 冲突按「表×类型×字段」分组后的展示单元（<50 组）
   *   deleteCandidates:Array, // 本地有、远端没有（删除判定另有闸门，这里只列出来）
   *   stats:object, degraded:boolean
   * }}
   */
  function planMerge(base, local, remote, opts) {
    opts = opts || {};
    var tables = opts.tables || MERGE_TABLES;
    var protect = opts.protect || {};
    // 没有 base → 无法判断谁改的 → 保守：所有「两边不一致」都转人工
    var degraded = !base || typeof base !== 'object';

    var out = { writes: [], conflicts: [], groups: [], deleteCandidates: [], degraded: degraded,
      stats: { tables: 0, autoFields: 0, conflicts: 0, creates: 0, unchanged: 0, deletes: 0 } };

    tables.forEach(function (tbl) {
      var rArr = remote ? remote[tbl.key] : null;
      if (!Array.isArray(rArr)) return;                    // 这次没拉到 → 完全不碰
      var lArr = (local && local[tbl.key]) || [];
      var bArr = (degraded || !base) ? [] : (base[tbl.key] || []);
      out.stats.tables++;

      var R = indexBy(rArr, tbl.id), L = indexBy(lArr, tbl.id), B = indexBy(bArr, tbl.id);
      var protTbl = protect[tbl.key] || {};
      var seen = Object.create(null);

      Object.keys(R).forEach(function (k) {
        seen[k] = true;
        var r = R[k], l = L[k], b = B[k];
        if (!l) {
          out.writes.push({ table: tbl.key, key: k, fields: clone(r), kind: b ? 'recreate' : 'create' });
          out.stats.creates++;
          return;
        }
        var guarded = Object.create(null);
        (protTbl[k] || []).forEach(function (f) { guarded[f] = true; });

        var fields = Object.create(null);
        Object.keys(r).forEach(function (f) {
          if (guarded[f]) return;                           // 上次没推上去 → 以本地为准
          var lv = l[f], rv = r[f], bv = b ? b[f] : undefined;
          if (eq(lv, rv)) { out.stats.unchanged++; return; }
          if (degraded) {
            // 降级：不知道 base，只认「本地空、远端非空」这种单向补齐；其余都问人
            if (isBlank(lv) && !isBlank(rv)) { fields[f] = rv; return; }
            out.conflicts.push({ table: tbl.key, key: k, field: f, base: undefined, local: lv, remote: rv, kind: 'update' });
            return;
          }
          if (eq(lv, bv)) { fields[f] = rv; return; }       // 本地没动 → 采纳远端（含远端清空）
          if (eq(rv, bv)) return;                           // 远端没动 → 保留本地
          out.conflicts.push({ table: tbl.key, key: k, field: f, base: bv, local: lv, remote: rv, kind: 'update' });
        });
        if (Object.keys(fields).length) {
          out.writes.push({ table: tbl.key, key: k, fields: fields, kind: 'update' });
          out.stats.autoFields += Object.keys(fields).length;
        }
      });

      // 本地有、远端没有
      Object.keys(L).forEach(function (k) {
        if (seen[k]) return;
        var l = L[k], b = B[k];
        if (degraded || !b) return;                         // 无 base / 本地新建 → 不动（由补推逻辑处理）
        out.deleteCandidates.push({ table: tbl.key, key: k, kind: 'delete' });
        out.stats.deletes++;
      });
    });

    out.stats.conflicts = out.conflicts.length;
    out.groups = groupConflicts(out.conflicts);
    return out;
  }

  /**
   * 冲突分组：按「表 × 变更类型 × 字段」聚合。
   *
   * 为什么必须分组：飞书里批量改 5000 行时逐条确认不是慢，是**不可用**。
   * 分组后 5000 条 → 不到 50 组，人只需要对这几十组做决定。
   */
  function groupConflicts(conflicts, opts) {
    opts = opts || {};
    var cap = opts.sampleCap == null ? 20 : opts.sampleCap;
    var map = Object.create(null);
    (conflicts || []).forEach(function (c) {
      var gk = c.table + '\u0000' + (c.kind || 'update') + '\u0000' + c.field;
      var g = map[gk];
      if (!g) {
        g = map[gk] = { table: c.table, kind: c.kind || 'update', field: c.field, count: 0, samples: [] };
      }
      g.count++;
      if (g.samples.length < cap) g.samples.push({ key: c.key, base: c.base, local: c.local, remote: c.remote });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  /**
   * 应用合并计划。
   *
   * @param {object} state        本地 state（就地修改）
   * @param {object} plan         planMerge 的结果
   * @param {object} [resolutions] 人工裁决：{ 'table\u0000key\u0000field': 'local'|'remote'|具体值 }
   * @returns {{applied:number, conflictsResolved:number, snapshot:object}}
   *   snapshot 交给 undoMerge 即可完全还原（deep-equal）
   */
  function applyMerge(state, plan, resolutions) {
    resolutions = resolutions || {};
    var snapshot = { tables: {}, at: new Date().toISOString() };

    function tableOf(key) { var t = (state[key] = state[key] || []); return t; }
    function find(table, id, key) {
      var list = state[table] || [];
      for (var i = 0; i < list.length; i++) if (list[i] && String(list[i][id]) === String(key)) return list[i];
      return null;
    }
    function snap(table) {
      if (!snapshot.tables[table]) snapshot.tables[table] = clone(state[table] || []);
    }

    var applied = 0;
    (plan.writes || []).forEach(function (w) {
      var id = idField(w.table);
      snap(w.table);
      var rec = find(w.table, id, w.key);
      if (!rec) {
        rec = {}; rec[id] = w.key;
        tableOf(w.table).push(rec);
      }
      Object.keys(w.fields).forEach(function (f) { rec[f] = w.fields[f]; });
      applied++;
    });

    var resolved = 0;
    (plan.conflicts || []).forEach(function (c) {
      var rid = c.table + '\u0000' + c.key + '\u0000' + c.field;
      var choice = resolutions[rid];
      if (choice === undefined) return;                    // 未裁决 → 保持本地原值
      snap(c.table);
      var rec = find(c.table, idField(c.table), c.key);
      if (!rec) return;
      rec[c.field] = (choice === 'remote') ? c.remote : (choice === 'local' ? c.local : choice);
      resolved++;
    });

    /* 流水后处理：**必须**做，否则增量路径会制造两个 bug。
       mergeRemote(mes-core.js) 与 applyRemoteChanges 都有这段，唯独生产在用的三方路径漏了：
         ① 顺序：applyMerge 对不存在的记录一律 push 到尾部 → 破坏「新的在前」约定，
            renderTxns 的 slice(0,50)（标注"最近 50 条"）就再也显示不到新流水；
         ② txnSeq：不推进的话，本地下一笔 recordTransaction 会拿到**已被远端占用的 seq**
            —— 正是 Phase 0 修掉的撞号问题在这条路径上复活。
       与另外两份实现保持完全相同的排序与取最大语义。 */
    if (Array.isArray(state.transactions)) {
      var withSeq = state.transactions.filter(function (x) { return x && x.seq != null; });
      var noSeq = state.transactions.filter(function (x) { return !x || x.seq == null; });
      withSeq.sort(function (a, b) { return (b.seq || 0) - (a.seq || 0); });
      state.transactions = withSeq.concat(noSeq);
      var mx = state.txnSeq || 0;
      state.transactions.forEach(function (x) { if ((x.seq || 0) > mx) mx = x.seq || 0; });
      state.txnSeq = mx;
    }

    // 冲销式撤销记录：删除候选不在这里自动执行（要过 census 闸门）
    return { applied: applied, conflictsResolved: resolved, snapshot: snapshot };
  }

  /** 回滚一次 applyMerge：把快照里的表原样写回 */
  function undoMerge(state, snapshot) {
    if (!snapshot || !snapshot.tables) return 0;
    var n = 0;
    Object.keys(snapshot.tables).forEach(function (t) { state[t] = clone(snapshot.tables[t]); n++; });
    return n;
  }

  function idField(table) {
    for (var i = 0; i < MERGE_TABLES.length; i++) if (MERGE_TABLES[i].key === table) return MERGE_TABLES[i].id;
    return 'code';
  }

  /** 把 plan 变成一句人话（面板/日志用） */
  function planText(plan) {
    if (!plan) return '无计划';
    var s = plan.stats;
    var parts = ['表 ' + s.tables];
    if (s.creates) parts.push('新增 ' + s.creates);
    if (s.autoFields) parts.push('自动快进 ' + s.autoFields + ' 字段');
    if (s.conflicts) parts.push('需确认 ' + s.conflicts);
    if (s.deletes) parts.push('待核删 ' + s.deletes);
    if (plan.degraded) parts.push('（无基线，已降级为保守策略）');
    return parts.join('、');
  }

  return {
    MERGE_TABLES: MERGE_TABLES,
    planMerge: planMerge,
    groupConflicts: groupConflicts,
    applyMerge: applyMerge,
    undoMerge: undoMerge,
    planText: planText,
    _eq: eq, _isBlank: isBlank
  };
});
