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

/* ================= P3a（用户实测「库位已启用但显示未启用」）：增量自愈 revalidate ================= */
test('revalidate heals location activated-remotely but stuck unknown by T1/T2 race', () => {
  /* T1：轮询先拉到 locations 行（云端已 active），但 APPLIED 日志行（T2）还没拉到 →
     merge 挂 unverified-controlled-change，本地保持 unknown */
  const st = { locations: [{ code: 'L-A', status: 'unknown', desc: '现场' }], containers: [], items: [], itemOperations: [] };
  const r = S.merge(st, { locations: [{ code: 'L-A', status: 'active', desc: '现场' }] });
  assert.equal(st.locations[0].status, 'unknown', '无凭据时绝不采用');
  assert.ok(st.__itmConflicts['locations:L-A']);
  /* T2：APPLIED activateLocation 日志随后到达（locations 行不再变化、不会再被增量拉取） */
  S.merge(st, { itemOperations: [{ code: 'act-1', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } }] });
  const healed = S.revalidate(st);
  assert.deepEqual(healed, ['locations:L-A']);
  assert.equal(st.locations[0].status, 'active', '凭据到达后必须自愈');
  assert.equal(st.__itmConflicts['locations:L-A'], undefined, '冲突同步解除');
});
test('revalidate heals container/item via lastOpId-matched APPLIED log with version gate', () => {
  const st = { locations: [{ code: 'L-A', status: 'active' }], containers: [{ code: 'C-A', loc: 'L-A', status: 'active', version: 2, lastOpId: 'mv-1' }], items: [], itemOperations: [] };
  /* 容器行（T1，version 2 已在途）先到、被拒（日志未到）；日志（T2，after.version=3）后到 */
  const movedRow = { code: 'C-A', loc: 'L-B', status: 'active', version: 3, lastOpId: 'mv-2' };
  st.locations.push({ code: 'L-B', status: 'active' });
  S.merge(st, { containers: [movedRow] });
  assert.equal(st.containers[0].loc, 'L-A');
  assert.ok(st.__itmConflicts['containers:C-A']);
  S.merge(st, { itemOperations: [{ code: 'mv-2', kind: 'moveContainer', phase: 'APPLIED', after: { containers: [movedRow] } }] });
  const healed = S.revalidate(st);
  assert.ok(healed.includes('containers:C-A'));
  assert.equal(st.containers[0].loc, 'L-B', '按凭据落地');
  assert.equal(st.containers[0].version, 3);
  assert.equal(st.__itmConflicts['containers:C-A'], undefined);
});
test('revalidate refuses stale-log downgrade and dangling relations (same gates as merge)', () => {
  /* 旧日志（版本不高于本地）不得倒灌 */
  const st = { locations: [{ code: 'L-A', status: 'active' }], containers: [{ code: 'C-A', loc: 'L-A', status: 'active', version: 5, lastOpId: 'mv-1' }], items: [], itemOperations: [{ code: 'mv-1', kind: 'moveContainer', phase: 'APPLIED', after: { containers: [{ code: 'C-A', loc: 'L-B', status: 'active', version: 3, lastOpId: 'mv-1' }] } }] };
  assert.deepEqual(S.revalidate(st), []);
  assert.equal(st.containers[0].loc, 'L-A', '版本闸门：旧日志不落地');
  /* 关系闸门：目标容器不存在 → 不落地，冲突保留（fail-closed） */
  const st2 = { locations: [{ code: 'L-A', status: 'active' }], containers: [{ code: 'C-A', loc: 'L-A', status: 'active', version: 2, lastOpId: 'mv-1' }], items: [{ code: 'I-A', status: 'in_stock', container: 'C-A', version: 3, lastOpId: 'op-1' }], itemOperations: [{ code: 'op-1', kind: 'receive', phase: 'APPLIED', after: { items: [{ code: 'I-A', status: 'in_stock', container: 'C-MISSING', version: 4, lastOpId: 'op-1' }] } }] };
  const healed2 = S.revalidate(st2);
  assert.deepEqual(healed2, []);
  assert.equal(st2.items[0].container, 'C-A', '悬空关系绝不落地');
});
test('revalidate quarantined logs are not credentials (untrusted logs never heal)', () => {
  const st = { locations: [{ code: 'L-A', status: 'unknown' }], containers: [], items: [], itemOperations: [{ code: 'dup-1', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } }] };
  st.__itmConflicts = { 'itemOperations:dup-1': { reason: 'duplicate-operation' } };
  assert.deepEqual(S.revalidate(st), [], '被隔离的日志行不构成凭据');
  assert.equal(st.locations[0].status, 'unknown');
});
