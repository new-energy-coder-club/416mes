/**
 * lib/outbox.js — 待提交操作日志（outbox）与「视图投影」
 *
 * 为什么要有这个文件：
 *   同步逻辑原来全写在 index.html 里，Node 测不到 —— 于是「离线队列只进不出」
 *   「失败 5 次静默丢数据」这类问题只能在真机上撞见。抽成 UMD 模块后，
 *   浏览器用 window.Outbox，Node 直接 require，可以完整单测。
 *
 * 概念模型（对应 数据真源方案.md §四）：
 *   飞书 = 唯一提交点（commit point）
 *   本地 = 「飞书快照的缓存」+「尚未提交的操作队列」
 *   视图 = 快照 ⊕ 未提交操作        ← project() 就是这个纯函数
 *
 * 本文件只做两件事，都不碰网络、不碰 DOM：
 *   1. create()  —— outbox 的持久化读写（存储可注入，便于测试）
 *   2. project() —— 把 outbox 投影到快照上，算出该显示什么
 *
 * Phase 1 的约束：**行为与原来完全一致**。
 *   所以默认键仍是旧的 mes416_fs_queue，条目结构也兼容旧格式（只是多了个 id）。
 *   换新键 + 迁移旧数据是 Phase 2 的事，见 数据真源方案.md。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Outbox = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Phase 1 沿用旧键，保证零行为变化 */
  var DEFAULT_KEY = 'mes416_fs_queue';

  /**
   * 8 张表的业务主键。必须与 mes-core.js 的 MERGE_TABLES 一致 ——
   * outbox.test.js 里有一条断言专门盯这个，防止两边漂移。
   */
  var DEFAULT_TABLES = [
    { key: 'materials', id: 'code' },
    { key: 'locations', id: 'code' },
    { key: 'containers', id: 'code' },
    { key: 'members', id: 'code' },
    { key: 'items', id: 'code' },
    { key: 'manuals', id: 'code' },
    { key: 'workorders', id: 'code' },
    { key: 'transactions', id: 'seq' }
  ];

  /* ---------- 存储 ---------- */

  /** 内存存储：Node 测试用，行为与 localStorage 的最小交集一致 */
  function memoryStorage() {
    var m = Object.create(null);
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }

  function pickStorage(s) {
    if (s) return s;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* 隐私模式等 */ }
    return memoryStorage();
  }

  function safeParse(raw, fallback) {
    try {
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v : fallback;
    } catch (e) { return fallback; }
  }

  /**
   * 两个条目是不是「同一个操作」。
   * 用于入队去重：同一件事重复入队只会堆垃圾，且会重复提交。
   * 比较时忽略 id / tries / lastError / status 这些**元数据**，只比语义载荷。
   */
  function sameOp(a, b) {
    if (!a || !b) return false;
    if ((a.op || 'stock') !== (b.op || 'stock')) return false;
    var strip = function (x) {
      var o = {};
      Object.keys(x).forEach(function (k) {
        if (k === 'id' || k === 'tries' || k === 'lastError' || k === 'status') return;
        o[k] = x[k];
      });
      // records / keys 数组的顺序不影响语义
      if (Array.isArray(o.records)) o.records = o.records.slice().sort(function (p, q) { return JSON.stringify(p) < JSON.stringify(q) ? -1 : 1; });
      if (Array.isArray(o.keys)) o.keys = o.keys.slice().sort();
      return o;
    };
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  }

  /** 给没有 id 的旧条目补一个稳定的 id（旧队列里没有 id 字段） */
  function ensureId(item, seq) {
    if (item && item.id) return item;
    var copy = Object.assign({}, item);
    copy.id = 'q' + seq + '-' + Math.random().toString(36).slice(2, 8);
    return copy;
  }

  /* ---------- outbox ---------- */

  /**
   * @param {object} [opts] { storage, key, maxTries }
   *   storage 可注入（测试用内存实现）；默认 localStorage
   * @returns outbox 实例
   */
  function create(opts) {
    opts = opts || {};
    var storage = pickStorage(opts.storage);
    var key = opts.key || DEFAULT_KEY;
    var maxTries = opts.maxTries == null ? 5 : opts.maxTries;
    var seq = 0;

    function list() {
      var raw = storage.getItem(key);
      var arr = safeParse(raw, []);
      var changed = false;
      arr = arr.map(function (it) {
        if (it && it.id) return it;
        changed = true;
        return ensureId(it, ++seq);
      });
      if (changed) save(arr);       // 补完 id 立刻落盘，避免每次读都重新生成
      return arr;
    }

    function save(items) {
      storage.setItem(key, JSON.stringify(items || []));
      return items || [];
    }

    /** 入队；同一操作已在队列里就不重复加。返回当前队列 */
    function append(item) {
      var q = list();
      if (!q.some(function (x) { return sameOp(x, item); })) {
        q.push(ensureId(item, ++seq));
        save(q);
      }
      return q;
    }

    function removeById(id) {
      var q = list().filter(function (x) { return x.id !== id; });
      return save(q);
    }

    /** 记一次失败：tries+1、写 lastError；**不在这里丢弃**（是否丢弃由 prune 决定） */
    function markAttempt(id, err) {
      var q = list().map(function (x) {
        if (x.id !== id) return x;
        var tries = (x.tries || 0) + 1;
        var status = tries >= maxTries ? 'needs_attention' : (x.status || 'pending');
        return Object.assign({}, x, { tries: tries, status: status, lastError: err || '' });
      });
      return save(q);
    }

    /** 显式人工放弃；自动流程不得调用。 */
    function prune(limit) {
      var cap = limit == null ? maxTries : limit;
      var kept = [], dropped = [];
      list().forEach(function (x) {
        if (x.status === 'needs_attention' && (x.tries || 0) >= cap) dropped.push(x); else kept.push(x);
      });
      if (dropped.length) save(kept);
      return { kept: kept, dropped: dropped };
    }

    function clear() { return save([]); }

    function summary() {
      var q = list();
      var byStatus = {};
      q.forEach(function (x) { var s = x.status || 'pending'; byStatus[s] = (byStatus[s] || 0) + 1; });
      return {
        total: q.length,
        byStatus: byStatus,
        failed: q.filter(function (x) { return (x.tries || 0) > 0; }).length,
        lastError: (q.filter(function (x) { return x.lastError; }).slice(-1)[0] || {}).lastError || ''
      };
    }

    return {
      key: key, storage: storage, maxTries: maxTries,
      list: list, save: save, append: append, removeById: removeById,
      markAttempt: markAttempt, prune: prune, clear: clear, summary: summary
    };
  }

  /* ---------- 投影：视图 = 快照 ⊕ 未提交操作 ---------- */

  function keyOfTable(tables, name) {
    for (var i = 0; i < tables.length; i++) if (tables[i].key === name) return tables[i].id;
    return 'code';
  }

  /**
   * 把 outbox 里的未提交操作投影到飞书快照上，得到「界面该显示什么」。
   *
   * 纯函数：不修改 snapshot，也不修改 items。
   *
   * @param {object} snapshot 飞书快照（state 的形状）
   * @param {Array}  items    outbox 条目
   * @param {object} [opts]   { tables }
   * @returns {{view:object, pending:{table:string[]}, counts:object}}
   *   view        投影结果（可直接渲染）
   *   pending     每张表里「有未提交改动」的业务键，用于打「☁️未同步」角标
   *   counts      各表未提交条数
   */
  function project(snapshot, items, opts) {
    opts = opts || {};
    snapshot = snapshot || {};
    var tables = opts.tables || DEFAULT_TABLES;

    var view = {};
    tables.forEach(function (t) { view[t.key] = Array.isArray(snapshot[t.key]) ? snapshot[t.key].slice() : []; });

    var pending = {};
    var counts = {};
    tables.forEach(function (t) { pending[t.key] = {}; counts[t.key] = 0; });

    var mark = function (table, keyVal) {
      if (keyVal === undefined || keyVal === null || keyVal === '') return;
      if (!pending[table]) { pending[table] = {}; counts[table] = 0; }
      pending[table][String(keyVal)] = true;
      counts[table]++;
    };

    (items || []).forEach(function (it) {
      if (!it) return;
      if (it.status === 'gaveup') return;          // 已放弃的不参与投影
      var op = it.op || 'stock';

      if (op === 'upsert') {
        var table = it.table;
        if (!Array.isArray(view[table])) { view[table] = []; pending[table] = pending[table] || {}; counts[table] = counts[table] || 0; }
        var id = keyOfTable(tables, table);
        (it.records || []).forEach(function (rec) {
          if (!rec) return;
          var kv = rec[id];
          if (kv === undefined || kv === null || kv === '') return;
          var idx = -1;
          for (var i = 0; i < view[table].length; i++) {
            if (String(view[table][i][id]) === String(kv)) { idx = i; break; }
          }
          if (idx >= 0) view[table][idx] = Object.assign({}, view[table][idx], rec);
          else view[table].push(Object.assign({}, rec));
          mark(table, kv);
        });
        return;
      }

      if (op === 'delete') {
        var t2 = it.table;
        if (!Array.isArray(view[t2])) { view[t2] = []; pending[t2] = pending[t2] || {}; counts[t2] = counts[t2] || 0; }
        var id2 = keyOfTable(tables, t2);
        var want = {};
        (it.keys || []).forEach(function (k) { want[String(k)] = true; });
        view[t2] = view[t2].filter(function (r) { return !want[String(r[id2])]; });
        (it.keys || []).forEach(function (k) { mark(t2, k); });
        return;
      }

      if (op === 'stock') {
        // 库存写入：把未提交的数量投影到物料行上。
        // 流水本身不在这里造 —— 它由服务端生成、下次拉取时带回，本地不假装已经记账。
        if (!Array.isArray(view.materials)) view.materials = [];
        var idxM = -1;
        for (var j = 0; j < view.materials.length; j++) {
          if (String(view.materials[j].code) === String(it.matCode)) { idxM = j; break; }
        }
        if (idxM >= 0) view.materials[idxM] = Object.assign({}, view.materials[idxM], { qty: it.qty });
        mark('materials', it.matCode);
        return;
      }
    });

    var pendingArr = {};
    Object.keys(pending).forEach(function (t) {
      var ks = Object.keys(pending[t]);
      if (ks.length) pendingArr[t] = ks;
    });
    // counts 按「操作条数」统计，键去重后更贴近用户感知的"待提交几件事"
    Object.keys(pendingArr).forEach(function (t) { counts[t] = pendingArr[t].length; });

    return { view: view, pending: pendingArr, counts: counts };
  }

  return {
    DEFAULT_KEY: DEFAULT_KEY,
    DEFAULT_TABLES: DEFAULT_TABLES,
    create: create,
    project: project,
    sameOp: sameOp,
    memoryStorage: memoryStorage
  };
});
