'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/unique-items');
const S = require('../lib/item-schema');
const api = require('../lib/feishu-api');
function fixture() {
  return { locations: [{ code: 'L-A', status: 'active' }, { code: 'L-B', status: 'active' }, { code: 'L-X', status: 'disabled' }],
    containers: [{ code: 'C-A', status: 'active', loc: 'L-A', version: 2 }, { code: 'C-B', status: 'active', loc: 'L-B', version: 5 }],
    items: [{ code: 'I-P', status: 'pending', version: 0 }, { code: 'I-A', status: 'in_stock', container: 'C-A', version: 3 }, { code: 'I-U', loc: 'L-A' }],
    materials: [{ code: 'M-KEEP', qty: 7 }], transactions: [{ seq: 1, matCode: 'M-KEEP', delta: 7, balance: 7 }] };
}
const actor = { id: 'fake-user', roles: ['operator'] };
function receive() { return { schemaVersion: 1, opId: 'op-1', kind: 'receive', itemCode: 'I-P', target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 2 } }; }
test('ITM migration is unknown, never stock; MAT and ledger untouched', () => {
  const st = fixture(), mat = structuredClone(st.materials), tx = structuredClone(st.transactions);
  U.migrate(st); assert.equal(st.items[2].status, 'unknown'); assert.equal(st.items[2].container, '');
  assert.equal(st.items[2].version, 0); assert.deepEqual(st.materials, mat); assert.deepEqual(st.transactions, tx);
  assert.equal(U.currentPosition(st, 'I-U').legacy, true);
  assert.equal(U.currentPosition(st, 'I-A').location.code, 'L-A');
});
test('ITM receive plan is immutable intent, qty absent, no MAT accounting', () => {
  const st = fixture(), before = structuredClone(st), req = receive();
  const p = U.plan(st, req, actor);
  assert.deepEqual(p.after.items[0], { code: 'I-P', container: 'C-A', status: 'in_stock', version: 1, lastOpId: 'op-1' });
  assert.deepEqual(st, before); req.target.loc = 'changed'; assert.equal(p.request.target.loc, 'L-A');
  assert.throws(() => U.plan(st, { ...receive(), qty: 1 }, actor), { code: 'ITM_HAS_NO_QTY' });
});
test('ITM illegal states, relationships, disabled location and stale versions fail', () => {
  for (const status of ['unknown', 'in_stock', 'retired', 'bad']) {
    const st = fixture(); st.items[0].status = status;
    assert.throws(() => U.plan(st, receive(), actor));
  }
  const st = fixture(); const req = receive(); req.target.container = 'C-B'; req.expected.containerVersion = 5;
  assert.throws(() => U.plan(st, req, actor), { code: 'CONTAINER_LOCATION_MISMATCH' });
  st.locations[0].status = 'disabled'; assert.throws(() => U.plan(st, receive(), actor), { code: 'INACTIVE_ENTITY' });
  assert.throws(() => U.plan(fixture(), { ...receive(), expected: { itemVersion: 1 } }, actor), { code: 'VERSION_CONFLICT' });
});
test('ITM issue explicitly clears container; wrong source denied', () => {
  const req = { schemaVersion: 1, opId: 'issue-1', kind: 'issue', itemCode: 'I-A', source: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 3, containerVersion: 2 } };
  const p = U.plan(fixture(), req, actor); assert.equal(p.after.items[0].container, ''); assert.equal(p.after.items[0].status, 'out');
  req.source = { loc: 'L-B', container: 'C-B' }; req.expected.containerVersion = 5;
  assert.throws(() => U.plan(fixture(), req, actor), { code: 'SOURCE_MISMATCH' });
});
test('ITM transfer and container move preserve unique identities and derived location', () => {
  const st = fixture();
  const move = U.plan(st, { schemaVersion: 1, opId: 'move-1', kind: 'moveContainer', containerCode: 'C-A', source: { loc: 'L-A' }, target: { loc: 'L-B' }, expected: { containerVersion: 2 } }, actor);
  Object.assign(st.containers[0], move.after.containers[0]);
  assert.equal(U.currentPosition(st, 'I-A').location.code, 'L-B'); assert.equal(st.items[1].version, 3); assert.equal(st.materials[0].qty, 7);
  const p = U.plan(fixture(), { schemaVersion: 1, opId: 'transfer-1', kind: 'transfer', itemCode: 'I-A', source: { loc: 'L-A', container: 'C-A' }, target: { loc: 'L-B', container: 'C-B' }, expected: { itemVersion: 3, containerVersion: 2, targetContainerVersion: 5 } }, actor);
  assert.equal(p.after.items[0].container, 'C-B');
});
test('ITM legacy verification and retirement require admin, retired cannot return', () => {
  const req = { ...receive(), kind: 'verifyLegacy', itemCode: 'I-U' };
  assert.throws(() => U.plan(fixture(), req, actor), { code: 'FORBIDDEN' });
  assert.equal(U.plan(fixture(), req, { id: 'admin', roles: ['admin'] }).after.items[0].status, 'in_stock');
  assert.throws(() => U.plan(fixture(), receive(), null), { code: 'FORBIDDEN' });
});
test('ITM duplicates fail instead of picking first; string codes preserve leading zero', () => {
  const st = fixture(); st.items.push({ ...st.items[1] });
  assert.throws(() => U.currentPosition(st, 'I-A'), { code: 'DUPLICATE_CODE' });
  st.items.push({ code: '001' }, { code: '1' });
  assert.equal(U.unique(st, 'items', '001').code, '001'); assert.equal(U.unique(st, 'items', '1').code, '1');
});
test('ITM ordinary fields never include controlled stale snapshot', () => {
  assert.deepEqual(U.ordinaryFields('items', { code: 'I-A', name: 'new', loc: 'old', container: 'C-X', version: 8, lastOpId: 'bad', status: 'out', qty: 99 }), { code: 'I-A', name: 'new' });
  assert.throws(() => U.ordinaryFields('itemOperations', {}));
});
test('nine-table mapping roundtrip preserves operation JSON, clear relation, timestamps and code', () => {
  const it = { code: '001', name: 'same', spec: 'x', loc: '', container: '', status: 'out', version: 4, lastOpId: 'op-1', materialCode: 'M-KEEP' };
  assert.deepEqual(api.TABLE_DEFS.items.down(api.TABLE_DEFS.items.up(it)), it);
  const p = { code: 'op-1', kind: 'issue', itemCode: '001', containerCode: 'C-A', request: receive(), requestHash: 'fake-hash', before: { items: [] }, after: { items: [{ container: '' }] }, phase: 'APPLIED', progress: { done: true }, operator: 'fake-user', device: 'fake-device', requestedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', error: '' };
  assert.deepEqual(api.TABLE_DEFS.itemOperations.down(api.TABLE_DEFS.itemOperations.up(p)), p);
  assert.equal(api.TABLE_DEFS.items.down({ '物品码': 'old' }).status, 'unknown');
  assert.ok(!Object.hasOwn(api.mapDown(api.TABLE_DEFS.items, { '物品码': 'old' }, new Set(['物品码'])), 'container'));
});
test('nine-table permissions split: operations readable, generic write/delete rejected before network', async () => {
  assert.ok(api.READ_TABLES.includes('itemOperations')); assert.ok(!api.GENERIC_WRITE_TABLES.includes('itemOperations'));
  assert.ok(api.APPEND_PROTECTED_TABLES.includes('itemOperations'));
  assert.ok((await api.upsertRecords('itemOperations', [{}])).error);
  assert.ok((await api.deleteRecords('itemOperations', ['op-1'])).error);
});
test('admin can bootstrap legacy LOC then CTN then ITM through auditable plans', () => {
  const st = { locations: [{ code: 'L-A' }], containers: [{ code: 'C-A', loc: 'L-A' }], items: [{ code: 'I-U', loc: 'L-A' }] };
  U.migrate(st);
  const admin = { id: 'fake-admin', roles: ['admin'] };
  const locReq = { schemaVersion: 1, opId: 'activate-loc', kind: 'activateLocation', locationCode: 'L-A', expected: { locationStatus: 'unknown' } };
  assert.throws(() => U.plan(st, locReq, actor), { code: 'FORBIDDEN' });
  Object.assign(st.locations[0], U.plan(st, locReq, admin).after.locations[0]);
  const cp = U.plan(st, { schemaVersion: 1, opId: 'activate-ctn', kind: 'activateContainer', containerCode: 'C-A', target: { loc: 'L-A' }, expected: { containerVersion: 0 } }, admin);
  Object.assign(st.containers[0], cp.after.containers[0]);
  const p = U.plan(st, { ...receive(), kind: 'verifyLegacy', itemCode: 'I-U', expected: { itemVersion: 0, containerVersion: 1 } }, admin);
  assert.equal(p.after.items[0].status, 'in_stock');
});
function schemaFixture() {
  return Object.fromEntries(Object.entries(S.REQUIREMENTS).map(([t, fields]) => [t, Object.entries(fields).map(([name, [type, options]]) => ({ name, type: Array.isArray(type) ? type[0] : type, options: options || [] }))]));
}
test('schema contract validates required fields, types and enums, never claims write permission', () => {
  const schemas = schemaFixture(), tables = Object.fromEntries(Object.keys(schemas).map(t => [t, 'fake-' + t]));
  assert.equal(S.validate(schemas, tables).schemaValid, true); assert.equal(S.validate(schemas, tables).writeEnabled, false);
  for (const name of ['容器码', '状态', '业务版本', '最后操作ID']) {
    const bad = structuredClone(schemas); bad.items = bad.items.filter(f => f.name !== name);
    assert.equal(S.validate(bad, tables).schemaValid, false);
  }
  const bad = structuredClone(schemas); bad.itemOperations = bad.itemOperations.filter(f => f.name !== '操作ID'); assert.equal(S.validate(bad, tables).schemaValid, false);
  schemas.items.find(f => f.name === '状态').options = ['pending']; assert.equal(S.validate(schemas, tables).schemaValid, false);
  schemas.items.find(f => f.name === '业务版本').type = 1; assert.ok(S.validate(schemas, tables).problems.some(p => p.reason === 'wrong-type'));
});
