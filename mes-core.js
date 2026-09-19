/*!
 * mes-core.js — 416MES 核心库存规则（纯逻辑：无 DOM、无网络、无 localStorage）
 *
 * 浏览器：<script src="mes-core.js"></script>  →  window.MesCore
 * Node 测试：const MesCore = require('./mes-core.js')
 *
 * 设计约束（对应 416MES分阶段开发计划.md Phase 1）：
 *   1. 库存数量的任何变化都必须经过 applyStockChange（改数量与写流水不可分离）；
 *   2. 流水只能追加，seq 单调递增，balance 记录写入后的真实库存；
 *   3. 出库前必须按物料汇总后再校验库存（修复重复物料扣成负库存）；
 *   4. 盘点输入非法一律拒绝，绝不静默转 0；
 *   5. 工单保留计划数量（item.qty），执行数量单独记录（execQty / execBatches）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MesCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WIP_NAMES = { LL: '领料工单', BH: '补货工单', JH: '拣货工单', TL: '退料工单' };
  var OUTBOUND_TYPES = ['LL', 'JH'];          // 领料 / 拣货 = 出库（扣减库存）
  var BLOCKED_STATUSES = ['已执行', '已取消']; // 不可再次执行的状态
  var EPS = 1e-9;

  /* 工单状态模型（Phase 3）：
     待执行 → 部分执行 → 已执行
        └────────┴──→ 已取消（未执行时直接取消；已执行后冲销再置为已取消）
     历史数据里「未执行」等同于「待执行」，读写保持兼容（飞书/Excel 单选项仍是「未执行」）。*/
  var STATUS = { PENDING: '未执行', PARTIAL: '部分执行', DONE: '已执行', CANCELLED: '已取消' };
  var PENDING_ALIASES = ['未执行', '待执行'];
  var STATUS_LABELS = { '未执行': '待执行', '待执行': '待执行', '部分执行': '部分执行', '已执行': '已执行', '已取消': '已取消' };

  function statusLabel(s) { return STATUS_LABELS[s] || s || '待执行'; }
  function isPending(order) { return !!order && PENDING_ALIASES.indexOf(order.status) >= 0; }
  function isCancelled(order) { return !!order && order.status === STATUS.CANCELLED; }
  function isFullyExecuted(order) { return !!order && order.status === STATUS.DONE; }
  function isPartiallyExecuted(order) { return !!order && order.status === STATUS.PARTIAL; }
  function isOrderOpen(order) { return isPending(order) || isPartiallyExecuted(order); }

  /* ================= 基础工具 ================= */

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  /** 宽松数值解析：空 / 非数字返回 null（绝不返回 0 冒充合法值） */
  function toQty(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'boolean') return null;
    var n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  }

  function isOutbound(type) { return OUTBOUND_TYPES.indexOf(type) >= 0; }
  function signOf(type) { return isOutbound(type) ? -1 : 1; }

  function findMaterial(state, code) {
    var list = (state && state.materials) || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }

  function findOrder(state, code) {
    var list = (state && state.workorders) || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }

  /** 唯一物品（state.items，G1 物品化工单的操作对象） */
  function findItem(state, code) {
    var list = (state && state.items) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].code === code) return list[i];
    return null;
  }

  function isOrderExecuted(order) {
    return !!order && BLOCKED_STATUSES.indexOf(order.status) >= 0;
  }

  /* ================= 工单进度：计划 / 已执行 / 剩余 ================= */

  /** 把 order.execQty 汇总成 { matCode: 已执行数量 } */
  function executedMap(order) {
    var map = Object.create(null);
    ((order && order.execQty) || []).forEach(function (e) {
      if (!e || !e.matCode) return;
      var q = toQty(e.qty);
      if (q === null || q <= 0) return;
      map[e.matCode] = round6((map[e.matCode] || 0) + q);
    });
    return map;
  }

  /**
   * 工单进度：每个物料的计划数量 / 已执行数量 / 剩余数量。
   * 计划数量取 item.qty（Phase 1 起执行不再改写它）；已执行取 execQty 累计。
   * 兼容 Phase 1 之前「已执行但无 execQty」的旧数据：视为按计划全额执行。
   */
  function orderProgress(order) {
    if (isItemizedOrder(order)) return itemizedOrderProgress(order);
    var planned = normalizeItems(order && order.items).items;
    var exec = executedMap(order);
    var hasExecRecord = Object.keys(exec).length > 0;
    var legacyDone = !!order && order.status === STATUS.DONE && !hasExecRecord;

    var items = planned.map(function (e) {
      var done = legacyDone ? e.qty : (exec[e.matCode] || 0);
      if (done > e.qty) done = e.qty;            // 防御：已执行不得超过计划
      return { matCode: e.matCode, planned: e.qty, executed: round6(done), remaining: round6(e.qty - done) };
    });

    var plannedTotal = 0, executedTotal = 0;
    items.forEach(function (i) { plannedTotal = round6(plannedTotal + i.planned); executedTotal = round6(executedTotal + i.executed); });
    var anyExecuted = items.some(function (i) { return i.executed > 0; });
    var fullyExecuted = items.length > 0 && items.every(function (i) { return i.remaining <= 0; });

    return {
      items: items,
      plannedTotal: plannedTotal,
      executedTotal: executedTotal,
      remainingTotal: round6(plannedTotal - executedTotal),
      anyExecuted: anyExecuted,
      fullyExecuted: fullyExecuted,
      percent: plannedTotal > 0 ? Math.round(executedTotal / plannedTotal * 100) : 0
    };
  }

  /** 工单列表用的摘要 */
  function orderSummary(order) {
    var p = orderProgress(order);
    return {
      code: order && order.code,
      type: order && order.type,
      typeName: WIP_NAMES[order && order.type] || (order && order.type) || '',
      date: (order && order.date) || '',
      status: (order && order.status) || STATUS.PENDING,
      statusLabel: statusLabel(order && order.status),
      itemCount: p.items.length,
      plannedTotal: p.plannedTotal,
      executedTotal: p.executedTotal,
      remainingTotal: p.remainingTotal,
      percent: p.percent,
      batchCount: ((order && order.execBatches) || []).length,
      execTime: (order && order.execTime) || '',
      cancelled: isCancelled(order),
      reversed: !!(order && order.reverseInfo)
    };
  }

  /* ================= 明细归一化（同一物料多行 → 合并） ================= */

  /**
   * 把任意明细数组归一化为「每个物料一行、数量为该物料各行之和」。
   * 无效行（无物料码 / 数量非正 / 数量非法）被丢弃并记入 dropped。
   * @returns {{items: Array<{matCode:string, qty:number, lines:number}>, dropped: Array<{raw:any, reason:string}>}}
   */
  function normalizeItems(items) {
    var order = [];
    var map = Object.create(null);
    var dropped = [];
    (items || []).forEach(function (it, idx) {
      var code = String((it && it.matCode) != null ? it.matCode : '').trim();
      var qty = toQty(it && it.qty);
      if (!code) { dropped.push({ raw: it, index: idx, reason: '缺少物料码' }); return; }
      if (qty === null) { dropped.push({ raw: it, index: idx, reason: '数量非法：' + (it && it.qty) }); return; }
      if (qty <= 0) { dropped.push({ raw: it, index: idx, reason: '数量必须为正：' + qty }); return; }
      if (!map[code]) { map[code] = { matCode: code, qty: 0, lines: 0 }; order.push(code); }
      map[code].qty = round6(map[code].qty + qty);
      map[code].lines += 1;
    });
    return { items: order.map(function (c) { return map[c]; }), dropped: dropped };
  }

  /** 被合并过的物料码（原始行数 > 1） */
  function mergedCodes(normalized) {
    return (normalized || []).filter(function (e) { return e.lines > 1; }).map(function (e) { return e.matCode; });
  }

  /* ================= 物品化工单（G1：按唯一物品码逐件执行） =================
   *
   * 与「物料 × 数量」的旧形态并存，靠数据形态区分：
   *   旧形态  items=[{matCode, qty}]          execQty=[{matCode, qty}]
   *   物品化  items=[{itemCodes:[码…]}]       execItems=[已 APPLIED 的物品码]
   * 物品化执行的是「唯一物品」的位置变更（issue/receive），由物品操作协议落地；
   * 这里只记工单进度，**绝不**经过 applyStockChange / state.transactions ——
   * 物品不是物料数量，混进库存流水会把两套账都污染。
   */

  /**
   * 物品化工单判别：显式 itemized:true，或明细首行就是物品码行（itemCodes）。
   * 物品化行没有 matCode/qty —— 凡是按 matCode 处理的旧逻辑（normalizeItems、
   * canonicalOrder 旧分支）都会把它们静默丢光，所以判别必须先于一切归一化。
   */
  function isItemizedOrder(order) {
    if (!order) return false;
    if (order.itemized === true) return true;
    var items = order.items;
    return !!(Array.isArray(items) && items.length && items[0] && Array.isArray(items[0].itemCodes));
  }

  /**
   * 物品化明细归一化：
   *   · 无效行（没有 itemCodes / 清空后一个码都不剩）→ dropped，不静默保留；
   *   · 同一物品码在整单出现第二次 → duplicates。物品是唯一的，同码两件在同一单里
   *     没有业务意义，还会把「已扫 / 未扫」判错 —— 所以重复必须让调用方**拒绝**，
   *     而不是像物料那样合并数量。
   * 不做跨行合并：每一行是有业务含义的分组（同一批 / 同一托），行结构原样保留。
   * @returns {{items: Array<{itemCodes:string[]}>, dropped: Array, duplicates: string[]}}
   */
  function normalizeItemLines(items) {
    var lines = [], dropped = [], dups = [];
    var seen = Object.create(null), dupSeen = Object.create(null);
    (items || []).forEach(function (it, idx) {
      var raw = (it && Array.isArray(it.itemCodes)) ? it.itemCodes : null;
      if (!raw) { dropped.push({ raw: it, index: idx, reason: '缺少物品码列表' }); return; }
      var codes = [];
      raw.forEach(function (c) {
        var s = String(c == null ? '' : c).trim();
        if (s) codes.push(s);
      });
      if (!codes.length) { dropped.push({ raw: it, index: idx, reason: '物品码列表为空' }); return; }
      codes.forEach(function (s) {
        if (seen[s]) { if (!dupSeen[s]) { dupSeen[s] = true; dups.push(s); } }
        else seen[s] = true;
      });
      lines.push({ itemCodes: codes });
    });
    return { items: lines, dropped: dropped, duplicates: dups };
  }

  /** 物品化工单的全部计划码（跨行拍平，保持出现顺序） */
  function itemizedPlannedCodes(order) {
    var out = [];
    normalizeItemLines(order && order.items).items.forEach(function (l) {
      l.itemCodes.forEach(function (c) { out.push(c); });
    });
    return out;
  }

  function codeSet(list) {
    var set = Object.create(null);
    (list || []).forEach(function (c) { set[String(c)] = true; });
    return set;
  }

  /**
   * 物品化进度：plannedTotal = Σ 各行 itemCodes.length；executedTotal = 已 APPLIED 的
   * 计划码个数（= 良构数据下的 execItems.length；只数属于本单的码，脏数据不会把
   * 进度推出 100%）。兼容「已执行但无 execItems」的旧数据：视为全扫完。
   */
  function itemizedOrderProgress(order) {
    var lines = normalizeItemLines(order && order.items).items;
    var execSet = codeSet(order && order.execItems);
    var legacyDone = !!order && order.status === STATUS.DONE && Object.keys(execSet).length === 0;

    var plannedTotal = 0, executedTotal = 0;
    var items = lines.map(function (l) {
      var planned = l.itemCodes.length;
      var executed = legacyDone ? planned : l.itemCodes.filter(function (c) { return execSet[c]; }).length;
      plannedTotal += planned;
      executedTotal += executed;
      return { itemCodes: l.itemCodes.slice(), planned: planned, executed: executed, remaining: planned - executed };
    });

    return {
      items: items,
      itemized: true,
      plannedTotal: plannedTotal,
      executedTotal: executedTotal,
      remainingTotal: plannedTotal - executedTotal,
      anyExecuted: executedTotal > 0,
      fullyExecuted: plannedTotal > 0 && executedTotal >= plannedTotal,
      percent: plannedTotal > 0 ? Math.round(executedTotal / plannedTotal * 100) : 0
    };
  }

  /* ================= 工单创建 ================= */

  /**
   * 创建工单：校验物料存在性 + 自动合并重复物料。
   * @returns {{ok:boolean, errors:string[], order?:object, merged?:string[], dropped?:Array}}
   */
  function createOrder(state, opts) {
    opts = opts || {};
    /* 物品化分支：判别必须看原始 opts.items —— 物品化行没有 matCode，
       一旦先进 normalizeItems 会被全部丢弃，连「这是物品化单」都判不出来。 */
    if (opts.itemized === true || (Array.isArray(opts.items) && opts.items.length && opts.items[0] && Array.isArray(opts.items[0].itemCodes))) {
      return createItemizedOrder(state, opts);
    }
    var type = opts.type;
    var errors = [];
    if (!type) errors.push('缺少工单类型');
    var norm = normalizeItems(opts.items);
    if (!norm.items.length) errors.push('请至少添加一行有效明细（物料码 + 正数数量）');
    if (!state || !Array.isArray(state.workorders)) errors.push('state.workorders 不可用');

    var missing = [];
    norm.items.forEach(function (e) {
      if (!findMaterial(state, e.matCode)) missing.push(e.matCode);
    });
    if (missing.length) errors.push('物料未建档：' + missing.join('、'));

    if (errors.length) return { ok: false, errors: errors, dropped: norm.dropped, merged: mergedCodes(norm.items) };

    var order = {
      code: opts.code,
      type: type,
      date: opts.date || '',
      items: norm.items.map(function (e) { return { matCode: e.matCode, qty: e.qty }; }),  // 计划数量
      status: '未执行',
      execTime: '',
      execQty: [],
      execBatches: []
    };
    /* B10 闸门：同一工单号不能建两张单。
       实测踩过：新建按钮是 async 且无重入闸门，取号又在 await 之前读本地计数器
       （窗口最长 8 秒）→ 连点 6 次全都算出同一个号，本地出现 6 条同号工单；
       推送时又被飞书按业务键折叠成 1 行 → 界面报「本地多 5」，且那条差永远消不掉。
       code 为空的历史用法（旧测试/内部构造）不受影响，判空必须保留。 */
    if (opts.code && state.workorders.some(function (w) { return w && w.code === opts.code; })) {
      return { ok: false, errors: ['工单号已存在：' + opts.code + '（同一工单号不能建两张单）'],
        dropped: norm.dropped, merged: mergedCodes(norm.items) };
    }
    state.workorders.push(order);
    return { ok: true, errors: [], order: order, merged: mergedCodes(norm.items), dropped: norm.dropped };
  }

  /**
   * 创建物品化工单：明细是物品码行（itemCodes），不是「物料 × 数量」。
   * 校验规则：
   *   · 物品必须已建档（state.items 里找得到）—— 扫码执行的对象必须真实存在；
   *   · **不校验在库状态**：建单时物品可以在任何状态，方向匹配是扫码那一刻的事
   *     （见 validateItemScan），建单就锁死状态会让「先建单后收货」没法做；
   *   · 同一物品码重复 → 拒绝（normalizeItemLines 只报告，这里落实拒绝）。
   */
  function createItemizedOrder(state, opts) {
    var errors = [];
    var type = opts.type;
    if (!type) errors.push('缺少工单类型');
    var norm = normalizeItemLines(opts.items);
    if (!norm.items.length) errors.push('请至少添加一行有效明细（物品码列表）');
    if (norm.duplicates.length) {
      errors.push('同一物品码重复：' + norm.duplicates.join('、') + '（同一物品在同一单中只能出现一次）');
    }
    if (!state || !Array.isArray(state.workorders)) errors.push('state.workorders 不可用');

    var missing = [];
    norm.items.forEach(function (l) {
      l.itemCodes.forEach(function (c) { if (!findItem(state, c)) missing.push(c); });
    });
    if (missing.length) errors.push('物品未建档：' + missing.join('、'));

    if (errors.length) return { ok: false, errors: errors, dropped: norm.dropped, duplicates: norm.duplicates };

    var order = {
      code: opts.code,
      type: type,
      date: opts.date || '',
      itemized: true,                              // 判别位：物品化工单
      items: norm.items.map(function (l) { return { itemCodes: l.itemCodes.slice() }; }),
      status: '未执行',
      execTime: '',
      execQty: [],                                 // 物品化单恒为空（旧列占位，保持字段形状一致）
      execItems: [],                               // 已 APPLIED 的物品码
      execBatches: []
    };
    /* B10 闸门同旧形态：同一工单号不能建两张单 */
    if (opts.code && state.workorders.some(function (w) { return w && w.code === opts.code; })) {
      return { ok: false, errors: ['工单号已存在：' + opts.code + '（同一工单号不能建两张单）'],
        dropped: norm.dropped, duplicates: norm.duplicates };
    }
    state.workorders.push(order);
    return { ok: true, errors: [], order: order, duplicates: [], dropped: norm.dropped };
  }

  /* ================= 工单同键重复：诊断与安全收敛 ================= */

  /** 深拷贝 JSON 业务数据（工单对象只含可序列化字段） */
  function cloneJson(v) { return JSON.parse(JSON.stringify(v)); }

  /** 键序稳定的序列化；数组顺序保留（执行批次顺序有业务意义） */
  function stableJson(v) {
    if (v === null || v === undefined) return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    if (typeof v !== 'object') return JSON.stringify(v);
    var ks = Object.keys(v).sort();
    return '{' + ks.map(function (k) { return JSON.stringify(k) + ':' + stableJson(v[k]); }).join(',') + '}';
  }

  /**
   * 规范化一张工单供「同号是否同内容」比较。
   * items/execQty 按 matCode 合并并排序；execBatches 保序（先后次序有审计意义）。
   * UI 临时字段不参与；缺省值统一，避免「undefined vs 空数组」制造假差异。
   */
  function canonicalOrder(order) {
    order = order || {};
    /* P0：物品化单必须按物品化形态规范化 —— 物品化行没有 matCode，
       走下面的 normalizeItems 会被全部丢光，于是两张「同号不同码」的物品化单
       都规范化成 items:[]，被误判成内容全同而允许收敛删单。 */
    if (isItemizedOrder(order)) {
      /* 行结构只是录入时的分组；飞书明细列是扁平 token 流，上行/下行后行边界丢失。
         身份比较必须落在「扁平排序后的码集合」上，否则同一张单按单行/多行录入
         会被误判内容不同（或更糟：被误判全同）。 */
      var lines = [{ itemCodes: itemizedPlannedCodes(order).sort() }];
      var execItems = Object.keys(codeSet(order.execItems)).sort();
      return {
        code: String(order.code || '').trim(),
        type: order.type || '', date: order.date || '', status: order.status || '未执行',
        itemized: true,
        items: lines, execTime: order.execTime || '', execItems: execItems,
        execBatches: cloneJson(order.execBatches || []),
        reverseInfo: order.reverseInfo ? cloneJson(order.reverseInfo) : null,
        cancelInfo: order.cancelInfo ? cloneJson(order.cancelInfo) : null
      };
    }
    var items = normalizeItems(order.items).items.map(function (e) {
      return { matCode: e.matCode, qty: e.qty };
    }).sort(function (a, b) { return a.matCode.localeCompare(b.matCode); });
    var execQty = normalizeItems(order.execQty).items.map(function (e) {
      return { matCode: e.matCode, qty: e.qty };
    }).sort(function (a, b) { return a.matCode.localeCompare(b.matCode); });
    return {
      code: String(order.code || '').trim(),
      type: order.type || '', date: order.date || '', status: order.status || '未执行',
      items: items, execTime: order.execTime || '', execQty: execQty,
      execBatches: cloneJson(order.execBatches || []),
      reverseInfo: order.reverseInfo ? cloneJson(order.reverseInfo) : null,
      cancelInfo: order.cancelInfo ? cloneJson(order.cancelInfo) : null
    };
  }

  /** 扫描本地同工单号重复；不修改 state */
  function workorderDuplicateGroups(state) {
    var map = Object.create(null), blank = [];
    ((state && state.workorders) || []).forEach(function (w, index) {
      var code = String((w && w.code) || '').trim();
      if (!code) { blank.push({ index: index, order: w }); return; }
      (map[code] = map[code] || []).push({ index: index, order: w });
    });
    var groups = [];
    Object.keys(map).forEach(function (code) {
      var rows = map[code];
      if (rows.length < 2) return;
      rows.forEach(function (r) {
        r.canonical = canonicalOrder(r.order);
        r.fingerprint = stableJson(r.canonical);
      });
      var same = rows.every(function (r) { return r.fingerprint === rows[0].fingerprint; });
      var fields = ['type', 'date', 'status', 'items', 'execTime', 'execQty', 'execBatches', 'reverseInfo', 'cancelInfo'];
      var diffFields = fields.filter(function (f) {
        return rows.some(function (r) { return stableJson(r.canonical[f]) !== stableJson(rows[0].canonical[f]); });
      });
      groups.push({ code: code, count: rows.length, identical: same, diffFields: diffFields, rows: rows });
    });
    return { groups: groups, blank: blank };
  }

  /**
   * 只收敛「同号且业务内容完全相同」的一组：保留原数组第一行，删除其余本地副本。
   * 纯本地数组变换，绝不触发飞书 delete；返回 beforeRows 供 UI 写回退凭据。
   */
  function collapseIdenticalWorkorderDuplicates(state, code) {
    if (!state || !Array.isArray(state.workorders)) return { ok: false, error: 'state.workorders 不可用' };
    code = String(code || '').trim();
    if (!code) return { ok: false, error: '工单号为空，禁止自动收敛' };
    var report = workorderDuplicateGroups(state);
    var group = report.groups.find(function (g) { return g.code === code; });
    if (!group) return { ok: false, error: '没有找到同号重复工单：' + code };
    if (!group.identical) return { ok: false, error: '同号工单内容不同，禁止自动收敛', diffFields: group.diffFields };
    var beforeRows = cloneJson(group.rows.map(function (r) { return r.order; }));
    var beforeAll = cloneJson(state.workorders);
    var keepIndex = group.rows[0].index;
    state.workorders = state.workorders.filter(function (w, index) {
      return String((w && w.code) || '').trim() !== code || index === keepIndex;
    });
    return {
      ok: true, code: code, removed: group.count - 1, keptIndex: keepIndex,
      beforeRows: beforeRows, beforeAll: beforeAll,
      afterHash: stableJson(state.workorders), fingerprint: group.rows[0].fingerprint
    };
  }

  /** 仅在去重后整份工单列表没有再变化时允许回退，避免覆盖后续新建/执行/编辑 */
  function restoreWorkorderDuplicateCollapse(state, journal) {
    if (!state || !Array.isArray(state.workorders)) return { ok: false, error: 'state.workorders 不可用' };
    if (!journal || !Array.isArray(journal.beforeAll) || !journal.afterHash) return { ok: false, error: '回退凭据不完整' };
    if (stableJson(state.workorders) !== journal.afterHash) {
      return { ok: false, error: '去重后工单数据已经发生变化，为避免覆盖后续操作，拒绝回退' };
    }
    state.workorders = cloneJson(journal.beforeAll);
    return { ok: true, restored: state.workorders.length };
  }

  /* ================= 统一流水写入（唯一入口） ================= */

  /**
   * 追加一条库存流水。只增不改；seq 单调递增；balance 默认取该物料当前库存。
   * @returns {object} 写入的流水记录
   */
  function recordTransaction(state, entry) {
    entry = entry || {};
    if (!state) throw new Error('recordTransaction: 缺少 state');
    if (!Array.isArray(state.transactions)) state.transactions = [];
    state.txnSeq = (state.txnSeq || 0) + 1;

    var matCode = entry.matCode;
    var delta = toQty(entry.delta);
    if (delta === null) delta = 0;
    var balance = entry.balance;
    if (balance === undefined || balance === null) {
      var m = findMaterial(state, matCode);
      balance = m ? (toQty(m.qty) === null ? '' : toQty(m.qty)) : '';
    }
    var now = entry.now ? new Date(entry.now) : new Date();
    var txn = {
      seq: state.txnSeq,
      ts: now.toISOString(),
      device: entry.device || state.deviceId || '',
      time: now.toLocaleString(),
      operator: entry.operator != null ? entry.operator : (state.operator || ''),
      type: entry.type || '',
      matCode: matCode,
      delta: delta,
      ref: entry.ref || '',
      balance: balance,
      reason: entry.reason || ''
    };
    state.transactions.unshift(txn);
    return txn;
  }

  /**
   * 把服务端分配的流水号回写到本地那条乐观流水上。
   *
   * 为什么必须有这一步：本地 `recordTransaction` 用自己的计数器分配 seq，
   * 而服务端 `writeStock` 另有一套「全表最大 +1」的分配。两边在下面两种情况
   * **必然不同**：
   *   · 另一台设备刚写过（本地计数器落后）
   *   · 本次是超时重放，服务端按操作ID 返回上次那条的 seq
   * 不回写的后果不是"序号难看"，而是**账本里同一次操作变成两条流水**：
   * 下次拉取时远端那条 seq 在本地找不到 → 当成新记录插进来；本地那条乐观 seq
   * 远端没有 → 被当成「本地新建、飞书还没有」→ 永久停在待推送列表里。
   *
   * @param {object} state
   * @param {{localSeq:number, serverSeq:number, opId?:string}} opts
   * @returns {{ok:boolean, action:string, seq?:number, removed?:number}}
   *   action: 'updated'  已改号（正常路径）
   *           'merged'   本地已存在该 seq（自己那笔被拉回来了）→ 删掉乐观那条
   *           'missing'  找不到本地那条（已被用户撤回/已对好）→ 什么都不做
   *           'noop'     两个号相同，本来就不用改
   */
  function reconcileTxnSeq(state, opts) {
    opts = opts || {};
    if (!state || !Array.isArray(state.transactions)) return { ok: false, action: 'missing' };
    var localSeq = opts.localSeq == null ? null : Number(opts.localSeq);
    var serverSeq = opts.serverSeq == null ? null : Number(opts.serverSeq);
    if (localSeq === null || serverSeq === null || !isFinite(localSeq) || !isFinite(serverSeq)) {
      return { ok: false, action: 'missing' };
    }
    var mine = state.transactions.find(function (t) { return t && Number(t.seq) === localSeq; });
    if (!mine) {
      /* 找不到乐观那条，但服务端那个号在本地已经存在 → 说明**上一轮已经对好了**
         （典型：响应丢了导致同一个条目被重试，而本地那条早已改成服务端号）。
         这不是异常，报 noop 而不是 missing，免得每次重试都刷一行看起来像故障的日志。 */
      var already = state.transactions.find(function (t) { return t && Number(t.seq) === serverSeq; });
      return already ? { ok: true, action: 'noop', seq: serverSeq } : { ok: false, action: 'missing' };
    }
    if (localSeq === serverSeq) {
      if (opts.opId) mine.opId = opts.opId;
      return { ok: true, action: 'noop', seq: serverSeq };
    }
    var clash = state.transactions.find(function (t) { return t && t !== mine && Number(t.seq) === serverSeq; });
    if (clash) {
      /* 服务端那个号在本地已经有了 —— 说明这一笔（我们自己写的）已经被拉回来过。
         乐观那条是重复的，删掉；保留拉回来的那条（它的字段是服务端权威值）。 */
      state.transactions = state.transactions.filter(function (t) { return t !== mine; });
      if (opts.opId) clash.opId = clash.opId || opts.opId;
      return { ok: true, action: 'merged', seq: serverSeq, removed: 1 };
    }
    mine.seq = serverSeq;
    if (opts.opId) mine.opId = opts.opId;
    /* txnSeq 必须跟着抬到 serverSeq 之上，否则下一笔本地流水又会被分配一个
       已经被占用的号 —— 那正是 Phase 0 撞号 bug 的复现路径。 */
    if (!(Number(state.txnSeq) >= serverSeq)) state.txnSeq = serverSeq;
    // 维持全局约定「新的在前」
    if (typeof orderedTransactions === 'function') state.transactions = orderedTransactions(state);
    return { ok: true, action: 'updated', seq: serverSeq };
  }

  /* ================= 库存变动（唯一写入口） ================= */

  /**
   * 库存数量的唯一修改入口：先改数量，再写流水，二者不可分离。
   * mode 'delta'：在现有库存上增减；mode 'set'：直接设置为目标值（盘点用）。
   */
  function applyStockChange(state, opts) {
    opts = opts || {};
    var matCode = opts.matCode;
    var m = findMaterial(state, matCode);
    if (!m) return { ok: false, error: '物料未建档：' + matCode };

    var current = toQty(m.qty);
    if (current === null) current = 0;
    var amount = toQty(opts.qty);
    if (amount === null) return { ok: false, error: '数量非法：' + opts.qty };

    var target = opts.mode === 'set' ? amount : round6(current + amount);
    if (!opts.allowNegative && target < 0) {
      return { ok: false, error: matCode + ' 库存不足（现 ' + current + '，需 ' + (opts.mode === 'set' ? target : amount) };
    }

    var delta = round6(target - current);
    m.qty = target;
    var txn = recordTransaction(state, {
      type: opts.type, matCode: matCode, delta: delta, balance: target,
      ref: opts.ref, reason: opts.reason, operator: opts.operator, device: opts.device, now: opts.now
    });
    return { ok: true, delta: delta, balance: target, before: current, txn: txn };
  }

  /* ================= 工单执行 ================= */

  /**
   * 解析某物料的本次执行数量：
   *   未提供 / 空串  → 取剩余数量（等价于"这次执行完"）
   *   0             → 跳过该物料（本次不执行）
   *   非法值         → 报错，绝不静默当成 0 或剩余
   */
  function resolveExecQty(raw, remaining) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return { qty: remaining, explicit: false };
    var n = toQty(raw);
    if (n === null) return { qty: null, explicit: true, error: '数量非法：' + raw };
    return { qty: n, explicit: true };
  }

  /**
   * 执行前校验（支持部分执行）。三条关键规则：
   *   1. 先把工单明细按物料汇总，再整体比对库存 —— 修复「同一物料多行合计超库存」的负库存 bug；
   *   2. 本次执行数量不得超过「剩余计划数量」，超出即拒绝，保证剩余数量非负；
   *   3. 数量为 0 表示本次跳过该物料（部分执行的正常用法），不算错误。
   * 未指定 execQtyByCode 时默认执行全部剩余数量（等价于一次性执行完）。
   */
  function validateExecution(state, order, execQtyByCode) {
    var errors = [];
    if (!order) return { ok: false, errors: ['工单不存在'], aggregated: [] };
    if (isOrderExecuted(order)) {
      return { ok: false, errors: ['工单 ' + order.code + ' 状态为「' + statusLabel(order.status) + '」，不可重复执行'], aggregated: [] };
    }
    var prog = orderProgress(order);
    if (!prog.items.length) errors.push('工单无有效明细');

    var aggregated = prog.items.map(function (e) {
      var raw = execQtyByCode ? execQtyByCode[e.matCode] : undefined;
      var resolved = resolveExecQty(raw, e.remaining);
      return {
        matCode: e.matCode, planned: e.planned, executed: e.executed, remaining: e.remaining,
        qty: resolved.qty, error: resolved.error
      };
    });

    var sign = signOf(order.type);
    aggregated.forEach(function (a) {
      if (a.error) { errors.push(a.matCode + ' ' + a.error); return; }
      if (a.qty === null) { errors.push(a.matCode + ' 执行数量非法'); return; }
      if (a.qty < 0) { errors.push(a.matCode + ' 执行数量不能为负数（当前 ' + a.qty + '）'); return; }
      if (a.qty > a.remaining) {
        errors.push(a.matCode + ' 超出剩余计划数量（计划 ' + a.planned + '，已执行 ' + a.executed + '，剩余 ' + a.remaining + '）');
        return;
      }
      if (a.qty === 0) return;                       // 本次跳过，合法
      var m = findMaterial(state, a.matCode);
      if (!m) { errors.push('物料未建档：' + a.matCode); return; }
      if (sign < 0) {
        var stock = toQty(m.qty);
        if (stock === null) stock = 0;
        if (stock < a.qty) errors.push(a.matCode + ' 库存不足（现 ' + stock + '，需 ' + a.qty + '）');
      }
    });

    var todo = aggregated.filter(function (a) { return a.qty > 0; });
    if (!errors.length && !todo.length) errors.push('本次没有需要执行的明细（所有物料数量均为 0）');

    return { ok: errors.length === 0, errors: errors, aggregated: aggregated, sign: sign, progress: prog, merged: mergedCodes(normalizeItems(order.items).items) };
  }

  /**
   * 执行工单（可多次调用以支持部分执行）：
   * 校验 → 逐物料走 applyStockChange → 累计执行数量 → 追加执行批次 → 更新状态。
   * 计划数量（item.qty）始终不变；已执行数量累计在 order.execQty；
   * 每次执行的明细记入 order.execBatches，形成完整执行历史。
   * 状态：全部执行完 → 已执行；只执行了一部分 → 部分执行。
   */
  function executeOrder(state, order, opts) {
    opts = opts || {};
    var v = validateExecution(state, order, opts.execQtyByCode);
    if (!v.ok) return { ok: false, errors: v.errors, applied: [] };

    var typeName = WIP_NAMES[order.type] || order.type;
    var now = opts.now ? new Date(opts.now) : new Date();
    var applied = [];
    for (var i = 0; i < v.aggregated.length; i++) {
      var a = v.aggregated[i];
      if (a.qty <= 0) continue;                       // 本次不执行的物料跳过
      var r = applyStockChange(state, {
        matCode: a.matCode, mode: 'delta', qty: v.sign * a.qty, type: typeName, ref: order.code,
        reason: opts.reason || '', operator: opts.operator, device: opts.device, now: now
      });
      if (!r.ok) return { ok: false, errors: [r.error], applied: applied };
      applied.push({ matCode: a.matCode, qty: a.qty, planned: a.planned, executed: a.executed, remaining: a.remaining, delta: r.delta, balance: r.balance, txn: r.txn });
    }
    if (!applied.length) return { ok: false, errors: ['本次没有需要执行的明细'], applied: [] };

    // 累计已执行数量（按计划明细顺序重建，保持稳定）
    var execMap = executedMap(order);
    applied.forEach(function (a) { execMap[a.matCode] = round6((execMap[a.matCode] || 0) + a.qty); });
    order.execQty = normalizeItems(order.items).items
      .map(function (e) { return { matCode: e.matCode, qty: round6(execMap[e.matCode] || 0) }; })
      .filter(function (e) { return e.qty > 0; });

    var execTime = now.toLocaleString();
    order.execTime = execTime;
    order.execBatches = (order.execBatches || []).concat([{
      at: execTime,
      operator: opts.operator != null ? opts.operator : (state.operator || ''),
      items: applied.map(function (a) { return { matCode: a.matCode, qty: a.qty, delta: a.delta }; })
    }]);

    var prog = orderProgress(order);                  // 基于更新后的 execQty 重算
    order.status = prog.fullyExecuted ? STATUS.DONE : STATUS.PARTIAL;

    return {
      ok: true, errors: [], applied: applied, sign: v.sign, execTime: execTime,
      status: order.status, progress: prog, partial: !prog.fullyExecuted
    };
  }

  /* ================= 物品化工单：扫码校验与执行命令（G1） ================= */

  /**
   * 物品当前位置（与 UniqueItems.currentPosition 同规则：物品 → 容器 → 库位）。
   * 这里是非抛出版本：解析不出来就返回 null 位，由调用方决定怎么报错 ——
   * mes-core 不依赖 unique-items.js，保持纯逻辑可独立加载。
   */
  function itemPosition(state, itemCode) {
    var item = findItem(state, itemCode);
    if (!item) return { item: null, container: null, location: null };
    if ((item.status || 'unknown') !== 'in_stock' || !item.container) {
      return { item: item, container: null, location: null };
    }
    var container = null, location = null;
    ((state && state.containers) || []).forEach(function (r) { if (r && r.code === item.container) container = r; });
    if (container) {
      ((state && state.locations) || []).forEach(function (r) { if (r && r.code === container.loc) location = r; });
    }
    return { item: item, container: container, location: location };
  }

  /**
   * 扫码校验（物品化）：属于本单 / 未扫过 / 物品状态与工单方向匹配。
   * 方向规则：出库 LL/JH 要求物品在库（in_stock）；
   *           入库 BH/TL 要求物品待入或已出（pending | out）。
   * @returns {{ok:boolean, error?:string, code?:string, item?:object}}
   */
  function validateItemScan(state, order, code) {
    if (!order) return { ok: false, error: '工单不存在' };
    if (!isItemizedOrder(order)) return { ok: false, error: '工单 ' + (order.code || '') + ' 不是物品化工单' };
    if (isCancelled(order)) return { ok: false, error: '工单 ' + order.code + ' 已取消，不能扫码执行' };
    if (isFullyExecuted(order)) return { ok: false, error: '工单 ' + order.code + ' 已执行完毕' };
    var c = String(code == null ? '' : code).trim();
    if (!c) return { ok: false, error: '物品码为空' };
    if (itemizedPlannedCodes(order).indexOf(c) < 0) {
      return { ok: false, error: '物品 ' + c + ' 不属于工单 ' + (order.code || '') };
    }
    if (codeSet(order.execItems)[c]) {
      return { ok: false, error: '物品 ' + c + ' 已扫过，不能重复执行' };
    }
    var item = findItem(state, c);
    if (!item) return { ok: false, error: '物品未建档：' + c };
    var st = item.status || 'unknown';
    if (isOutbound(order.type)) {
      if (st !== 'in_stock') {
        return { ok: false, error: '物品 ' + c + ' 当前状态「' + st + '」，' + (WIP_NAMES[order.type] || order.type) + '（出库）要求在库（in_stock）' };
      }
    } else if (st !== 'pending' && st !== 'out') {
      return { ok: false, error: '物品 ' + c + ' 当前状态「' + st + '」，' + (WIP_NAMES[order.type] || order.type) + '（入库）要求待入或已出（pending | out）' };
    }
    return { ok: true, code: c, item: item };
  }

  /**
   * 把「已扫码的一批物品」变成物品操作命令（只生成计划，不改任何状态、不碰库存）。
   *   LL/JH（出库）→ issue：位置**不扫**，按 itemPosition（U.currentPosition 同规则）
   *     从档案取当前位置作为 source；
   *   BH/TL（入库）→ receive：必须给 opts.target = {loc, container}（操作人选择的入库目标）。
   * ops 与 commands 一一对应，是写进 execBatches 的留痕：{opId,itemCode,fromLoc,fromContainer}。
   *   fromLoc/fromContainer 一律记录「冲销时要用到的位置」：
   *   LL/JH 是执行前位置（冲销 receive 回原位）；BH/TL 是 receive 的目标（冲销 issue 由此取出）。
   * @returns {{ok:boolean, errors:string[], commands:Array, ops:Array}}
   */
  function buildItemExecCommands(state, order, codes, opts) {
    opts = opts || {};
    var errors = [], commands = [], ops = [];
    if (!order) return { ok: false, errors: ['工单不存在'], commands: [], ops: [] };
    if (!isItemizedOrder(order)) return { ok: false, errors: ['工单 ' + (order.code || '') + ' 不是物品化工单'], commands: [], ops: [] };
    var outbound = isOutbound(order.type);
    var target = opts.target || null;
    if (!outbound) {
      if (!target || !target.loc || !target.container) {
        return { ok: false, errors: [(WIP_NAMES[order.type] || order.type) + '（入库）必须指定目标库位与容器（opts.target）'], commands: [], ops: [] };
      }
      /* 目标必须真实存在，否则命令发到操作协议那里也会被拒，不如在这里就报清楚 */
      var tloc = null, tctn = null;
      ((state && state.locations) || []).forEach(function (r) { if (r && r.code === target.loc) tloc = r; });
      ((state && state.containers) || []).forEach(function (r) { if (r && r.code === target.container) tctn = r; });
      if (!tloc) errors.push('目标库位未建档：' + target.loc);
      if (!tctn) errors.push('目标容器未建档：' + target.container);
    }
    (codes || []).forEach(function (raw, idx) {
      var v = validateItemScan(state, order, raw);
      if (!v.ok) { errors.push(v.error); return; }
      var c = v.code;
      var opId = typeof opts.opIdFor === 'function' ? opts.opIdFor(c, idx) : (String(order.code || 'ITEM') + '-' + c);
      if (outbound) {
        var pos = itemPosition(state, c);
        if (!pos.container || !pos.location) {
          errors.push('物品 ' + c + ' 标记在库但位置无法解析（容器或库位缺失）');
          return;
        }
        commands.push({ opId: opId, kind: 'issue', itemCode: c, source: { loc: pos.location.code, container: pos.container.code } });
        ops.push({ opId: opId, itemCode: c, fromLoc: pos.location.code, fromContainer: pos.container.code });
      } else {
        var tl = String(target.loc), tc = String(target.container);
        commands.push({ opId: opId, kind: 'receive', itemCode: c, target: { loc: tl, container: tc } });
        ops.push({ opId: opId, itemCode: c, fromLoc: tl, fromContainer: tc });
      }
    });
    return { ok: errors.length === 0, errors: errors, commands: commands, ops: ops };
  }

  /**
   * 物品操作回执落账：只有 phase==='APPLIED' 的码才进 execItems / execBatches / status；
   * REJECTED（或缺回执）原样退回给调用方展示，进度不变。
   * 幂等：opId 已在历史批次里出现过、或码已在 execItems 里的回执直接忽略 ——
   * 超时重试收回的重复回执不能把进度数两遍。
   *
   * 铁律：物品化执行**不碰** applyStockChange / state.transactions / 物料库存数量。
   * 物品的位置变化由物品操作协议负责，库存台账（物料 × 数量）与唯一物品是两套账。
   *
   * @param {Array<{opId:string, itemCode:string, phase:string, fromLoc?:string, fromContainer?:string, error?:string}>} results
   */
  function applyItemExecResult(state, order, results, opts) {
    opts = opts || {};
    if (!order) return { ok: false, error: '工单不存在' };
    if (!isItemizedOrder(order)) return { ok: false, error: '工单 ' + (order.code || '') + ' 不是物品化工单' };
    if (isCancelled(order)) return { ok: false, error: '工单 ' + order.code + ' 已取消' };
    var planned = itemizedPlannedCodes(order);
    var execSet = codeSet(order.execItems);
    var opSeen = Object.create(null);
    ((order.execBatches) || []).forEach(function (b) {
      ((b && b.ops) || []).forEach(function (o) { if (o && o.opId) opSeen[o.opId] = true; });
    });

    var applied = [], rejected = [];
    (results || []).forEach(function (r) {
      if (!r) return;
      var c = String(r.itemCode == null ? '' : r.itemCode).trim();
      var opId = String(r.opId == null ? '' : r.opId);
      if (r.phase !== 'APPLIED') {
        rejected.push({ opId: opId, itemCode: c, error: r.error || ('未应用：' + (r.phase || '无阶段')) });
        return;
      }
      if (!c || planned.indexOf(c) < 0) { rejected.push({ opId: opId, itemCode: c, error: '物品不属于本单' }); return; }
      if (execSet[c]) { rejected.push({ opId: opId, itemCode: c, error: '该码已入账，忽略重复回执' }); return; }
      if (opId && opSeen[opId]) { rejected.push({ opId: opId, itemCode: c, error: '该操作已入账，忽略重复回执' }); return; }
      applied.push({ opId: opId, itemCode: c, fromLoc: r.fromLoc || '', fromContainer: r.fromContainer || '' });
      execSet[c] = true;
      if (opId) opSeen[opId] = true;
    });
    if (!applied.length) return { ok: false, error: '没有可入账的 APPLIED 结果', applied: [], rejected: rejected };

    var now = opts.now ? new Date(opts.now) : new Date();
    var execTime = now.toLocaleString();
    order.execItems = (Array.isArray(order.execItems) ? order.execItems : [])
      .concat(applied.map(function (a) { return a.itemCode; }));
    order.execTime = execTime;
    order.execBatches = (order.execBatches || []).concat([{
      at: execTime,
      operator: opts.operator != null ? opts.operator : ((state && state.operator) || ''),
      itemCodes: applied.map(function (a) { return a.itemCode; }),
      ops: applied.map(function (a) {
        return { opId: a.opId, itemCode: a.itemCode, fromLoc: a.fromLoc, fromContainer: a.fromContainer };
      })
    }]);

    var prog = orderProgress(order);
    order.status = prog.fullyExecuted ? STATUS.DONE : STATUS.PARTIAL;
    return {
      ok: true, applied: applied, rejected: rejected, execTime: execTime,
      status: order.status, progress: prog, partial: !prog.fullyExecuted
    };
  }

  /**
   * 物品化冲销计划：按 execBatches 留痕的 fromLoc/fromContainer 逐件反向。
   *   LL/JH 执行是 issue（出库）→ 冲销 receive 回原位（target = 留痕位置）；
   *   BH/TL 执行是 receive（入库）→ 冲销 issue 从留痕位置取出（source = 留痕位置）。
   * 只生成计划，不改任何状态；回执由调用方按物品操作协议收回后交 applyItemReverseResult。
   */
  function buildItemReverseCommands(state, order, opts) {
    opts = opts || {};
    if (!order) return { ok: false, errors: ['工单不存在'], commands: [] };
    if (!isItemizedOrder(order)) return { ok: false, errors: ['工单 ' + (order.code || '') + ' 不是物品化工单'], commands: [] };
    if (isCancelled(order)) return { ok: false, errors: ['工单 ' + order.code + ' 已取消，无需冲销'], commands: [] };
    var prog = orderProgress(order);
    if (!prog.anyExecuted) return { ok: false, errors: ['工单尚未执行任何物品，无需冲销；可直接「取消」'], commands: [] };

    var outbound = isOutbound(order.type);
    var commands = [], errors = [];
    ((order.execBatches) || []).forEach(function (b) {
      ((b && b.ops) || []).forEach(function (o) {
        if (!o || !o.itemCode) return;
        var loc = o.fromLoc || '', container = o.fromContainer || '';
        if (!loc || !container) {
          errors.push('物品 ' + o.itemCode + ' 缺少执行时的位置留痕，无法生成反向命令');
          return;
        }
        var opId = typeof opts.opIdFor === 'function'
          ? opts.opIdFor(o.itemCode, o.opId)
          : ('REV-' + (o.opId || (String(order.code || 'ITEM') + '-' + o.itemCode)));
        if (outbound) {
          commands.push({ opId: opId, kind: 'receive', itemCode: o.itemCode, target: { loc: loc, container: container }, reverseOf: o.opId || '' });
        } else {
          commands.push({ opId: opId, kind: 'issue', itemCode: o.itemCode, source: { loc: loc, container: container }, reverseOf: o.opId || '' });
        }
      });
    });
    return { ok: errors.length === 0, errors: errors, commands: commands };
  }

  /**
   * 冲销回执落账：全部反向命令都 APPLIED 才关单（已取消 + reverseInfo 留痕）。
   * G1 不支持部分冲销 —— 与旧形态 reverseOrder「全量反向后关单」同一语义；
   * 有未完成的反向操作时原样报出 pending，工单保持原状态。
   * 同样**不碰**库存与流水：反向的位置变化已由物品操作协议落地。
   *
   * @param {Array<{opId:string, phase:string, error?:string}>} results 按执行回执的 opId 对应
   */
  function applyItemReverseResult(state, order, results, opts) {
    opts = opts || {};
    if (!order) return { ok: false, error: '工单不存在' };
    if (!isItemizedOrder(order)) return { ok: false, error: '工单 ' + (order.code || '') + ' 不是物品化工单' };
    if (isCancelled(order)) return { ok: false, error: '工单 ' + order.code + ' 已取消，无需冲销' };
    var prog = orderProgress(order);
    if (!prog.anyExecuted) return { ok: false, error: '工单尚未执行任何物品，无需冲销；可直接「取消」' };

    var byOp = Object.create(null);
    (results || []).forEach(function (r) {
      if (!r) return;
      if (r.opId != null) byOp[String(r.opId)] = r;
      /* 冲销命令的 opId 是「REV-原opId」，回执按新 opId 回来；
         reverseOf 把它对回执行时的原始 opId，两种键都索引上 */
      if (r.reverseOf != null && r.reverseOf !== '') byOp[String(r.reverseOf)] = r;
    });
    var done = [], pending = [];
    ((order.execBatches) || []).forEach(function (b) {
      ((b && b.ops) || []).forEach(function (o) {
        if (!o || !o.itemCode) return;
        var r = byOp[String(o.opId || '')] || byOp['REV-' + String(o.opId || '')];
        if (r && r.phase === 'APPLIED') done.push(o.itemCode);
        else pending.push({ opId: o.opId || '', itemCode: o.itemCode, error: r ? (r.error || ('未应用：' + (r.phase || '无阶段'))) : '缺少回执' });
      });
    });
    if (pending.length) {
      return { ok: false, error: '尚有 ' + pending.length + ' 件物品未完成反向操作，不能关单', pending: pending, applied: done };
    }

    var now = opts.now ? new Date(opts.now) : new Date();
    var at = now.toLocaleString();
    order.reverseInfo = {
      at: at,
      operator: opts.operator != null ? opts.operator : ((state && state.operator) || ''),
      reason: opts.reason || ('冲销 ' + order.code),
      itemCodes: done.slice()
    };
    order.reversedAt = at;
    order.status = STATUS.CANCELLED;
    return { ok: true, order: order, applied: done, reverseInfo: order.reverseInfo };
  }

  /* ================= 工单取消与冲销 ================= */

  /**
   * 取消工单：仅允许「未执行任何数量」的工单（待执行）。
   * 已执行过（含部分执行）的工单必须先「冲销」，避免库存与状态脱节。
   * 物品化工单同样适用：execItems 为空（一件未扫）即可直接取消。
   */
  function cancelOrder(state, order, opts) {
    opts = opts || {};
    if (!order) return { ok: false, error: '工单不存在' };
    if (isCancelled(order)) return { ok: false, error: '工单 ' + order.code + ' 已是「已取消」状态' };
    var prog = orderProgress(order);
    if (prog.anyExecuted) {
      return { ok: false, error: '工单已执行 ' + prog.executedTotal + ' 件，不能直接取消；请使用「冲销」把库存还回后再关闭' };
    }
    var now = opts.now ? new Date(opts.now) : new Date();
    order.status = STATUS.CANCELLED;
    order.cancelInfo = {
      at: now.toLocaleString(),
      operator: opts.operator != null ? opts.operator : (state.operator || ''),
      reason: opts.reason || ''
    };
    return { ok: true, order: order, cancelInfo: order.cancelInfo };
  }

  /**
   * 冲销工单：把已执行的数量按原方向反向写回库存，并关闭工单。
   * 保留 execQty / execBatches 作为执行历史，另记 reverseInfo 作为冲销凭证。
   * 冲销同样走 applyStockChange，因此库存与流水始终成对出现，回放校验不会断链。
   */
  function reverseOrder(state, order, opts) {
    opts = opts || {};
    if (!order) return { ok: false, error: '工单不存在' };
    if (isCancelled(order)) return { ok: false, error: '工单 ' + order.code + ' 已取消，无需冲销' };
    var prog = orderProgress(order);
    if (!prog.anyExecuted) return { ok: false, error: '工单尚未执行任何数量，无需冲销；可直接「取消」' };

    var sign = signOf(order.type);
    var now = opts.now ? new Date(opts.now) : new Date();
    var reason = opts.reason || ('冲销 ' + order.code);
    var applied = [];
    for (var i = 0; i < prog.items.length; i++) {
      var it = prog.items[i];
      if (it.executed <= 0) continue;
      // 反向：出库(LL/JH)执行时 -qty，冲销为 +qty；入库(BH/TL)执行时 +qty，冲销为 -qty
      var r = applyStockChange(state, {
        matCode: it.matCode, mode: 'delta', qty: round6(-sign * it.executed), type: '冲销', ref: order.code,
        reason: reason, operator: opts.operator, device: opts.device, now: now
      });
      if (!r.ok) return { ok: false, error: r.error, applied: applied };
      applied.push({ matCode: it.matCode, qty: it.executed, delta: r.delta, balance: r.balance, txn: r.txn });
    }

    var at = now.toLocaleString();
    order.reverseInfo = {
      at: at,
      operator: opts.operator != null ? opts.operator : (state.operator || ''),
      reason: reason,
      items: applied.map(function (a) { return { matCode: a.matCode, qty: a.qty, delta: a.delta }; })
    };
    order.reversedAt = at;
    order.status = STATUS.CANCELLED;
    return { ok: true, order: order, applied: applied, reverseInfo: order.reverseInfo };
  }

  /**
   * 修改工单计划（明细 / 数量 / 日期）。
   *
   * **只允许「未执行任何数量」的工单改计划**。原因不是保守，而是正确性：
   *   · 冲销的依据是 `it.executed`（见 reverseOrder），而「已执行」是相对计划算出来的；
   *     事后改计划会让「计划 / 已执行 / 剩余」三者对不上，流水金额也无法解释；
   *   · 部分执行的工单若把计划改到低于已执行数量，进度条会出现 >100% 或负数剩余。
   * 所以已执行（含部分）的工单必须先「冲销」，再改计划。
   *
   * 工单号（业务键）**不允许改** —— 它是流水 ref、二维码机读串、飞书主键，
   * 改了会让已有流水指向一个不存在的单号（幽灵引用）。
   *
   * 变更写进 order.planEdits 留痕，并由 orderHistory 呈现，保证「谁在什么时候把计划从什么改成了什么」可追。
   */
  function updateOrderPlan(state, order, patch, opts) {
    opts = opts || {};
    patch = patch || {};
    if (!order) return { ok: false, error: '工单不存在' };
    if (isCancelled(order)) return { ok: false, error: '工单 ' + order.code + ' 已取消，不能再改计划' };
    var prog = orderProgress(order);
    if (prog.anyExecuted) {
      return { ok: false, error: '工单已执行 ' + prog.executedTotal + ' 件，计划数量是冲销与对账的依据，不能再改；如确需调整请先「冲销」' };
    }

    var errors = [];
    var nextItems, nextMerged = [];
    if (patch.items !== undefined) {
      var norm = normalizeItems(patch.items);
      if (!norm.items.length) errors.push('请至少保留一行有效明细（物料码 + 正数数量）');
      var missing = [];
      norm.items.forEach(function (e) { if (!findMaterial(state, e.matCode)) missing.push(e.matCode); });
      if (missing.length) errors.push('物料未建档：' + missing.join('、'));
      if (errors.length) {
        return { ok: false, errors: errors, dropped: norm.dropped, merged: mergedCodes(norm.items) };
      }
      nextItems = norm.items.map(function (e) { return { matCode: e.matCode, qty: e.qty }; });
      /* mergedCodes 需要 normalizeItems 产出的 lines 字段，所以必须在这里算 ——
         上面的 map 把 lines 丢掉了，事后再算永远是空数组。 */
      nextMerged = mergedCodes(norm.items);
    }
    var nextDate = (patch.date !== undefined) ? String(patch.date == null ? '' : patch.date) : undefined;
    if (nextItems === undefined && nextDate === undefined) {
      return { ok: false, error: '没有要修改的内容' };
    }

    var before = normalizeItems(order.items).items.map(function (e) { return { matCode: e.matCode, qty: e.qty }; });
    var changes = [];
    if (nextItems !== undefined) {
      /* 逐项列出「改了什么」：只报「项数变化」不够，用户要看到具体是哪一行、从多少到多少 */
      var beforeMap = Object.create(null);
      before.forEach(function (e) { beforeMap[e.matCode] = e.qty; });
      var afterMap = Object.create(null);
      nextItems.forEach(function (e) { afterMap[e.matCode] = e.qty; });
      before.forEach(function (e) {
        if (afterMap[e.matCode] === undefined) changes.push('移除 ' + e.matCode + '（原计划 ' + e.qty + '）');
        else if (afterMap[e.matCode] !== e.qty) changes.push(e.matCode + ' 数量 ' + e.qty + ' → ' + afterMap[e.matCode]);
      });
      nextItems.forEach(function (e) {
        if (beforeMap[e.matCode] === undefined) changes.push('新增 ' + e.matCode + '（计划 ' + e.qty + '）');
      });
      if (!changes.length) changes.push('明细内容未变（仅重新提交）');
    }
    if (nextDate !== undefined && nextDate !== (order.date || '')) {
      changes.push('日期 ' + (order.date || '空') + ' → ' + (nextDate || '空'));
    }

    if (nextItems !== undefined) order.items = nextItems;
    if (nextDate !== undefined) order.date = nextDate;

    var now = opts.now ? new Date(opts.now) : new Date();
    var rec = {
      at: now.toLocaleString(),
      operator: opts.operator != null ? opts.operator : (state && state.operator) || '',
      reason: opts.reason || '',
      changes: changes,
      before: before,
      after: normalizeItems(order.items).items.map(function (e) { return { matCode: e.matCode, qty: e.qty }; })
    };
    order.planEdits = (order.planEdits || []).concat([rec]);
    return { ok: true, order: order, changes: changes, planEdit: rec, merged: nextMerged };
  }

  /** 工单关联的库存流水（时间正序） */
  function orderTransactions(state, code) {
    return orderedTransactions(state).filter(function (t) { return t.ref === code; });
  }

  /** 工单完整历史追溯：创建 → 各次执行批次 → 取消/冲销 */
  function orderHistory(order) {
    if (!order) return [];
    var plannedDesc = isItemizedOrder(order)
      ? itemizedPlannedCodes(order).length + ' 件物品'
      : normalizeItems(order.items).items.length + ' 项';
    var hist = [{ kind: 'create', at: order.date || '', operator: '', text: '创建工单（' + (WIP_NAMES[order.type] || order.type) + '），计划 ' + plannedDesc }];
    ((order.execBatches) || []).forEach(function (b, i) {
      var text = Array.isArray(b.itemCodes)
        ? '第 ' + (i + 1) + ' 次执行：扫码 ' + b.itemCodes.length + ' 件（' + b.itemCodes.join('，') + '）'
        : '第 ' + (i + 1) + ' 次执行：' + (b.items || []).map(function (x) { return x.matCode + ' ' + (x.delta > 0 ? '+' : '') + x.delta; }).join('，');
      hist.push({
        kind: 'execute', at: b.at || '', operator: b.operator || '', batch: i + 1,
        items: b.items || [],
        itemCodes: b.itemCodes,
        text: text
      });
    });
    /* 计划修改也要进历史：只改 items 不记录的话，事后没人能说清
       「这条工单当初计划的是 5 件还是 3 件」，对账时无法解释差异。 */
    ((order.planEdits) || []).forEach(function (e) {
      hist.push({
        kind: 'plan-edit', at: e.at || '', operator: e.operator || '',
        text: '修改计划：' + ((e.changes || []).join('；') || '（无变化）') + (e.reason ? '（' + e.reason + '）' : '')
      });
    });
    if (order.cancelInfo) hist.push({ kind: 'cancel', at: order.cancelInfo.at || '', operator: order.cancelInfo.operator || '', text: '取消工单' + (order.cancelInfo.reason ? '（' + order.cancelInfo.reason + '）' : '') });
    if (order.reverseInfo) hist.push({ kind: 'reverse', at: order.reverseInfo.at || '', operator: order.reverseInfo.operator || '', text: '冲销工单' + (order.reverseInfo.reason ? '（' + order.reverseInfo.reason + '）' : '') });
    return hist;
  }

  /* ================= 盘点 ================= */

  /** 实盘数量严格校验：空 / 非数字 / 负数一律拒绝，绝不静默转 0 */
  function parseStocktakeInput(raw) {
    if (raw === null || raw === undefined) return { ok: false, error: '实盘数量不能为空' };
    var s = String(raw).trim();
    if (s === '') return { ok: false, error: '实盘数量不能为空' };
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s)) return { ok: false, error: '实盘数量必须是数字：' + s };
    var n = Number(s);
    if (!Number.isFinite(n)) return { ok: false, error: '实盘数量非法：' + s };
    if (n < 0) return { ok: false, error: '实盘数量不能为负数：' + s };
    return { ok: true, value: n };
  }

  /**
   * 提交盘点：实盘数量 → 库存 → 差异流水（走统一写入口）。
   * @returns {{ok:boolean, error?:string, delta?:number, before?:number, balance?:number, txn?:object}}
   */
  function applyStocktake(state, matCode, rawQty, opts) {
    opts = opts || {};
    var parsed = parseStocktakeInput(rawQty);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    var m = findMaterial(state, matCode);
    if (!m) return { ok: false, error: '物料未建档：' + matCode };

    var before = toQty(m.qty);
    if (before === null) before = 0;
    var delta = round6(parsed.value - before);
    var r = applyStockChange(state, {
      matCode: matCode, mode: 'set', qty: parsed.value, type: '盘点',
      reason: delta === 0 ? '账实相符' : '盘点差异',
      operator: opts.operator, device: opts.device, now: opts.now
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, delta: delta, before: before, balance: parsed.value, txn: r.txn };
  }

  /* ================= 手工调整 ================= */

  function applyManualAdjust(state, matCode, rawQty, opts) {
    opts = opts || {};
    var parsed = parseStocktakeInput(rawQty);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    var r = applyStockChange(state, {
      matCode: matCode, mode: 'set', qty: parsed.value, type: '手工调整',
      reason: opts.reason || '（未填）', operator: opts.operator, device: opts.device, now: opts.now
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, delta: r.delta, before: r.before, balance: r.balance, txn: r.txn };
  }

  /* ================= 增量合并（Phase 2） ================= */

  /**
   * 增量合并：把「只包含变化行」的远端数据应用到本地。
   *
   * 与 mergeRemote 的关键区别：**这里绝不做删除判定**。
   * 增量数据天然不知道整张表的键集合，拿它当全量去比会得出
   * 「本地多出来的全部被删了」—— 一次增量就能清空整张表。
   * 删除只能由 censusTable（完整键集合对账）判定，且要过三重闸门。
   *
   * 字段合并语义与 mergeRemote 保持一致（飞书空值不覆盖本地非空值；
   * protect 名单里的字段以本地为准）。
   *
   * @returns {{created,updated,unchanged,keptLocal,protected,changes,syncedKeys,byTable}}
   */
  function applyRemoteChanges(state, partial, opts) {
    opts = opts || {};
    var synced = opts.syncedKeys || {};
    var protect = opts.protect || {};
    var stat = { created: 0, updated: 0, unchanged: 0, keptLocal: 0, protected: 0, changes: [], byTable: {} };
    var nextSynced = {};
    MERGE_TABLES.forEach(function (tbl) {
      if (Array.isArray(synced[tbl.key])) nextSynced[tbl.key] = synced[tbl.key].slice();
    });

    MERGE_TABLES.forEach(function (tbl) {
      var remoteArr = partial[tbl.key];
      if (!Array.isArray(remoteArr)) return;                 // 这张表本次没变 → 完全不碰

      var protTbl = protect[tbl.key] || {};
      if (!Array.isArray(state[tbl.key])) state[tbl.key] = [];
      var localArr = state[tbl.key];
      var byKey = Object.create(null);
      localArr.forEach(function (r) {
        var v = r ? r[tbl.id] : null;
        if (v !== undefined && v !== null && v !== '') byKey[String(v)] = r;
      });
      var seen = Object.create(null);
      (nextSynced[tbl.key] || []).forEach(function (k) { seen[String(k)] = true; });

      var t = { created: 0, updated: 0, unchanged: 0, keptLocal: 0, protected: 0 };
      remoteArr.forEach(function (r) {
        if (!r) return;
        var v = r[tbl.id];
        if (v === undefined || v === null || v === '') return;
        var k = String(v);
        seen[k] = true;
        var local = byKey[k];
        if (!local) {
          // 深拷贝：增量记录来自网络响应，直接塞进 state 会与响应对象共享引用
          var copy = JSON.parse(JSON.stringify(r));
          localArr.push(copy); byKey[k] = copy; t.created++;
          stat.changes.push({ table: tbl.key, id: k, kind: 'create' });
          return;
        }
        var guarded = Object.create(null);
        (protTbl[k] || []).forEach(function (f) { guarded[f] = true; });
        var changed = [], kept = 0, held = 0;
        Object.keys(r).forEach(function (f) {
          var rv = r[f], lv = local[f];
          if (guarded[f]) { held++; return; }
          if (isBlank(rv) && !isBlank(lv)) { kept++; return; }
          if (rv === lv) return;
          if (typeof rv === 'number' && typeof lv === 'number' && Math.abs(rv - lv) < EPS) return;
          local[f] = rv; changed.push(f);
        });
        if (changed.length) { t.updated++; stat.changes.push({ table: tbl.key, id: k, kind: 'update', fields: changed }); }
        else t.unchanged++;
        if (kept) t.keptLocal++;
        if (held) t.protected++;
      });

      stat.created += t.created; stat.updated += t.updated; stat.unchanged += t.unchanged;
      stat.keptLocal += t.keptLocal; stat.protected += t.protected;
      stat.byTable[tbl.key] = t;
      nextSynced[tbl.key] = Object.keys(seen);
    });

    // 流水仍然保持「新的在前」，否则界面顺序会乱
    if (Array.isArray(state.transactions)) {
      var withSeq = state.transactions.filter(function (x) { return x && x.seq != null; });
      var noSeq = state.transactions.filter(function (x) { return !x || x.seq == null; });
      withSeq.sort(function (a, b) { return (b.seq || 0) - (a.seq || 0); });
      state.transactions = withSeq.concat(noSeq);
      var mx = state.txnSeq || 0;
      state.transactions.forEach(function (x) { if ((x.seq || 0) > mx) mx = x.seq || 0; });
      state.txnSeq = mx;
    }

    stat.syncedKeys = nextSynced;
    return stat;
  }

  /* ================= 回放校验 ================= */

  /** 全量流水按时间正序（旧数据无 seq 视为在 seq 之前） */
  /**
   * 按 seq 升序排列流水（无 seq 的旧数据排在最后，保持原相对顺序）。
   *
   * @param {object} state
   * @param {boolean} [assumeOrdered] 提示「state.transactions 大概已经是 seq 降序」
   *   （全站约定：recordTransaction 用 unshift、mergeRemote/applyMerge 的流水后处理
   *   都会重新降序排）。为真时**先花 O(n) 次纯数字比较确认**，确认通过才跳过排序。
   *
   *   ⚠️ 这里必须校验，不能信任调用方 —— 第一版就是不校验直接反向遍历，
   *   结果传进来一个升序数组时，链式校验的「起算点」变成了最后一条，
   *   于是把一个**完全健康**的账本报成 2497 条不一致。这个模块的全部意义就是
   *   判断账本对不对，一个能因为参数顺序就把结论反转的"优化"是不能接受的。
   *   校验用简单数值比较（发现逆序立刻退出、不分配、不调比较器），
   *   比 sort 便宜得多，所以仍然有净收益。
   */
  /**
   * 账本修数方案（B4）—— 纯函数，只算不改。
   *
   * 为什么需要它：qty 与账本不一致时，**没有任何正规接口能改 qty**。
   * P4 关掉了 upsert 的绝对 qty（这是对的），于是 qty 只能由服务端按
   * 「期初 + Σ变动」收敛重写；而「补一条流水」根本改不了这个差 ——
   * qty 和 Σ变动 同时加同一个数，差不变。所以唯一正确的修法是两步：
   *   ① 把账本里错了的「余量」列改对（让链式校验自洽）
   *   ② 对每个仍不符的物料触发一次库存写入 → 服务端会用账本口径重写 qty
   *      （注意：服务端的收敛是拿「期初 + Σ变动」算的，不是拿当前 qty 加 delta，
   *        所以**任何**一次写入都会把不变量恢复，连 delta 0 都行）
   *
   * @returns {{ clean:boolean, txnFixes:Array, qtyFixes:Array, materials:number }}
   *   txnFixes: [{ seq, matCode, from, to }] 余量列需要改的行
   *   qtyFixes: [{ code, from, to, delta }]  库存数量与账本不符、需要触发收敛的物料
   */
  function ledgerRepairPlan(state) {
    var txns = ((state && state.transactions) || []).slice().sort(function (a, b) {
      return (Number(a.seq) || 0) - (Number(b.seq) || 0);
    });
    var byMat = Object.create(null);
    txns.forEach(function (t) {
      if (!t || t.matCode == null) return;
      (byMat[t.matCode] = byMat[t.matCode] || []).push(t);
    });

    var txnFixes = [];
    var expected = Object.create(null);   // matCode → 账本口径的结存
    Object.keys(byMat).forEach(function (mat) {
      var list = byMat[mat];
      // 期初只由**最早那条**决定（余量 − 变动）——与 replayAudit 同一口径
      var first = list[0];
      if (!first || first.balance == null || first.delta == null) return;
      var run = first.balance - first.delta;
      list.forEach(function (t) {
        run += (Number(t.delta) || 0);
        if (t.balance == null || Math.abs(t.balance - run) > 1e-9) {
          txnFixes.push({ seq: t.seq, matCode: mat, from: t.balance, to: run });
        }
      });
      expected[mat] = run;
    });

    var qtyFixes = [];
    ((state && state.materials) || []).forEach(function (m) {
      if (!m || m.code == null) return;
      if (!(m.code in expected)) return;             // 该物料没有任何流水 → 无可比口径
      var want = expected[m.code];
      if (Math.abs((Number(m.qty) || 0) - want) > 1e-9) {
        qtyFixes.push({ code: m.code, from: m.qty, to: want, delta: round6(want - (Number(m.qty) || 0)) });
      }
    });

    return {
      clean: txnFixes.length === 0 && qtyFixes.length === 0,
      txnFixes: txnFixes, qtyFixes: qtyFixes,
      materials: Object.keys(byMat).length
    };
  }

  /** 严格 seq 降序？（纯数值比较，发现逆序立刻返回 false；任何一条没有 seq 就返回 false） */
  function isDescendingBySeq(all) {
    var last = Infinity;
    for (var i = 0; i < all.length; i++) {
      var t = all[i];
      if (!t) continue;
      var s = t.seq;
      if (s === null || s === undefined) return false;   // 有 legacy 行 → 交给慢路径
      if (typeof s !== 'number' || !isFinite(s)) return false;
      if (s > last) return false;
      last = s;
    }
    return true;
  }

  function orderedTransactions(state, assumeOrdered) {
    var all = ((state && state.transactions) || []).slice();
    if (assumeOrdered && isDescendingBySeq(all)) {
      var seqd0 = new Array(all.length);
      // 已确认严格降序且无 legacy → 反向遍历即得升序
      for (var i = all.length - 1, k = 0; i >= 0; i--) seqd0[k++] = all[i];
      return seqd0;
    }
    var legacy = all.filter(function (t) { return t.seq === null || t.seq === undefined; }).reverse();
    var seqd = all.filter(function (t) { return t.seq !== null && t.seq !== undefined; })
      .sort(function (a, b) { return (a.seq - b.seq) || String(a.device).localeCompare(String(b.device)); });
    return legacy.concat(seqd);
  }

  /**
   * 回放校验：从首条余量反推期初，逐条重算链式余量并与记录比对。
   * @returns {{ok:boolean, materials:number, transactions:number, compared:number, mismatches:Array}}
   */
  function replayAudit(state, opts) {
    opts = opts || {};
    var ord = orderedTransactions(state, !!opts.assumeOrdered);
    /* 覆盖度优先于余额：余额链能从首条 balance-delta 反推“期初”，
       所以前缀被截断时会把错期初当真，最终反而显示一致。连续 seq 才能说明
       当前校验覆盖了完整账本；中间洞必须明确报「数据不完整」，不能伪装 mismatch。 */
    var seqs = ord.map(function (t) { return Number(t && t.seq); }).filter(function (n) { return Number.isFinite(n) && n > 0; }).sort(function (a, b) { return a - b; });
    var unique = [];
    seqs.forEach(function (n) { if (!unique.length || unique[unique.length - 1] !== n) unique.push(n); });
    var gaps = [], duplicates = [];
    for (var si = 0; si < seqs.length; si++) if (si && seqs[si] === seqs[si - 1] && duplicates.indexOf(seqs[si]) < 0) duplicates.push(seqs[si]);
    for (var gi = 1; gi < unique.length; gi++) if (unique[gi] > unique[gi - 1] + 1) gaps.push({ from: unique[gi - 1] + 1, to: unique[gi] - 1 });
    var minSeq = unique.length ? unique[0] : null;
    var maxSeq = unique.length ? unique[unique.length - 1] : null;
    var expectedMax = opts.expectedMaxSeq == null ? null : Number(opts.expectedMaxSeq);
    if (expectedMax != null && maxSeq != null && expectedMax > maxSeq) gaps.push({ from: maxSeq + 1, to: expectedMax, tail: true });
    var hasLegacy = ord.some(function (t) { return !t || t.seq == null; });
    var coverage = {
      minSeq: minSeq, maxSeq: maxSeq, gaps: gaps, duplicates: duplicates,
      complete: !!unique.length && minSeq === 1 && gaps.length === 0 && duplicates.length === 0 && !hasLegacy,
      status: 'unknown'
    };
    if (gaps.length || duplicates.length) coverage.status = 'incomplete';
    else if (coverage.complete) coverage.status = 'complete';
    else coverage.status = 'partial';
    /* ---------- checkpoint 消费 ----------
       账本只增不改，所以「前缀已经核验通过」的那一段不必每次重算 ——
       lib/replay-checkpoint.js 每 1000 条存一份每物料余额快照，这里从它起算。
       三条安全前提（缺一不可，否则退回全量重放）：
         · 只接受 version 1 且 coverage.complete 的快照；
         · 全局覆盖必须完整（有缺口/重复时从任何地方起算都没有意义）；
         · 快照的前缀指纹（条数 + 变动之和）必须与当下一致 —— 否则前缀被人改过，
           从它起算会把被改坏的那一段整体跳过去，校验反而报「一切正常」。
       注意：coverage 的缺口/重复扫描仍然覆盖**全部**流水（那部分本来就便宜，
       而它正是判断「能不能用快照」的依据，不能省）。 */
    var cp = opts.fromCheckpoint;
    var useCp = null;
    if (cp && cp.version === 1 && cp.balances && cp.coverage && cp.coverage.complete
        && coverage.complete && Number.isFinite(Number(cp.seq)) && Number(cp.seq) <= maxSeq) {
      var prefix = ord.filter(function (t) { return Number(t.seq) <= Number(cp.seq); });
      var ok = true;
      if (cp.prefixCount != null && prefix.length !== cp.prefixCount) ok = false;
      if (ok && cp.deltaSum != null) {
        var s0 = 0;
        for (var q = 0; q < prefix.length; q++) s0 += Number(prefix[q].delta || 0);
        if (Math.abs(round6(s0) - cp.deltaSum) > EPS) ok = false;
      }
      if (ok) useCp = cp;
    }
    if (useCp) ord = ord.filter(function (t) { return Number(t.seq) > Number(useCp.seq); });

    var byMat = Object.create(null);
    ord.forEach(function (t) { (byMat[t.matCode] = byMat[t.matCode] || []).push(t); });

    var mismatches = [];
    var compared = 0;
    Object.keys(byMat).forEach(function (code) {
      /* 有快照时，该物料的起始余额直接取快照值（它就是截止 cp.seq 的结存）；
         快照里没有这个物料（说明它的流水都在快照之后）→ 退回「首条的 余量−变动」，
         也就是它自己的期初。两种来源语义相同，都是"这条流水之前的余额"。 */
      var run = (useCp && useCp.balances && useCp.balances[code] != null) ? Number(useCp.balances[code]) : null;
      byMat[code].forEach(function (t) {
        if (typeof t.balance !== 'number') return;
        if (run === null) run = t.balance - t.delta;
        run += t.delta;
        compared++;
        if (Math.abs(t.balance - run) > EPS) {
          mismatches.push({
            seq: t.seq === null || t.seq === undefined ? '旧' : t.seq,
            matCode: code, type: t.type, expected: round6(run), actual: t.balance, time: t.time
          });
        }
      });
    });

    var status = coverage.status === 'incomplete' ? 'incomplete'
      : (mismatches.length ? 'mismatch' : (coverage.complete ? 'complete-valid' : 'partial-valid-within-range'));
    return {
      // 有中间缺口时绝不能给 ok=true；否则会把“数据不完整”伪装成“账目正确”。
      ok: coverage.status !== 'incomplete' && mismatches.length === 0,
      status: status,
      materials: Object.keys(byMat).length,
      transactions: ord.length,
      compared: compared,
      mismatches: mismatches,
      coverage: coverage,
      fromCheckpoint: useCp ? Number(useCp.seq) : null,   // 从哪条之后开始算（null=全量）
      // 跳过的条数 = 快照覆盖的前缀条数（不是「总数 − 剩余数」，那样在快照覆盖到末尾时会算成 0）
      skipped: useCp ? (Number(useCp.prefixCount) || 0) : 0
    };
  }

  /* ================= 扫码历史（结构化，供 30S 定位回查） ================= */

  /**
   * 追加一条扫码记录。只增不改，与库存流水同构（seq + ts）。
   * @returns {object} 写入的扫码记录
   */
  function recordScan(state, entry) {
    entry = entry || {};
    if (!state) throw new Error('recordScan: 缺少 state');
    if (!Array.isArray(state.scanHistory)) state.scanHistory = [];
    state.scanSeq = (state.scanSeq || 0) + 1;
    var now = entry.now ? new Date(entry.now) : new Date();
    var rec = {
      seq: state.scanSeq,
      ts: now.toISOString(),
      time: now.toLocaleString(),
      operator: entry.operator != null ? entry.operator : (state.operator || ''),
      raw: entry.raw || '',
      prefix: entry.prefix || '',
      code: entry.code || '',
      kind: entry.kind || 'unknown',
      hit: !!entry.hit,
      name: entry.name || '',
      loc: entry.loc || '',
      container: entry.container || '',
      zone: entry.zone || ''
    };
    state.scanHistory.unshift(rec);
    if (state.scanHistory.length > 2000) state.scanHistory.length = 2000;   // 防无限增长
    return rec;
  }

  /** 某编码的扫码记录（新的在前） */
  function scanHistoryFor(state, code, limit) {
    var list = ((state && state.scanHistory) || []).filter(function (s) { return s && s.code === code; });
    return limit ? list.slice(0, limit) : list;
  }

  /** 某物料最近一条流水（按时间正序取最后一条） */
  function lastTransactionFor(state, code) {
    var list = orderedTransactions(state).filter(function (t) { return t.matCode === code; });
    return list.length ? list[list.length - 1] : null;
  }

  /** 某物料最近一张相关工单（优先按执行时间，其次按日期） */
  function lastOrderFor(state, code) {
    var list = ((state && state.workorders) || []).filter(function (w) {
      return (w.items || []).some(function (it) { return it && it.matCode === code; });
    });
    if (!list.length) return null;
    return list.slice().sort(function (a, b) {
      var ka = String(a.execTime || a.date || '');
      var kb = String(b.execTime || b.date || '');
      if (ka === kb) return 0;
      return ka < kb ? -1 : 1;
    })[list.length - 1];
  }

  /** 相对时间描述（可注入 now 便于测试） */
  function timeAgo(ts, now) {
    if (!ts) return '';
    var t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return '';
    var ref = now ? new Date(now).getTime() : Date.now();
    var d = Math.floor((ref - t) / 1000);
    if (d < 0) d = 0;
    if (d < 60) return d + ' 秒前';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }

  /** 某编码最近一条**带位置**的扫码记录（未命中的扫码不带位置，不能覆盖早先的线索） */
  function lastScanWithLocation(state, code) {
    var list = scanHistoryFor(state, code);
    for (var i = 0; i < list.length; i++) {
      if (list[i].loc || list[i].container || list[i].zone) return list[i];
    }
    return null;
  }

  /* ================= 库位解析（精确到架-层-位） ================= */

  /**
   * 解析库位编码。台账「类型」列优先（权威），缺失时按编码规则推导。
   * 现场在用四种编码：
   *   B-01-03-04 / C-01-01-01  货架区：区-架-层-位
   *   W01-G02                  工位区：工位-格
   *   K401-A03                 开放区块：区-通道-块位
   *   M-01                     模块区
   * 注意：W01-G02 与 K401-A03 都是「字母+数字 - 字母+数字」，单看编码有歧义，
   * 因此优先用台账 kind；无 kind 时按 W##-G## 判工位、其余判开放区块。
   * @returns {{level:string, text:string, parts:object}}
   */
  function parseLocationCode(code, kindHint) {
    var c = String(code || '').trim();
    if (!c) return { level: 'unknown', text: '', parts: {} };
    var k = kindHint || '';
    var m;

    // 台账类型优先
    if (k === '货架' || k === '模块区' || k === '工位' || k === '空地') {
      var byKind = parseByShape(c);
      if (k === '货架' && byKind.level === 'shelf') return byKind;
      if (k === '工位' && byKind.level === 'workstation') return byKind;
      if (k === '空地' && byKind.level === 'block') return byKind;
      if (k === '模块区') return { level: 'zone', text: '模块区 ' + c, parts: { zone: c } };
    }
    return parseByShape(c);
  }

  /** 纯按编码形状解析（含工位/区块的消歧规则） */
  function parseByShape(c) {
    var m;
    // 货架区：区-架-层-位
    if ((m = c.match(/^([A-Za-z]+)-(\d+)-(\d+)-(\d+)$/))) {
      return {
        level: 'shelf',
        text: m[1].toUpperCase() + '区 ' + Number(m[2]) + '号货架 第' + Number(m[3]) + '层 第' + Number(m[4]) + '位',
        parts: { area: m[1].toUpperCase(), shelf: +m[2], layer: +m[3], pos: +m[4] }
      };
    }
    // 工位收纳格：W01-G02（工位字母 W + 格字母 G，形状明确，优先于开放区块）
    if (/^W\d+-G\d+$/i.test(c)) {
      m = c.match(/^[A-Za-z](\d+)-[A-Za-z](\d+)$/);
      return { level: 'workstation', text: Number(m[1]) + '号工位 第' + Number(m[2]) + '格', parts: { station: +m[1], cell: +m[2] } };
    }
    // 开放区块：K401-A03
    if ((m = c.match(/^([A-Za-z]\d+)-([A-Za-z])(\d+)$/))) {
      return {
        level: 'block',
        text: m[1].toUpperCase() + ' 开放区 ' + m[2].toUpperCase() + '通道 第' + Number(m[3]) + '块位',
        parts: { area: m[1].toUpperCase(), channel: m[2].toUpperCase(), block: +m[3] }
      };
    }
    // 其余「字母+数字-字母+数字」按工位兜底
    if ((m = c.match(/^[A-Za-z](\d+)-[A-Za-z](\d+)$/))) {
      return { level: 'workstation', text: Number(m[1]) + '号工位 第' + Number(m[2]) + '格', parts: { station: +m[1], cell: +m[2] } };
    }
    // 模块区：M-01
    if (/^M-\d+$/i.test(c)) return { level: 'zone', text: '模块区 ' + c.toUpperCase(), parts: { zone: c.toUpperCase() } };
    // 容器码：XK-001 / A4SH-015 / KF-001
    if (/^[A-Za-z0-9]+-\d+$/.test(c)) return { level: 'container', text: '容器 ' + c, parts: { container: c } };
    return { level: 'unknown', text: c, parts: {} };
  }

  /**
   * 解析一个位置编码：优先用台账里的「说明」列（人工维护、最准），
   * 没有记录时按编码规则推导。容器会继续解析到它所在的库位（架-层-位）。
   */
  function resolveLocation(state, code) {
    var c = String(code || '').trim();
    if (!c) return { code: '', level: 'unknown', text: '', source: 'none' };
    var rec = ((state && state.locations) || []).find(function (l) { return l.code === c; });
    var parsed = parseLocationCode(c, rec ? rec.kind : '');
    var out = {
      code: c, level: parsed.level, parts: parsed.parts,
      desc: rec ? (rec.desc || '') : '', kind: rec ? (rec.kind || '') : '',
      source: rec ? '台账' : '编码规则'
    };
    out.text = out.desc || parsed.text;

    // 容器：补出它当前所在的库位，让定位能落到架-层-位
    var ctn = ((state && state.containers) || []).find(function (x) { return x.code === c; });
    if (ctn && ctn.loc) {
      var loc = resolveLocation({ locations: (state && state.locations) || [] }, ctn.loc);
      out.containerAt = { code: ctn.loc, text: loc.text, level: loc.level };
    }
    return out;
  }

  /* ================= 30S 定位：定位质量分级 ================= */

  /**
   * 判定一条定位结果的质量：
   *   exact     精确位置（架-层-位 / 工位格 / 开放区块）
   *   container 只有容器（能落到具体容器，但容器未登记库位）
   *   zone      只有模块区（M-0x，粗略）
   *   clue      只有历史线索（最近扫码/流水/工单的时间与位置）
   *   none      无任何线索
   */
  function gradeLocation(state, located) {
    if (located.loc) {
      var r = resolveLocation(state, located.loc);
      if (r.level === 'shelf' || r.level === 'workstation' || r.level === 'block') return { grade: 'exact', text: r.text, level: r.level };
      if (r.level === 'zone') return { grade: 'zone', text: r.text, level: r.level };
      return { grade: 'exact', text: r.text, level: r.level };
    }
    if (located.container) {
      var cr = resolveLocation(state, located.container);
      if (cr.containerAt) return { grade: 'exact', text: cr.containerAt.text + '（容器 ' + located.container + '）', level: cr.containerAt.level };
      return { grade: 'container', text: '容器 ' + located.container, level: 'container' };
    }
    if (located.zone) {
      var z = parseLocationCode(located.zone);
      return { grade: 'zone', text: z.text, level: 'zone' };
    }
    if (located.lastScan || located.lastTxn || located.lastOrder) {
      var when = located.lastScan ? located.lastScan.time : (located.lastTxn ? located.lastTxn.time : located.lastOrder.execTime);
      var where = located.lastScan && located.lastScan.loc ? located.lastScan.loc : '';
      return { grade: 'clue', text: '最近记录 ' + (when || '—') + (where ? '（当时在 ' + where + '）' : ''), level: 'history' };
    }
    return { grade: 'none', text: '无任何位置线索', level: 'none' };
  }

  /** 单件零件的完整定位结果（扫码页与抽查共用） */
  function locateDetail(state, code) {
    var L = locateMaterial(state, code);
    var g = gradeLocation(state, L);
    return {
      code: code, found: L.found,
      name: L.material ? (L.material.name || '') : '',
      qty: L.material ? L.material.qty : null,
      loc: L.loc, container: L.container, zone: L.zone,
      source: L.source, grade: g.grade, level: g.level, path: g.text,
      lastScan: L.lastScan, lastTxn: L.lastTxn, lastOrder: L.lastOrder
    };
  }

  /**
   * 定位抽查：随机抽 sample 个零件，逐件给出定位结果与质量分级。
   * 用于验收标准 9「随机抽查任一零件，30S 内给出精确位置」的可重复验证。
   * seed 固定时抽样可复现。
   */
  function locateAudit(state, opts) {
    opts = opts || {};
    var all = (state && state.materials) || [];
    var n = Math.min(opts.sample || 10, all.length);
    var seed = opts.seed == null ? 20260915 : opts.seed;

    // 简单的确定性伪随机（LCG），保证同一 seed 抽到同一批，便于复现
    var s = seed >>> 0;
    var rnd = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    var idx = all.map(function (_, i) { return i; });
    for (var i = idx.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    var picked = idx.slice(0, n).map(function (i) { return all[i]; });

    var results = picked.map(function (m) { return locateDetail(state, m.code); });
    var summary = { exact: 0, container: 0, zone: 0, clue: 0, none: 0 };
    results.forEach(function (r) { summary[r.grade] = (summary[r.grade] || 0) + 1; });

    return {
      total: all.length,
      checked: results.length,
      seed: seed,
      results: results,
      summary: summary,
      // 验收口径：每一件都要至少能给出位置或历史线索；且大多数应精确到架-层-位
      ok: summary.none === 0,
      preciseRatio: results.length ? (summary.exact + summary.container) / results.length : 0
    };
  }

  /**
   * 30S 定位：查台账；台账没有（或没有库位）时回查最近扫码 / 流水 / 工单。
   * 纯函数：不写 state、不产生副作用。
   * @returns {{found:boolean, material:object|null, loc:string, container:string, zone:string,
   *            source:string, lastScan:object|null, lastTxn:object|null, lastOrder:object|null}}
   */
  function locateMaterial(state, code) {
    var m = findMaterial(state, code);
    var lastScan = scanHistoryFor(state, code, 1)[0] || null;   // 最近一次扫码（用于时间展示）
    var located = lastScanWithLocation(state, code);            // 最近一次带位置的扫码（用于位置兜底）
    var txn = lastTransactionFor(state, code);
    var order = lastOrderFor(state, code);

    var loc = '', container = '', zone = '', source = '无记录';
    if (m) {
      loc = m.loc || ''; container = m.container || ''; zone = m.zone || '';
      source = '物料台账';
    }
    // 台账里没有库位（或整条记录缺失）→ 用最近一次带位置的扫码记录兜底
    if (!loc && located && located.loc) { loc = located.loc; source = '最近扫码'; }
    if (!container && located && located.container) container = located.container;
    if (!zone && located && located.zone) zone = located.zone;
    // 仍无位置线索 → 由最近一条流水/工单给出「谁在什么时候动过它」
    if (!loc && !m) {
      if (txn) source = '最近流水';
      else if (order) source = '最近工单';
    }

    return {
      found: !!m,
      material: m,
      loc: loc, container: container, zone: zone,
      source: source,
      lastScan: lastScan,
      lastTxn: txn,
      lastOrder: order
    };
  }

  /* ================= 闲鱼数据合并（需求书 4.3） =================
     字段映射：outer_id → 物料码、product_id → 闲鱼XY编号、标题 → 名称、
               stock → 库存、售价/100 → 成本、首图 → 图片链接、分类默认 QT
     合并规则：不覆盖本地已维护的分类/库位/容器/模块区/安全库存；
               空值不覆盖旧值；数量与成本例外 —— 外部值始终采用（0 表示售罄）。 */

  var XIANYU_KEYS = {
    code: ['outer_id', 'outerId', 'outerid', '物料码', '外部编码', '编码'],
    xy: ['product_id', 'productId', 'productid', '闲鱼XY编号', '商品ID', 'item_id'],
    name: ['标题', 'title', '名称', '商品标题'],
    qty: ['stock', '库存', '库存数量', '数量'],
    price: ['售价', 'price', '价格'],
    img: ['首图', 'pic_url', 'picUrl', 'image', '图片链接', '主图']
  };

  /** 从一行外部数据里按候选键名取值（键名大小写不敏感，空值视为未提供） */
  function pickXianyu(row, field) {
    if (!row || typeof row !== 'object') return undefined;
    var keys = XIANYU_KEYS[field] || [];
    var lower = Object.create(null);
    Object.keys(row).forEach(function (k) { lower[String(k).trim().toLowerCase()] = row[k]; });
    for (var i = 0; i < keys.length; i++) {
      var v = lower[keys[i].toLowerCase()];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return undefined;
  }

  /** 外部行 → 规范字段（售价按 priceDivisor 换算成元，默认 /100） */
  function normalizeXianyuRow(row, opts) {
    opts = opts || {};
    var div = opts.priceDivisor == null ? 100 : opts.priceDivisor;
    var price = toQty(pickXianyu(row, 'price'));
    var cv = pickXianyu(row, 'code'), xv = pickXianyu(row, 'xy'), nv = pickXianyu(row, 'name'), iv = pickXianyu(row, 'img');
    return {
      code: String(cv == null ? '' : cv).trim(),
      xy: String(xv == null ? '' : xv).trim(),
      name: String(nv == null ? '' : nv).trim(),
      qty: toQty(pickXianyu(row, 'qty')),
      cost: price === null ? null : round6(price / div),
      img: String(iv == null ? '' : iv).trim()
    };
  }

  /**
   * 把闲鱼数据合并进台账（只补空缺，不覆盖本地已维护字段）。
   * @returns {{created:number, updated:number, unchanged:number, skipped:Array, changes:Array}}
   */
  function mergeXianyu(state, rows, opts) {
    opts = opts || {};
    if (!state || !Array.isArray(state.materials)) throw new Error('mergeXianyu: state.materials 不可用');
    var stat = { created: 0, updated: 0, unchanged: 0, skipped: [], changes: [] };
    var seen = Object.create(null);

    (rows || []).forEach(function (raw, idx) {
      var r = normalizeXianyuRow(raw, opts);
      if (!r.code) { stat.skipped.push({ index: idx, reason: '缺少 outer_id（物料码）' }); return; }
      if (seen[r.code]) { stat.skipped.push({ index: idx, code: r.code, reason: '同一批数据里 outer_id 重复' }); return; }
      seen[r.code] = true;

      var m = findMaterial(state, r.code);
      if (!m) {
        // 新建：只填外部能给到的字段，本地字段用安全默认值
        var fresh = {
          code: r.code, cat: 'QT', name: r.name || '', spec: '', xy: r.xy || '',
          loc: '', container: '', zone: '',
          qty: r.qty === null ? 0 : r.qty,
          minQty: 0,
          cost: r.cost === null ? 0 : r.cost,
          img: r.img || ''
        };
        state.materials.push(fresh);
        stat.created++;
        stat.changes.push({ code: r.code, kind: 'create', fields: Object.keys(fresh) });
        return;
      }

      var changed = [];
      // 数量 / 成本：外部值始终采用（0 表示售罄）
      if (r.qty !== null && r.qty !== m.qty) { changed.push('qty: ' + m.qty + ' → ' + r.qty); m.qty = r.qty; }
      if (r.cost !== null && r.cost !== m.cost) { changed.push('cost: ' + m.cost + ' → ' + r.cost); m.cost = r.cost; }
      // 其余字段：空值不覆盖旧值
      ['name', 'xy', 'img'].forEach(function (f) {
        if (r[f] && r[f] !== m[f]) { changed.push(f + ': ' + (m[f] || '（空）') + ' → ' + r[f]); m[f] = r[f]; }
      });
      // cat / loc / container / zone / minQty 一律不动（本地已维护）

      if (changed.length) { stat.updated++; stat.changes.push({ code: r.code, kind: 'update', fields: changed }); }
      else stat.unchanged++;
    });

    return stat;
  }

  /* ================= 云端合并（飞书为真源） =================
     与「导入合并」（mergePackage：只加不删）语义不同，云端同步必须能把飞书侧的
     删除也带下来，否则网页端会永远留着飞书里已经删掉的记录 —— 这是「两边对不上」
     最主要的来源。判断依据是 syncedKeys（上次同步时飞书有哪些键）：

       飞书有、本地没有              → 加入（created）
       两边都有                      → 飞书覆盖（updated）；但飞书为空的列不覆盖本地非空值（keptLocal）
       本地有、飞书没有、syncedKeys 有 → 飞书侧删掉了 → 本地也删（deleted）
       本地有、飞书没有、syncedKeys 无 → 本地新建还没推上去 → 保留（pending）

     另一处必须挡住的是「推不上去的字段反过来被飞书旧值覆盖」：
     工单状态「部分执行」在飞书单选项里不存在，推送时被丢列，飞书仍是「未执行」；
     下一次同步如果照搬飞书值，本地的「部分执行」就被打回「未执行」。
     所以 opts.protect（{ 表: { 业务键: [本地字段] } }）里的字段一律以本地为准。
  */
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

  function keySet(list, id) {
    var s = Object.create(null);
    (list || []).forEach(function (r) {
      var v = r ? r[id] : null;
      if (v !== undefined && v !== null && v !== '') s[String(v)] = true;
    });
    return s;
  }
  function isBlank(v) { return v === '' || v === null || v === undefined; }

  /**
   * 把飞书拉回来的 remote 合并进 state（原地修改 state）。
   * @param {object} state 网页端 state
   * @param {object} remote pullState() 的结果；某张表不是数组表示「这次没拉到」，那张表整个不动
   * @param {object} [opts] { syncedKeys, protect, txnCap }
   * @returns {{created,updated,unchanged,deleted,keptLocal,pending,changes,tables,syncedKeys}}
   */
  function mergeRemote(state, remote, opts) {
    opts = opts || {};
    if (!state || typeof state !== 'object') throw new Error('mergeRemote: state 不可用');
    if (!remote || typeof remote !== 'object') throw new Error('mergeRemote: remote 不可用');

    var synced = opts.syncedKeys || state.__syncedKeys || {};
    var protect = opts.protect || state.__pushBlocked || {};
    var nextSynced = {};
    var stat = { created: 0, updated: 0, unchanged: 0, deleted: 0, keptLocal: 0, protected: 0, pending: [], pendingDelete: [], changes: [], tables: {} };

    MERGE_TABLES.forEach(function (tbl) {
      var remoteArr = remote[tbl.key];
      if (!Array.isArray(remoteArr)) return;                 // 本次没拉到这张表 → 完全不碰本地

      var remoteKeys = keySet(remoteArr, tbl.id);
      nextSynced[tbl.key] = Object.keys(remoteKeys);
      var wasSynced = null;
      if (Array.isArray(synced[tbl.key])) {
        wasSynced = Object.create(null);
        synced[tbl.key].forEach(function (k) { wasSynced[String(k)] = true; });
      }
      var protTbl = protect[tbl.key] || {};

      if (!Array.isArray(state[tbl.key])) state[tbl.key] = [];
      var localArr = state[tbl.key];
      var byKey = Object.create(null);
      localArr.forEach(function (r) {
        var v = r ? r[tbl.id] : null;
        if (v !== undefined && v !== null && v !== '') byKey[String(v)] = r;
      });

      var t = { created: 0, updated: 0, unchanged: 0, deleted: 0, keptLocal: 0, protected: 0, pending: [], pendingDelete: [] };

      /* 1) 飞书 → 本地 */
      remoteArr.forEach(function (r) {
        if (!r) return;
        var v = r[tbl.id];
        if (v === undefined || v === null || v === '') return;
        var k = String(v);
        var local = byKey[k];
        if (!local) {
          localArr.push(r); byKey[k] = r; t.created++;
          stat.changes.push({ table: tbl.key, id: k, kind: 'create' });
          return;
        }
        var guarded = Object.create(null);
        (protTbl[k] || []).forEach(function (f) { guarded[f] = true; });
        var changed = [], kept = 0, held = 0;
        Object.keys(r).forEach(function (f) {
          var rv = r[f], lv = local[f];
          if (guarded[f]) { held++; return; }                  // 这个字段上次没推上去 → 以本地为准
          if (isBlank(rv) && !isBlank(lv)) { kept++; return; } // 飞书这列是空的 → 不覆盖本地已有值
          if (rv === lv) return;
          if (typeof rv === 'number' && typeof lv === 'number' && Math.abs(rv - lv) < EPS) return;
          local[f] = rv; changed.push(f);
        });
        if (changed.length) { t.updated++; stat.changes.push({ table: tbl.key, id: k, kind: 'update', fields: changed }); }
        else t.unchanged++;
        if (kept) t.keptLocal++;
        if (held) t.protected++;
      });

      /* 2) 本地多余 → 飞书删了 还是 本地还没推
         **默认一律不删。** 删除权放在这一层是危险品：一次半截返回（分页没走完、
         飞书侧限流截断、某页静默少几条）就能把本地成批删掉，而且删完不留任何凭据。
         现在只有调用方**显式**给 allowDelete:true **且**这张表被证明拉全了
         （opts.complete[key] !== false）才真的删；否则记进 pendingDelete，
         交给「对账 → 人工确认删除」那条带闸门的路（fsRunCensus）去处理。
         注意 pendingDelete 的键必须**留在基线里**——否则下一轮它就成了
         「本地有、飞书没有、基线里也没有」，会被 autoPushPending 重新推回飞书，
         等于把飞书刚删掉的记录又建回来。 */
      /* 严格判定：**必须被证明读全了**才允许删。complete 为 false（证明确实截断）
         或 null（拿不到 total，无法证明）都不许删 —— 「证明不了」不等于「没问题」。 */
      var allowDel = opts.allowDelete === true && (!opts.complete || opts.complete[tbl.key] === true);
      var keptSynced = [];
      var alive = [];
      localArr.forEach(function (r) {
        var v = r ? r[tbl.id] : null;
        var k = (v === undefined || v === null || v === '') ? null : String(v);
        if (k && !remoteKeys[k]) {
          if (wasSynced && wasSynced[k]) {
            if (allowDel) {
              t.deleted++; stat.changes.push({ table: tbl.key, id: k, kind: 'delete', reason: '飞书侧已删除' });
              return;
            }
            t.pendingDelete.push(k);
            stat.pendingDelete.push({ table: tbl.key, id: k });
            keptSynced.push(k);
            alive.push(r);
            return;
          }
          t.pending.push(r);
          stat.pending.push({ table: tbl.key, id: k });
          alive.push(r);
          return;
        }
        alive.push(r);
      });
      state[tbl.key] = alive;
      if (keptSynced.length) nextSynced[tbl.key] = nextSynced[tbl.key].concat(keptSynced);

      stat.created += t.created; stat.updated += t.updated; stat.unchanged += t.unchanged;
      stat.deleted += t.deleted; stat.keptLocal += t.keptLocal; stat.protected += t.protected;
      stat.tables[tbl.key] = t;
    });

    /* 3) 流水：新的在前 + 序号单调递增（防换浏览器撞号） */
    if (Array.isArray(state.transactions)) {
      var withSeq = state.transactions.filter(function (x) { return x && x.seq != null; });
      var noSeq = state.transactions.filter(function (x) { return !x || x.seq == null; });
      withSeq.sort(function (a, b) { return (b.seq || 0) - (a.seq || 0); });
      /* Phase 0：**绝不截断流水**。
         旧的 `.slice(0, opts.txnCap || 2000)` 是最危险的一处「本地悄悄丢数据」：
         replayAudit 从首条流水的 balance − delta 反推期初，截断后首条不是真首条，
         于是反推出一个错的期初，整条链算下来余量反而「对得上」——
         **截断把不一致伪装成一致，比报错更危险**。
         而且无 seq 的旧流水被拼在数组尾部、超限时最先被无声扔掉，
         飞书里还在 → 每次同步「拉取新增 N 条」→ 又被截掉 → 永久 churn。
         数据量的问题由 IndexedDB 与覆盖度报告解决，不靠丢数据解决。 */
      state.transactions = withSeq.concat(noSeq);
      var mx = state.txnSeq || 0;
      state.transactions.forEach(function (x) { if ((x.seq || 0) > mx) mx = x.seq || 0; });
      state.txnSeq = mx;
    }

    state.__syncedKeys = nextSynced;
    if (opts.protect) state.__pushBlocked = opts.protect;
    stat.syncedKeys = nextSynced;
    return stat;
  }

  return {
    WIP_NAMES: WIP_NAMES,
    STATUS: STATUS,
    statusLabel: statusLabel,
    isPending: isPending,
    isCancelled: isCancelled,
    isFullyExecuted: isFullyExecuted,
    isPartiallyExecuted: isPartiallyExecuted,
    isOrderOpen: isOrderOpen,
    orderProgress: orderProgress,
    orderSummary: orderSummary,
    executedMap: executedMap,
    cancelOrder: cancelOrder,
    updateOrderPlan: updateOrderPlan,
    reverseOrder: reverseOrder,
    orderTransactions: orderTransactions,
    orderHistory: orderHistory,
    OUTBOUND_TYPES: OUTBOUND_TYPES,
    BLOCKED_STATUSES: BLOCKED_STATUSES,
    toQty: toQty,
    isOutbound: isOutbound,
    signOf: signOf,
    findMaterial: findMaterial,
    findOrder: findOrder,
    isOrderExecuted: isOrderExecuted,
    normalizeItems: normalizeItems,
    mergedCodes: mergedCodes,
    isItemizedOrder: isItemizedOrder,
    normalizeItemLines: normalizeItemLines,
    itemizedPlannedCodes: itemizedPlannedCodes,
    findItem: findItem,
    itemPosition: itemPosition,
    validateItemScan: validateItemScan,
    buildItemExecCommands: buildItemExecCommands,
    applyItemExecResult: applyItemExecResult,
    buildItemReverseCommands: buildItemReverseCommands,
    applyItemReverseResult: applyItemReverseResult,
    createOrder: createOrder,
    canonicalOrder: canonicalOrder,
    workorderDuplicateGroups: workorderDuplicateGroups,
    collapseIdenticalWorkorderDuplicates: collapseIdenticalWorkorderDuplicates,
    restoreWorkorderDuplicateCollapse: restoreWorkorderDuplicateCollapse,
    recordTransaction: recordTransaction,
    reconcileTxnSeq: reconcileTxnSeq,
    applyStockChange: applyStockChange,
    validateExecution: validateExecution,
    executeOrder: executeOrder,
    parseStocktakeInput: parseStocktakeInput,
    applyStocktake: applyStocktake,
    applyManualAdjust: applyManualAdjust,
    orderedTransactions: orderedTransactions,
    ledgerRepairPlan: ledgerRepairPlan,
    replayAudit: replayAudit,
    applyRemoteChanges: applyRemoteChanges,
    recordScan: recordScan,
    scanHistoryFor: scanHistoryFor,
    lastTransactionFor: lastTransactionFor,
    lastOrderFor: lastOrderFor,
    timeAgo: timeAgo,
    locateMaterial: locateMaterial,
    parseLocationCode: parseLocationCode,
    resolveLocation: resolveLocation,
    gradeLocation: gradeLocation,
    locateDetail: locateDetail,
    locateAudit: locateAudit,
    pickXianyu: pickXianyu,
    normalizeXianyuRow: normalizeXianyuRow,
    mergeXianyu: mergeXianyu,
    mergeRemote: mergeRemote,
    MERGE_TABLES: MERGE_TABLES,
    round6: round6
  };
});
