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
        clear: async function (name) { assertStore(name); target[name].clear(); }
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
      async clear(name) { return store.transaction([name], function (tx) { return tx.clear(name); }); }
    };
    return store;
  }

  function createIndexedDbStore(opts) {
    opts = opts || {};
    var idb = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    var dbName = opts.dbName || DEFAULT_DB;
    var version = opts.version || DB_VERSION;
    var db = null;

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
        clear: async function (name) { assertStore(name); await reqPromise(tx.objectStore(name).clear()); }
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
      async clear(name) { return store.transaction([name], function (tx) { return tx.clear(name); }); }
    };
    return store;
  }

  return { DB_VERSION: DB_VERSION, DEFAULT_DB: DEFAULT_DB, STORE_NAMES: STORE_NAMES, createMemoryStore: createMemoryStore, createIndexedDbStore: createIndexedDbStore };
});
