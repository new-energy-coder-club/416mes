'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../lib/store.js');

function backends() {
  const out = [['memory', () => Store.createMemoryStore()]];
  try {
    const fidb = require('fake-indexeddb');
    out.push(['indexeddb', () => Store.createIndexedDbStore({
      indexedDB: fidb.indexedDB,
      dbName: 'mes416-store-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    })]);
  } catch (_) { /* fake-indexeddb is optional in minimal installs */ }
  return out;
}

for (const [kind, make] of backends()) {
  test('store[' + kind + ']：open / compound records CRUD', async () => {
    const store = make();
    await store.open();
    await store.put('records', { table: 'materials', key: 'A-1', name: '螺丝刀' });
    assert.deepEqual(await store.get('records', ['materials', 'A-1']), { table: 'materials', key: 'A-1', name: '螺丝刀' });
    await store.del('records', ['materials', 'A-1']);
    assert.equal(await store.get('records', ['materials', 'A-1']), undefined);
    await store.close();
  });

  test('store[' + kind + ']：同一 transaction 异常时 records + outbox 全部回滚', async () => {
    const store = make();
    await store.open();
    await assert.rejects(() => store.transaction(['records', 'outbox'], async tx => {
      await tx.put('records', { table: 'materials', key: 'A-1', qty: 2 });
      await tx.put('outbox', { id: 'op-1', op: 'stock' });
      throw new Error('模拟事务失败');
    }), /模拟事务失败/);
    assert.equal(await store.get('records', ['materials', 'A-1']), undefined);
    assert.equal(await store.get('outbox', 'op-1'), undefined);
    await store.close();
  });

  test('store[' + kind + ']：同一 transaction 成功后投影与 outbox 一起持久化', async () => {
    const store = make();
    await store.open();
    await store.transaction(['records', 'outbox'], async tx => {
      await tx.put('records', { table: 'materials', key: 'A-1', qty: 8 });
      await tx.put('outbox', { id: 'op-1', op: 'stock', matCode: 'A-1', delta: -2 });
    });
    assert.equal((await store.get('records', ['materials', 'A-1'])).qty, 8);
    assert.equal((await store.get('outbox', 'op-1')).delta, -2);
    await store.close();
  });

  test('store[' + kind + ']：replaceAll 原子替换流水快照', async () => {
    const store = make(); await store.open();
    await store.put('transactions', { seq: 1, matCode: 'OLD', delta: 1 });
    await store.transaction(['transactions'], async tx => {
      await tx.replaceAll('transactions', [
        { seq: 2, matCode: 'A-1', delta: 2, ts: 't2' },
        { seq: 3, matCode: 'A-1', delta: -1, ts: 't3' }
      ]);
    });
    const rows = await store.getAll('transactions');
    assert.deepEqual(rows.map(r => r.seq).sort((a, b) => a - b), [2, 3]);
    await store.close();
  });
  test('store[' + kind + ']：transactions 与 metadata 使用声明键持久化', async () => {
    const store = make();
    await store.open();
    await store.put('transactions', { seq: 7, matCode: 'A-1', delta: 2, ts: '2026-09-16T00:00:00.000Z' });
    await store.put('syncMeta', { key: 'migration-v1', value: { done: true } });
    assert.equal((await store.get('transactions', 7)).matCode, 'A-1');
    assert.deepEqual((await store.get('syncMeta', 'migration-v1')).value, { done: true });
    await store.close();
  });
}

test('store：未打开不能写；IndexedDB 不可用必须显式报错', async () => {
  const s = Store.createMemoryStore();
  await assert.rejects(() => s.put('outbox', { id: 'x' }), /未打开/);
  assert.throws(() => Store.createIndexedDbStore({ indexedDB: null }), /不支持 IndexedDB/);
});

test('store[memory]：iterate 分批回调，不一次性把整表读进内存', async () => {
  const s = Store.createMemoryStore(); await s.open();
  for (let i = 1; i <= 1200; i++) await s.put('transactions', { seq: i, matCode: 'A', delta: 1, ts: 't' + i });
  const sizes = [], seen = [];
  const total = await s.iterate('transactions', chunk => { sizes.push(chunk.length); chunk.forEach(r => seen.push(r.seq)); }, { chunk: 500 });
  assert.equal(total, 1200);
  assert.deepEqual(sizes, [500, 500, 200], '必须分批，实测 ' + JSON.stringify(sizes));
  assert.equal(seen.length, 1200);
  assert.equal(new Set(seen).size, 1200, '不能漏读或重复');
});

test('store[indexeddb]：iterate 走真实游标，1200 条分批读完', async () => {
  let make = null;
  try { const fidb = require('fake-indexeddb'); make = () => Store.createIndexedDbStore({ indexedDB: fidb.indexedDB, IDBKeyRange: fidb.IDBKeyRange, dbName: 'mes416-iter-' + Date.now() + '-' + Math.random() }); }
  catch (_) { return; }
  const s = make(); await s.open();
  for (let i = 1; i <= 1200; i++) await s.put('transactions', { seq: i, matCode: 'A', delta: 1, ts: 't' + i });
  const sizes = [], seen = [];
  const total = await s.iterate('transactions', chunk => { sizes.push(chunk.length); chunk.forEach(r => seen.push(r.seq)); }, { chunk: 500 });
  assert.equal(total, 1200);
  assert.deepEqual(sizes, [500, 500, 200]);
  assert.equal(new Set(seen).size, 1200);
  await s.close();
});
