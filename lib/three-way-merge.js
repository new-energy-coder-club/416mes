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
  /** 取 6 位小数，消除浮点累加噪声（与 mes-core 的 round6 同一约定） */
  function round6(v) { return Math.round((Number(v) || 0) * 1e6) / 1e6; }
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
          /* from:'remote-ff' 标记「这是远端单方改动，本地没动 → 采纳远端」。
             必须标记：applyMerge 里有一道闸门专门剥掉「更新型」的绝对 qty
             （防止有人绕过账本覆盖库存），但那道闸门**不能连这条合法路径一起拦** ——
             拦了的话增量同步就再也同步不回飞书的库存数量。 */
          out.writes.push({ table: tbl.key, key: k, fields: fields, kind: 'update', from: 'remote-ff' });
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
    /* 快照必须**连 __base 一起**存。
       只回退数据不回退基线，会让「本地其实没改」在下一次合并里被误判成「本地改过」
       （base 还停在远端的新值上，而本地已经被回退成旧值），于是旧值会被当成
       一笔新改动推回飞书，把对方的修改覆盖掉 —— 回滚反而制造了新的数据损坏。 */
    var snapshot = {
      tables: {}, at: new Date().toISOString(),
      // hadBase 记录「原本到底有没有这个键」：原本没有时回滚必须把它删掉，
      // 而不是留下一个 __base:null —— 那会让「回滚后状态完全不变」不成立
      // （deep-equal 断言就是这么抓到我的）。
      hadBase: Object.prototype.hasOwnProperty.call(state, '__base'),
      base: clone(state.__base === undefined ? null : state.__base)
    };

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
    var strippedQty = [];
    (plan.writes || []).forEach(function (w) {
      var id = idField(w.table);
      snap(w.table);
      var rec = find(w.table, id, w.key);
      if (!rec) {
        rec = {}; rec[id] = w.key;
        tableOf(w.table).push(rec);
      }
      /* 最后一道闸门：materials.qty 在这条路径上只可能来自 planMerge 的「自动快进」
         （本地没动、采纳远端），它是飞书自己的值，落地无害；而 `kind:'update'` 里
         带的绝对 qty 一定是某处想绕过账本覆盖库存。
         **必须在赋值之前剥掉** —— 先赋 999 再 delete 会把原本的 qty 一起删掉
         （测试就是这么抓到的：本地 10 变成了 undefined）。 */
      var applyFields = w.fields;
      /* 只拦**没有来源标记**的更新型 qty。带 from:'remote-ff' 的是 planMerge 的
         「本地没动 → 采纳远端」，那是飞书自己的值，必须放行（拦了增量同步就再也
         同步不回库存数量）。没标记的更新型绝对 qty 一定是绕过账本的写法，剥掉。 */
      var isRemoteFF = w.from === 'remote-ff';
      if (w.table === 'materials' && w.kind === 'update' && !isRemoteFF &&
          Object.prototype.hasOwnProperty.call(w.fields, 'qty')) {
        applyFields = Object.assign({}, w.fields);
        strippedQty.push({ key: w.key, qty: applyFields.qty });
        delete applyFields.qty;
      }
      Object.keys(applyFields).forEach(function (f) { rec[f] = applyFields[f]; });
      applied++;
    });

    var resolved = 0;
    /* 需要走「库存直写」（即记一条流水）的变动。qty 不能当普通字段绝对值覆盖，
       理由见下面 materials.qty 分支的说明。 */
    var stockWrites = [];
    var needsStocktake = [];
    (plan.conflicts || []).forEach(function (c) {
      var rid = c.table + '\u0000' + c.key + '\u0000' + c.field;
      var choice = resolutions[rid];
      if (choice === undefined) return;                    // 未裁决 → 保持本地原值
      snap(c.table);
      var rec = find(c.table, idField(c.table), c.key);
      if (!rec) return;

      /* **qty 是派生量，不是可以直接覆盖的普通字段。**
         它必须等于账本的「期初 + Σ变动」；而「保留本地」的真正含义是
         「把本地这次改动也应用上去」，不是「把本地那个绝对值写进去」。
         直接写绝对值 `c.local`：两端并发时会把对方在我们读取快照之后做的改动
         整段抹掉（对方 +5，我们写回自己算的绝对值，那 +5 就没了）。
         正确写法 = 远端值 + (本地值 − 基线值)，并且**必须走库存直写**，
         这样账本里会留下一条流水，qty 由账本收敛而不是被覆盖。 */
      if (c.table === 'materials' && c.field === 'qty' && typeof choice !== 'number') {
        if (choice === 'remote') {
          rec.qty = c.remote;                             // 与飞书一致，不需要写回
        } else {
          var b = (typeof c.base === 'number') ? c.base : null;
          var l = (typeof c.local === 'number') ? c.local : null;
          var r = (typeof c.remote === 'number') ? c.remote : null;
          if (b === null || l === null || r === null) {
            // 没有基线就换算不出增量（降级模式）→ 不猜。绝对值只能走「盘点」。
            needsStocktake.push({ table: c.table, key: c.key, base: c.base, local: c.local, remote: c.remote });
          } else {
            var d = round6(l - b);
            var want = round6(r + d);
            rec.qty = want;
            if (Math.abs(d) > 1e-9) {
              stockWrites.push({
                matCode: c.key, qty: want, delta: d, type: '冲突裁决',
                reason: '冲突裁决：保留本地改动（相对基线 ' + d + '）'
              });
            }
          }
        }
        resolved++;
        return;
      }

      if (typeof choice === 'number') {
        /* 调用方显式给了具体值：如果是 qty，同样必须走账本，不能直接覆盖。 */
        if (c.table === 'materials' && c.field === 'qty') {
          var cur = (typeof c.remote === 'number') ? c.remote : c.local;
          var dd = round6(choice - cur);
          rec.qty = choice;
          if (Math.abs(dd) > 1e-9) {
            stockWrites.push({ matCode: c.key, qty: choice, delta: dd, type: '冲突裁决', reason: '冲突裁决：人工指定值' });
          }
          resolved++;
          return;
        }
        rec[c.field] = choice;
        resolved++;
        return;
      }

      rec[c.field] = (choice === 'remote') ? c.remote : c.local;
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
    return {
      applied: applied, conflictsResolved: resolved, snapshot: snapshot,
      stockWrites: stockWrites,        // 调用方必须用库存直写提交（会记流水）
      needsStocktake: needsStocktake,  // 缺基线无法换算增量 → 提示走「盘点」
      strippedQty: strippedQty         // 被剥掉的「更新型绝对 qty」（正常应为空）
    };
  }

  /** 回滚一次 applyMerge：把快照里的表**和基线**原样写回 */
  function undoMerge(state, snapshot) {
    if (!snapshot || !snapshot.tables) return 0;
    var n = 0;
    Object.keys(snapshot.tables).forEach(function (t) { state[t] = clone(snapshot.tables[t]); n++; });
    /* 基线必须一起回退（旧格式快照没有 hadBase → 跳过，保持向后兼容）。
       不回退基线的话，「本地其实没改」会在下一次合并里被误判成「本地改过」，
       于是被回退的旧值会被当成一笔新改动推回飞书，把对方的修改覆盖掉。 */
    if ('hadBase' in snapshot) {
      if (snapshot.hadBase) state.__base = clone(snapshot.base);
      else delete state.__base;
      n++;
    }
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
