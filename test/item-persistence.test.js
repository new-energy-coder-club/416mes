'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('fake-indexeddb');
const Store = require('../lib/store');
const P = require('../lib/item-persistence');
async function setup(t) {
  const store = Store.createIndexedDbStore({ indexedDB: new F.IDBFactory(), IDBKeyRange: F.IDBKeyRange, dbName: 'mes416-state' });
  await store.open(); t.after(() => store.close());
  let state = { items: [{ code: 'I-P', status: 'pending', container: '', version: 0, lastOpId: '' }], itemOperations: [], materials: [{ code: 'M-KEEP', qty: 7 }], transactions: [] };
  const queue = P.createQueue();
  const client = P.create({ store, queue, canWrite: () => true, getState: () => state, publish: s => { state = s; } });
  return { store, queue, client, state: () => state };
}
const req = () => ({ schemaVersion: 1, opId: 'stable-1', kind: 'receive', itemCode: 'I-P', target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 2 } });
test('IDB command/state/draft atomic, stable identity, no optimistic relation', async t => {
  const f = await setup(t); const request = req();
  await f.client.enqueue(request, 'session-1', { rowId: 'row-1' }); request.kind = 'issue';
  assert.equal((await f.store.getAll('outbox')).length, 1);
  assert.equal((await f.store.get('syncMeta', 'state-v1')).value.__itmPending['stable-1'].request.kind, 'receive');
  assert.equal(f.state().items[0].status, 'pending');
  await f.client.enqueue(req(), 'session-1', {}); assert.equal((await f.store.getAll('outbox')).length, 1);
  await assert.rejects(f.client.enqueue({ ...req(), kind: 'issue' }), /OP_ID_PAYLOAD_CONFLICT/);
  assert.equal((await f.store.get('syncMeta', 'itmDraft:session-1')).value.locked, true);
});
test('IDB failure rolls back command and snapshot, publishes no success', async t => {
  const f = await setup(t); const original = f.store.transaction.bind(f.store);
  f.store.transaction = (names, work) => original(names, async tx => {
    const put = tx.put; tx.put = async (name, value) => { if (name === 'syncMeta' && value.key === 'state-v1') throw new Error('injected IDB failure'); return put(name, value); };
    return work(tx);
  });
  await assert.rejects(f.client.enqueue(req(), 'session-1', {}), /injected/);
  f.store.transaction = original;
  assert.equal((await f.store.getAll('outbox')).length, 0);
  assert.equal(await f.store.get('syncMeta', 'itmDraft:session-1'), undefined);
  assert.equal(f.state().__itmPending, undefined);
});
test('save queue takes newest state; replaceAll preserves operations and draft namespace', async t => {
  const f = await setup(t); await f.client.saveDraft('s', { loc: 'L-A' });
  const a = f.client.enqueue(req());
  const b = f.queue.run(async () => f.store.transaction(['records', 'transactions', 'syncMeta'], tx => P.writeSnapshot(tx, f.state())));
  await Promise.all([a, b]);
  assert.ok((await f.store.get('syncMeta', 'state-v1')).value.__itmPending['stable-1']);
  assert.equal((await f.store.get('syncMeta', 'itmDraft:s')).value.loc, 'L-A');
  f.state().itemOperations.push({ code: 'old-op', phase: 'APPLIED' });
  await f.store.transaction(['records', 'transactions', 'syncMeta'], tx => P.writeSnapshot(tx, f.state()));
  assert.equal((await f.store.get('records', ['itemOperations', 'old-op'])).value.phase, 'APPLIED');
});
test('LS dirty cannot erase IDB command or resurrect pre-issue container', async t => {
  const f = await setup(t); await f.client.enqueue(req());
  const ls = structuredClone(f.state()); ls.items[0].container = 'C-OLD'; ls.items[0].status = 'in_stock'; delete ls.__itmPending;
  const restored = P.restore(ls, f.state(), true, await f.store.getAll('outbox'));
  assert.equal(restored.items[0].container, ''); assert.equal(restored.items[0].status, 'pending');
  assert.ok(restored.__itmPending['stable-1']);
  assert.equal((await f.client.recover()).commands.length, 1);
});
test('unknown results retain command; final receipt atomically updates and removes', async t => {
  const f = await setup(t); await f.client.enqueue(req());
  await f.client.markUnknown('stable-1', 'timeout');
  assert.equal((await f.store.get('outbox', 'stable-1')).status, 'needs_attention');
  await assert.rejects(f.client.acknowledge({ code: 'stable-1', phase: 'PREPARED' }), /RESULT_NOT_FINAL/);
  await f.client.acknowledge({ code: 'stable-1', request: req(), phase: 'APPLIED', before: { items: [{ code: 'I-P', container: '', status: 'pending', version: 0, lastOpId: '' }] }, after: { items: [{ code: 'I-P', container: 'C-A', status: 'in_stock', version: 1, lastOpId: 'stable-1' }] } });
  assert.equal(await f.store.get('outbox', 'stable-1'), undefined);
  assert.equal(f.state().items[0].status, 'in_stock'); assert.equal(f.state().materials[0].qty, 7);
  assert.equal((await f.store.get('records', ['itemOperations', 'stable-1'])).value.phase, 'APPLIED');
});
test('late ACK cannot roll back a newer proven snapshot; same-version conflict retains command', async t => {
  const f = await setup(t); await f.client.enqueue(req());
  const newer = { code: 'I-P', container: 'C-B', status: 'in_stock', version: 5, lastOpId: 'newer-op' };
  Object.assign(f.state().items[0], newer);
  const old = { code: 'stable-1', request: req(), phase: 'APPLIED', after: { items: [{ code: 'I-P', container: '', status: 'out', version: 4, lastOpId: 'stable-1' }] } };
  await assert.rejects(f.client.acknowledge(old), /CURRENT_SNAPSHOT_UNVERIFIED/);
  f.state().itemOperations.push({ code: 'newer-op', phase: 'APPLIED', after: { items: [newer] } });
  await f.client.acknowledge(old);
  assert.equal(f.state().items[0].version, 5); assert.equal(f.state().items[0].container, 'C-B');
  assert.equal(await f.store.get('outbox', 'stable-1'), undefined);
  assert.ok(f.state().itemOperations.some(o => o.code === 'stable-1'));
  const nextReq = { ...req(), opId: 'same-v' }; await f.client.enqueue(nextReq);
  await assert.rejects(f.client.acknowledge({ code: 'same-v', request: nextReq, phase: 'APPLIED', after: { items: [{ ...newer, container: '', lastOpId: 'same-v' }] } }), /SAME_VERSION_CONFLICT/);
  assert.ok(await f.store.get('outbox', 'same-v'));
});
test('two tabs share lifecycle lock; second cannot become a writer until release', async () => {
  let busy = false;
  const locks = { async request(name, options, callback) { if (busy) return callback(null); busy = true; try { return await callback({ name }); } finally { busy = false; } } };
  const a = await P.acquireTab(locks); const b = await P.acquireTab(locks);
  assert.equal(a.acquired, true); assert.equal(b.acquired, false);
  a.release(); await new Promise(resolve => setImmediate(resolve));
  const c = await P.acquireTab(locks); assert.equal(c.acquired, true); c.release();
});
test('outbox projection reports ITM intent without altering confirmed fields or MAT', () => {
  const O = require('../lib/outbox'); const state = { items: [{ code: 'I-P', status: 'pending', container: '' }], materials: [{ code: 'M', qty: 7 }] };
  const result = O.project(state, [{ id: 'stable-1', op: 'itemOperation', request: req() }]);
  assert.equal(result.view.items[0].status, 'pending'); assert.equal(result.view.materials[0].qty, 7);
  assert.deepEqual(result.pending.items, ['I-P']); assert.equal(result.itemIntents.length, 1);
});
test('lack of browser lock or real IDB disables command persistence', async t => {
  const f = await setup(t);
  const denied = P.create({ store: f.store, getState: f.state, publish() {}, canWrite: () => false });
  await assert.rejects(denied.enqueue(req()), /SINGLE_WRITER_TAB/);
  assert.equal((await P.acquireTab(null)).acquired, false);
  const memory = P.create({ store: { kind: 'memory' }, getState: f.state, publish() {}, canWrite: () => true });
  await assert.rejects(memory.enqueue(req()), /INDEXEDDB/);
});

/* ================= A 阶段：acknowledge 放宽服务端回填码（P4） ================= */

test('registerItem 无码命令：服务端回填码后 ACK 放宽通过并落本地', async t => {
  const f = await setup(t);
  const request = { schemaVersion: 1, opId: 'reg-auto', kind: 'registerItem', entity: { category: 'TS', name: '示波器' } };
  await f.client.enqueue(request);
  const applied = {
    code: 'reg-auto', kind: 'registerItem', phase: 'APPLIED',
    request: { schemaVersion: 1, opId: 'reg-auto', kind: 'registerItem', entity: { category: 'TS', name: '示波器', code: 'WP-TS-001' } },
    before: { items: [] },
    after: { items: [{ code: 'WP-TS-001', name: '示波器', container: '', status: 'pending', version: 1, lastOpId: 'reg-auto' }] }
  };
  await f.client.acknowledge(applied);
  assert.equal(await f.store.get('outbox', 'reg-auto'), undefined);
  const row = f.state().items.find(i => i.code === 'WP-TS-001');
  assert.ok(row, '回填码物品落本地'); assert.equal(row.status, 'pending');
  assert.equal((await f.store.get('records', ['itemOperations', 'reg-auto'])).value.phase, 'APPLIED');
});
test('registerItem 无码命令：回填码与 after 不一致或请求被篡改仍拒收', async t => {
  const f = await setup(t);
  const request = { schemaVersion: 1, opId: 'reg-auto', kind: 'registerItem', entity: { category: 'TS', name: '示波器' } };
  await f.client.enqueue(request);
  const base = { code: 'reg-auto', kind: 'registerItem', phase: 'APPLIED', before: { items: [] },
    request: { schemaVersion: 1, opId: 'reg-auto', kind: 'registerItem', entity: { category: 'TS', name: '示波器', code: 'WP-TS-001' } } };
  // 回填码 !== after.items[0].code
  await assert.rejects(f.client.acknowledge({ ...base, after: { items: [{ code: 'WP-TS-002', name: '示波器', container: '', status: 'pending', version: 1, lastOpId: 'reg-auto' }] } }), /RESULT_REQUEST_MISMATCH/);
  // 缺 after
  await assert.rejects(f.client.acknowledge(base), /RESULT_REQUEST_MISMATCH/);
  // 请求其余字段被篡改（名称不同）——放宽仅限 entity.code
  const tampered = structuredClone(base);
  tampered.request.entity.name = '万用表';
  tampered.after = { items: [{ code: 'WP-TS-001', name: '万用表', container: '', status: 'pending', version: 1, lastOpId: 'reg-auto' }] };
  await assert.rejects(f.client.acknowledge(tampered), /RESULT_REQUEST_MISMATCH/);
  // 非 register 命令不享受放宽
  const recv = { schemaVersion: 1, opId: 'recv-1', kind: 'receive', itemCode: 'I-P', target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 2 } };
  await f.client.enqueue(recv);
  await assert.rejects(f.client.acknowledge({ code: 'recv-1', kind: 'receive', phase: 'APPLIED', request: { ...recv, itemCode: 'I-OTHER' }, after: { items: [] } }), /RESULT_REQUEST_MISMATCH/);
  // 三次失败不影响合法 ACK 后续落库
  await f.client.acknowledge({ ...base, after: { items: [{ code: 'WP-TS-001', name: '示波器', container: '', status: 'pending', version: 1, lastOpId: 'reg-auto' }] } });
  assert.ok(f.state().items.some(i => i.code === 'WP-TS-001'));
});
test('registerItem 无码命令 REJECTED（发号后 plan 拒）也能 ACK 出队', async t => {
  const f = await setup(t);
  const request = { schemaVersion: 1, opId: 'reg-rej', kind: 'registerItem', entity: { category: 'TS', name: 'x' } };
  await f.client.enqueue(request);
  await f.client.acknowledge({ code: 'reg-rej', kind: 'registerItem', phase: 'REJECTED', error: 'CODE_ALREADY_REGISTERED',
    request: { schemaVersion: 1, opId: 'reg-rej', kind: 'registerItem', entity: { category: 'TS', name: 'x', code: 'WP-TS-001' } } });
  assert.equal(await f.store.get('outbox', 'reg-rej'), undefined);
  assert.equal(f.state().items.some(i => i.code === 'WP-TS-001'), false, 'REJECTED 不落物品');
});

/* ================= 2.48.0：APPLIED ACK 解除「未核验变更」冲突（现场核实即凭据） ================= */
test('acknowledge of APPLIED activateLocation clears unverified-controlled-change conflict', async t => {
  const f = await setup(t);
  const state = f.state();
  // 本地 unknown + 冲突（云端 active 但无凭据的历史现场）
  state.locations = [{ code: 'L-A', status: 'unknown' }];
  state.__itmConflicts = { 'locations:L-A': { table: 'locations', key: 'L-A', reason: 'unverified-controlled-change', local: { code: 'L-A', status: 'unknown' }, observed: { code: 'L-A', status: 'active' } } };
  const activate = { schemaVersion: 1, opId: 'act-1', kind: 'activateLocation', locationCode: 'L-A', expected: { locationStatus: 'unknown' } };
  await f.client.enqueue(activate);
  await f.client.acknowledge({ code: 'act-1', request: activate, phase: 'APPLIED', before: { locations: [{ code: 'L-A', status: 'unknown' }] }, after: { locations: [{ code: 'L-A', status: 'active' }] } });
  const next = f.state();
  assert.equal(next.locations[0].status, 'active', 'ACK 应用启用结果');
  assert.equal(next.__itmConflicts['locations:L-A'], undefined, '冲突随凭据落地而解除');
  assert.equal(next.itemOperations.at(-1).phase, 'APPLIED', '操作日志保留，作为后续同步合并的凭据');
});
