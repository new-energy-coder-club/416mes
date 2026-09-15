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
   * 执行前校验。关键：先把工单明细按物料汇总，再整体比对库存，
   * 因此「同一物料多行、合计超库存」会被拦截（修复负库存 bug）。
   */
  function validateExecution(state, order, execQtyByCode) {
    var errors = [];
    if (!order) return { ok: false, errors: ['工单不存在'], aggregated: [] };
    if (isOrderExecuted(order)) {
      return { ok: false, errors: ['工单 ' + order.code + ' 状态为「' + order.status + '」，不可重复执行'], aggregated: [] };
    }
    var norm = normalizeItems(order.items);
    if (!norm.items.length) errors.push('工单无有效明细');

    var aggregated = norm.items.map(function (e) {
      var override = execQtyByCode ? toQty(execQtyByCode[e.matCode]) : null;
      return { matCode: e.matCode, planned: e.qty, qty: override === null ? e.qty : override };
    });

    aggregated.forEach(function (a) {
      if (a.qty === null || a.qty <= 0) errors.push(a.matCode + ' 执行数量必须为正数（当前 ' + a.qty + '）');
      else if (!findMaterial(state, a.matCode)) errors.push('物料未建档：' + a.matCode);
    });

    var sign = signOf(order.type);
    if (sign < 0) {
      aggregated.forEach(function (a) {
        var m = findMaterial(state, a.matCode);
        if (m && a.qty > 0) {
          var stock = toQty(m.qty);
          if (stock === null) stock = 0;
          if (stock < a.qty) errors.push(a.matCode + ' 库存不足（现 ' + stock + '，需 ' + a.qty + '）');
        }
      });
    }
    return { ok: errors.length === 0, errors: errors, aggregated: aggregated, sign: sign, merged: mergedCodes(norm.items) };
  }

  /**
   * 执行工单：校验 → 逐物料走 applyStockChange → 记录执行数量与批次。
   * 计划数量（item.qty）保持不变，执行数量记在 order.execQty / order.execBatches。
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
      var r = applyStockChange(state, {
        matCode: a.matCode, mode: 'delta', qty: v.sign * a.qty, type: typeName, ref: order.code,
        reason: '', operator: opts.operator, device: opts.device, now: now
      });
      if (!r.ok) return { ok: false, errors: [r.error], applied: applied };
      applied.push({ matCode: a.matCode, qty: a.qty, planned: a.planned, delta: r.delta, balance: r.balance });
    }

    var execTime = now.toLocaleString();
    order.execQty = applied.map(function (a) { return { matCode: a.matCode, qty: a.qty }; });
    order.execTime = execTime;
    order.status = '已执行';
    order.execBatches = (order.execBatches || []).concat([{
      at: execTime,
      operator: opts.operator != null ? opts.operator : (state.operator || ''),
      items: applied.map(function (a) { return { matCode: a.matCode, qty: a.qty, delta: a.delta }; })
    }]);
    return { ok: true, errors: [], applied: applied, sign: v.sign, execTime: execTime };
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

  return {
    WIP_NAMES: WIP_NAMES,
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
    locateMaterial: locateMaterial
  };
});
