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

  /* ================= 工单创建 ================= */

  /**
   * 创建工单：校验物料存在性 + 自动合并重复物料。
   * @returns {{ok:boolean, errors:string[], order?:object, merged?:string[], dropped?:Array}}
   */
  function createOrder(state, opts) {
    opts = opts || {};
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
    state.workorders.push(order);
    return { ok: true, errors: [], order: order, merged: mergedCodes(norm.items), dropped: norm.dropped };
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
      applied.push({ matCode: a.matCode, qty: a.qty, planned: a.planned, executed: a.executed, remaining: a.remaining, delta: r.delta, balance: r.balance });
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

  /* ================= 工单取消与冲销 ================= */

  /**
   * 取消工单：仅允许「未执行任何数量」的工单（待执行）。
   * 已执行过（含部分执行）的工单必须先「冲销」，避免库存与状态脱节。
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
      applied.push({ matCode: it.matCode, qty: it.executed, delta: r.delta, balance: r.balance });
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

  /** 工单关联的库存流水（时间正序） */
  function orderTransactions(state, code) {
    return orderedTransactions(state).filter(function (t) { return t.ref === code; });
  }

  /** 工单完整历史追溯：创建 → 各次执行批次 → 取消/冲销 */
  function orderHistory(order) {
    if (!order) return [];
    var hist = [{ kind: 'create', at: order.date || '', operator: '', text: '创建工单（' + (WIP_NAMES[order.type] || order.type) + '），计划 ' + normalizeItems(order.items).items.length + ' 项' }];
    ((order.execBatches) || []).forEach(function (b, i) {
      hist.push({
        kind: 'execute', at: b.at || '', operator: b.operator || '', batch: i + 1,
        items: b.items || [],
        text: '第 ' + (i + 1) + ' 次执行：' + (b.items || []).map(function (x) { return x.matCode + ' ' + (x.delta > 0 ? '+' : '') + x.delta; }).join('，')
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

  /* ================= 回放校验 ================= */

  /** 全量流水按时间正序（旧数据无 seq 视为在 seq 之前） */
  function orderedTransactions(state) {
    var all = ((state && state.transactions) || []).slice();
    var legacy = all.filter(function (t) { return t.seq === null || t.seq === undefined; }).reverse();
    var seqd = all.filter(function (t) { return t.seq !== null && t.seq !== undefined; })
      .sort(function (a, b) { return (a.seq - b.seq) || String(a.device).localeCompare(String(b.device)); });
    return legacy.concat(seqd);
  }

  /**
   * 回放校验：从首条余量反推期初，逐条重算链式余量并与记录比对。
   * @returns {{ok:boolean, materials:number, transactions:number, compared:number, mismatches:Array}}
   */
  function replayAudit(state) {
    var ord = orderedTransactions(state);
    var byMat = Object.create(null);
    ord.forEach(function (t) { (byMat[t.matCode] = byMat[t.matCode] || []).push(t); });

    var mismatches = [];
    var compared = 0;
    Object.keys(byMat).forEach(function (code) {
      var run = null;
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

    return {
      ok: mismatches.length === 0,
      materials: Object.keys(byMat).length,
      transactions: ord.length,
      compared: compared,
      mismatches: mismatches
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
    createOrder: createOrder,
    recordTransaction: recordTransaction,
    applyStockChange: applyStockChange,
    validateExecution: validateExecution,
    executeOrder: executeOrder,
    parseStocktakeInput: parseStocktakeInput,
    applyStocktake: applyStocktake,
    applyManualAdjust: applyManualAdjust,
    orderedTransactions: orderedTransactions,
    replayAudit: replayAudit,
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
    mergeXianyu: mergeXianyu
  };
});
