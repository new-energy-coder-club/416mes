/*!
 * lib/store.js — 416MES Phase 1 的本地真源仓储（UMD）
 *
 * 所有方法均为 Promise。IndexedDB 天生异步，绝不能把它伪装成同步
 * localStorage；否则调用方把 Promise 当数组使用时会造成静默丢数据。
 *
 * Store schema:
 *   records          keyPath [table,key]
 *   transactions     keyPath seq; indexes by_ts(ts), by_mat(matCode)
 *   outbox           keyPath id
 *   baselines        keyPath key
 *   conflicts        keyPath key
 *   syncMeta         keyPath key
 *   deletionJournal  keyPath key
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MesStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DB_VERSION = 1;
  var DEFAULT_DB = 'mes416-store';
  var STORE_NAMES = ['records', 'transactions', 'outbox', 'baselines', 'conflicts', 'syncMeta', 'deletionJournal'];
  var META_STORES = ['baselines', 'conflicts', 'syncMeta', 'deletionJournal'];

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function assertStore(name) { if (STORE_NAMES.indexOf(name) < 0) throw new Error('未知 store：' + name); }
  function keyString(key) { return JSON.stringify(key); }
  function keyFor(name, value, explicit) {
    if (explicit !== undefined) return explicit;
    if (!value || typeof value !== 'object') throw new Error(name + ' 缺少记录对象');
    if (name === 'records') return [value.table, value.key];
    if (name === 'transactions') return value.seq;
    if (name === 'outbox') return value.id;
    return value.key;
  }
  function ensureKeyFields(name, value, explicit) {
    var v = clone(value);
    var k = keyFor(name, v, explicit);
    if (name === 'records') {
      if (!Array.isArray(k) || k.length !== 2 || k[0] == null || k[1] == null) throw new Error('records 键必须是 [table,key]');
      v.table = k[0]; v.key = k[1];
    } else if (name === 'transactions') {
      if (k == null || !Number.isFinite(Number(k))) throw new Error('transactions 缺少有效 seq');
      v.seq = Number(k);
    } else if (name === 'outbox') {
      if (!k) throw new Error('outbox 缺少 id');
      v.id = String(k);
    } else {
      if (!k) throw new Error(name + ' 缺少 key');
      v.key = String(k);
    }
    return v;
  }
  function reqPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 请求失败')); };
    });
  }
  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
      tx.onerror = function () { /* onabort 统一拒绝 */ };
    });
  }

  /**
   * 可注入、确定性的异步内存后端。它和 IndexedDB 后端共享同一合同，
   * 用于 Node 单测，且可验证「同一 transaction 的写入要么全有、要么全无」。
   */
  function createMemoryStore(opts) {
    opts = opts || {};
    var maps = Object.create(null), opened = false;
    STORE_NAMES.forEach(function (name) { maps[name] = new Map(); });

    function makeApi(target) {
      return {
        get: async function (name, key) { assertStore(name); return clone(target[name].get(keyString(key))); },
        put: async function (name, value, key) {
          assertStore(name);
          var v = ensureKeyFields(name, value, key);
          target[name].set(keyString(keyFor(name, v)), clone(v));
          return clone(v);
        },
        del: async function (name, key) { assertStore(name); target[name].delete(keyString(key)); },
        getAll: async function (name) { assertStore(name); return Array.from(target[name].values()).map(clone); },
        clear: async function (name) { assertStore(name); target[name].clear(); },
        iterate: async function (name, onChunk, opts) {
          assertStore(name);
          var size = (opts && opts.chunk) || 500;
          var all = Array.from(target[name].values());
          for (var i = 0; i < all.length; i += size) await onChunk(all.slice(i, i + size).map(clone), i);
          return all.length;
        },
        replaceAll: async function (name, values) {
          assertStore(name); target[name].clear();
          for (var i = 0; i < (values || []).length; i++) {
            var v = ensureKeyFields(name, values[i]);
            target[name].set(keyString(keyFor(name, v)), clone(v));
          }
        }
      };
    }
    var store = {
      kind: 'memory',
      async open() { opened = true; return store; },
      async close() { opened = false; },
      async transaction(names, fn) {
        if (!opened) throw new Error('store 未打开');
        names = names || STORE_NAMES;
        names.forEach(assertStore);
        var staged = Object.create(null);
        STORE_NAMES.forEach(function (name) { staged[name] = new Map(maps[name]); });
        var result = await fn(makeApi(staged));
        names.forEach(function (name) { maps[name] = staged[name]; });
        return result;
      },
      async get(name, key) { return store.transaction([name], function (tx) { return tx.get(name, key); }); },
      async put(name, value, key) { return store.transaction([name], function (tx) { return tx.put(name, value, key); }); },
      async del(name, key) { return store.transaction([name], function (tx) { return tx.del(name, key); }); },
      async getAll(name) { return store.transaction([name], function (tx) { return tx.getAll(name); }); },
      async iterate(name, onChunk, opts) { return store.transaction([name], function (tx) { return tx.iterate(name, onChunk, opts); }); },
      async clear(name) { return store.transaction([name], function (tx) { return tx.clear(name); }); },
      /* v3.6.0 一键重置：清空全部仓库（memory 实现，与 indexeddb 版语义一致） */
      async wipeAll() {
        var wiped = [];
        for (var i = 0; i < STORE_NAMES.length; i++) { await store.clear(STORE_NAMES[i]); wiped.push(STORE_NAMES[i]); }
        return wiped;
      }
    };
    return store;
  }

  function createIndexedDbStore(opts) {
    opts = opts || {};
    var idb = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    var dbName = opts.dbName || DEFAULT_DB;
    var version = opts.version || DB_VERSION;
    var db = null;
    // 用与 indexedDB 同一 realm 的 IDBKeyRange（fake-indexeddb 需要显式传入）
    var IDBKeyRangeImpl = opts.IDBKeyRange || (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);

    if (!idb) throw new Error('当前环境不支持 IndexedDB；不能静默退回 localStorage 主存储');

    function upgrade(database) {
      if (!database.objectStoreNames.contains('records')) database.createObjectStore('records', { keyPath: ['table', 'key'] });
      if (!database.objectStoreNames.contains('transactions')) {
        var txns = database.createObjectStore('transactions', { keyPath: 'seq' });
        txns.createIndex('by_ts', 'ts', { unique: false });
        txns.createIndex('by_mat', 'matCode', { unique: false });
      }
      if (!database.objectStoreNames.contains('outbox')) database.createObjectStore('outbox', { keyPath: 'id' });
      META_STORES.forEach(function (name) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'key' });
      });
    }
    function apiFor(tx) {
      return {
        get: async function (name, key) { assertStore(name); return clone(await reqPromise(tx.objectStore(name).get(key))); },
        put: async function (name, value, key) {
          assertStore(name); var v = ensureKeyFields(name, value, key);
          await reqPromise(tx.objectStore(name).put(v)); return clone(v);
        },
        del: async function (name, key) { assertStore(name); await reqPromise(tx.objectStore(name).delete(key)); },
        getAll: async function (name) { assertStore(name); return (await reqPromise(tx.objectStore(name).getAll())).map(clone); },
        clear: async function (name) { assertStore(name); await reqPromise(tx.objectStore(name).clear()); },
        getPage: async function (name, afterKey, size) {
          assertStore(name);
          var range = null;
          if (afterKey !== null && afterKey !== undefined) {
            if (!IDBKeyRangeImpl) throw new Error('缺少 IDBKeyRange（IndexedDB 环境异常）');
            range = IDBKeyRangeImpl.lowerBound(afterKey, true);   // 严格大于 afterKey
          }
          return (await reqPromise(tx.objectStore(name).getAll(range, size))).map(clone);
        },
        replaceAll: async function (name, values) {
          assertStore(name);
          var os = tx.objectStore(name); await reqPromise(os.clear());
          for (var i = 0; i < (values || []).length; i++) await reqPromise(os.put(ensureKeyFields(name, values[i])));
        }
      };
    }
    var store = {
      kind: 'indexeddb', dbName: dbName,
      async open() {
        if (db) return store;
        var request = idb.open(dbName, version);
        request.onupgradeneeded = function () { upgrade(request.result); };
        db = await reqPromise(request);
        db.onversionchange = function () { try { db.close(); } finally { db = null; } };
        return store;
      },
      async close() { if (db) db.close(); db = null; },
      async transaction(names, fn) {
        if (!db) throw new Error('store 未打开');
        names = names || STORE_NAMES;
        names.forEach(assertStore);
        var tx = db.transaction(names, 'readwrite');
        var result;
        try { result = await fn(apiFor(tx)); }
        catch (e) { try { tx.abort(); } catch (_) {} await txDone(tx).catch(function () {}); throw e; }
        await txDone(tx);
        return result;
      },
      async get(name, key) {
        if (!db) throw new Error('store 未打开'); assertStore(name);
        var tx = db.transaction([name], 'readonly'); var result = await reqPromise(tx.objectStore(name).get(key)); await txDone(tx); return clone(result);
      },
      async put(name, value, key) { return store.transaction([name], function (tx) { return tx.put(name, value, key); }); },
      async del(name, key) { return store.transaction([name], function (tx) { return tx.del(name, key); }); },
      async getAll(name) {
        if (!db) throw new Error('store 未打开'); assertStore(name);
        var tx = db.transaction([name], 'readonly'); var result = await reqPromise(tx.objectStore(name).getAll()); await txDone(tx); return result.map(clone);
      },
      /**
       * 流式读：几万条流水导出时**不把整表读进内存**。
       *
       * 为什么按主键分页而不是用 openCursor + await：
       * IndexedDB 的事务在「微任务队列清空且没有挂起请求」时就会自动提交。
       * 游标回调里 await 一个普通 Promise（哪怕是同步函数包一层），
       * 事务可能在 cur.continue() 之前就提交了，游标静默失效 ——
       * 实测真实浏览器上 iterate 返回 0 条，而 fake-indexeddb 测不出来。
       * 每页开一个独立只读事务反而更稳，也让 onChunk 有机会做异步工作。
       */
      async iterate(name, onChunk, opts) {
        if (!db) throw new Error('store 未打开'); assertStore(name);
        var size = (opts && opts.chunk) || 500;
        var last = null, total = 0;
        for (;;) {
          var page = await store.transaction([name], function (tx) { return tx.getPage(name, last, size); });
          if (!page.length) break;
          total += page.length;
          if (name === 'records') {
            // records 是复合主键 [table,key]，没法用单值游标续读；但记录条数与流水不是一个量级
            var all = await store.getAll('records');
            if (all.length) await onChunk(all, all.length);
            return all.length;
          }
          /* 2.51.1（审计 F Bug1/Bug8）：按 store 实际 keyPath 取续读键——outbox 的 keyPath
             是 'id'（不是 'key'），取错字段 last=undefined → 永远重读第 1 页（死循环+重复）。
             records 是复合主键 [table,key]，走上面的全量分支。 */
          var keyField = ({ transactions: 'seq', outbox: 'id', baselines: 'key', conflicts: 'key', syncMeta: 'key', deletionJournal: 'key' })[name] || 'key';
          last = page[page.length - 1][keyField];
          await onChunk(page, total);
          if (page.length < size) break;
        }
        return total;
      },
      async clear(name) { return store.transaction([name], function (tx) { return tx.clear(name); }); },
      /* v3.6.0 一键重置：清空全部仓库（records/transactions/outbox/baselines/conflicts/syncMeta/deletionJournal）。
         逐仓独立事务——单个失败不拖垮整体，由调用方汇总报告。 */
      async wipeAll() {
        var wiped = [], failed = [];
        for (var i = 0; i < STORE_NAMES.length; i++) {
          var name = STORE_NAMES[i];
          try { await store.clear(name); wiped.push(name); }
          catch (e) { failed.push(name + ': ' + (e && e.message || e)); }
        }
        if (failed.length) throw new Error('部分仓库清空失败：' + failed.join('；'));
        return wiped;
      }
    };
    return store;
  }

  return { DB_VERSION: DB_VERSION, DEFAULT_DB: DEFAULT_DB, STORE_NAMES: STORE_NAMES, createMemoryStore: createMemoryStore, createIndexedDbStore: createIndexedDbStore };
});
