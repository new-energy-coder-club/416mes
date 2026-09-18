'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const P = require('../lib/item-persistence');
const U = require('../lib/unique-items');
const Store = require('../lib/store');
const F = require('fake-indexeddb');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
function fn(name, nextMarker) { const start = html.indexOf('async function ' + name + '('); return html.slice(start, html.indexOf(nextMarker, start)); }
test('actual page persistStateToIdb uses queued latest snapshot and preserves command/outbox', async t => {
  const store = Store.createIndexedDbStore({ indexedDB: new F.IDBFactory(), IDBKeyRange: F.IDBKeyRange, dbName: 'mes416-state' });
  await store.open(); t.after(() => store.close());
  const state = { __rev: 1, items: [{ code: 'I-P', status: 'pending' }], materials: [{ code: 'M', qty: 7 }], transactions: [], itemOperations: [{ code: 'op-old', phase: 'APPLIED' }] };
  const context = vm.createContext({ state, localStore: store, stateSaveQueue: P.createQueue(), itmReadOnlyTab: false, _cpBuiltFor: 0, _idbPending: true,
    IDB_STATE_KEY: 'state-v1', LS_DIRTY_KEY: 'dirty', localStorage: { removeItem() {} }, CHECKPOINT: { build() { return { checkpoints: [] }; } } });
  vm.runInContext(fn('persistStateToIdb', '/* 工单数据归一化'), context);
  await store.put('outbox', { id: 'stable', op: 'itemOperation', request: { opId: 'stable' } });
  await store.put('syncMeta', { key: 'itmDraft:s', value: { rowId: 'r' } });
  const save = context.persistStateToIdb(); state.items[0].name = 'latest'; await save;
  assert.equal((await store.get('syncMeta', 'state-v1')).value.items[0].name, 'latest');
  assert.ok(await store.get('outbox', 'stable')); assert.ok(await store.get('syncMeta', 'itmDraft:s'));
  assert.ok(await store.get('records', ['itemOperations', 'op-old']));
});
test('actual page full and incremental merge entry points invoke same controlled policy', () => {
  const sync = require('../lib/item-sync');
  for (const name of ['fsMerge', 'fsThreeWayApply']) assert.match(html.slice(html.indexOf('function ' + name + '('), html.indexOf('function ' + name + '(') + 550), /window\.ItemSync\.merge/);
  const context = vm.createContext({ window: { UniqueItems: U, ItemSync: sync }, state: { items: [{ code: 'I', status: 'in_stock', container: 'C', version: 1, lastOpId: 'old' }], itemOperations: [] },
    TABLE_KEY_FIELD: { items: 'code' }, fsMergeBase: () => null, TWM: { planMerge(b, l, r) { return { writes: [], conflicts: [], degraded: false }; }, applyMerge() { return { applied: 0 }; } } });
  const start = html.indexOf('function fsThreeWayApply('), end = html.indexOf('/** 冲突池', start);
  vm.runInContext(html.slice(start, end), context);
  context.fsThreeWayApply('items', [{ code: 'I', status: 'out', container: '', version: 2, lastOpId: 'unproven' }]);
  assert.equal(context.state.items[0].container, 'C'); assert.ok(context.state.__itmConflicts['items:I']);
});
