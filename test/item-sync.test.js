'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../lib/item-sync');
const base = () => ({ items: [{ code: 'I-A', name: 'local', status: 'in_stock', container: 'C-A', version: 3, lastOpId: 'prior' }], itemOperations: [], materials: [{ code: 'M', qty: 7 }] });
function remote() {
  const row = { code: 'I-A', name: 'remote', container: '', status: 'out', version: 4, lastOpId: 'issue-1' };
  return { items: [row], itemOperations: [{ code: 'issue-1', phase: 'APPLIED', request: { kind: 'issue' }, requestHash: 'fake', operator: 'fake-user', before: {}, after: { items: [row] } }] };
}
test('full/incremental controlled groups preserve explicit clear and MAT', () => {
  const a = base(), b = base(), r = remote();
  S.merge(a, r); S.merge(b, { itemOperations: r.itemOperations }); S.merge(b, { items: r.items });
  assert.deepEqual(a, b); assert.equal(a.items[0].container, ''); assert.equal(a.materials[0].qty, 7);
});
test('external edits, partial groups and higher versions without proof are isolated', () => {
  for (const patch of [{ container: 'C-X' }, { container: 'C-X', version: 9 }, { status: 'out', container: '' }]) {
    const state = base(); const r = S.merge(state, { items: [{ ...state.items[0], ...patch }] });
    assert.equal(state.items[0].container, 'C-A'); assert.equal(r.conflicts.length, 1);
    assert.equal(r.ordinary.items[0].version, 3);
  }
  const st = base(); const p = S.merge(st, { items: [{ code: 'I-A', container: '' }] });
  assert.equal(p.conflicts[0].reason, 'incomplete-controlled-group');
});
test('same-version forged log cannot replace different confirmed relationship', () => {
  const st = base(), r = remote(); r.items[0].version = 3;
  S.merge(st, r); assert.equal(st.items[0].container, 'C-A'); assert.ok(st.__itmConflicts['items:I-A']);
});
test('operations are append cached; immutable payload changes and duplicates quarantined', () => {
  const st = base(), r = remote(); S.merge(st, r);
  S.merge(st, { itemOperations: [], completeness: { itemOperations: { complete: false } } });
  assert.equal(st.itemOperations.length, 1);
  const bad = structuredClone(r); bad.itemOperations[0].request.kind = 'receive';
  S.merge(st, bad); assert.equal(st.itemOperations[0].request.kind, 'issue');
  assert.ok(st.__itmConflicts['itemOperations:issue-1']);
  const duplicate = base(); S.merge(duplicate, { items: [r.items[0], r.items[0]] }); assert.equal(duplicate.items[0].version, 3);
});
test('APPLIED proof cannot introduce dangling or ambiguous container/location', () => {
  for (const containers of [[], [{ code: 'MISSING-CTN', loc: 'MISSING-LOC' }], [{ code: 'MISSING-CTN', loc: 'L' }, { code: 'MISSING-CTN', loc: 'L' }]]) {
    const st = base(), r = remote(); st.containers = containers; st.locations = [{ code: 'L' }];
    Object.assign(r.items[0], { status: 'in_stock', container: 'MISSING-CTN' });
    S.merge(st, r);
    assert.equal(st.items[0].container, 'C-A'); assert.ok(st.__itmConflicts['items:I-A']);
  }
});
test('unversioned LOC historical matching proof cannot silently disable active location', () => {
  const st = { locations: [{ code: 'L-A', status: 'active' }], itemOperations: [
    { code: 'a', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } },
    { code: 'd', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'disabled' }] } }
  ] };
  const result = S.merge(st, { locations: [{ code: 'L-A', status: 'disabled' }] });
  assert.equal(st.locations[0].status, 'active'); assert.ok(result.conflicts.length);
});
test('missing LOC status cannot erase confirmed active and late log resolves association on retry', () => {
  const st = base(); st.locations = [{ code: 'L-A', status: 'active' }];
  S.merge(st, { locations: [{ code: 'L-A', desc: 'ordinary edit' }] });
  assert.equal(st.locations[0].status, 'active');
  const r = remote(); S.merge(st, { items: r.items }); assert.ok(st.__itmConflicts['items:I-A']);
  S.merge(st, { itemOperations: r.itemOperations });
  S.merge(st, { items: r.items }); assert.equal(st.items[0].status, 'out'); assert.equal(st.__itmConflicts['items:I-A'], undefined);
});
test('legacy records are unknown, ordinary names remain available for existing merge', () => {
  const st = base(); const r = S.merge(st, { items: [{ code: 'legacy', name: 'old', loc: 'L-HISTORY' }] });
  assert.equal(st.items[1].status, 'unknown'); assert.equal(r.ordinary.items[0].name, 'old');
});

/* ================= 2.49.5：库位多次重确认不使凭据失效（审计 Bug1） ================= */
test('location proof survives multiple idempotent re-confirmations (dedupe by opId, >=1)', () => {
  const logs = [
    { code: 'op-1', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } },
    { code: 'op-2', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } },
  ];
  const row = { code: 'L-A', status: 'active' };
  assert.equal(S.proof('locations', row, logs), true, '两次启用后凭据必须仍成立（否则库位永久锁死）');
  assert.equal(S.proof('locations', row, [{ code: 'op-1', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } }, { code: 'op-1', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } }]), true, '同 opId 重复日志行按一次计');
  assert.equal(S.proof('locations', { code: 'L-B', status: 'unknown' }, logs), false, '非 active 永远无凭据');
});
