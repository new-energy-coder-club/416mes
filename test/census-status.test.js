'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/census-status');

test('按表合并：轮询 B 不得清掉 A 的待人工项', () => {
  let s = C.mergeStatus({}, 'materials', { complete: true, scanned: 4, total: 4, pendingKeys: ['A'], reason: 'needs-human', lastCheckedAt: 1 });
  s = C.mergeStatus(s, 'members', { complete: true, scanned: 2, total: 2, pendingKeys: [], lastCheckedAt: 2 });
  const p = C.pendingFromStatus(s);
  assert.deepEqual(p.materials.keys, ['A']);
  assert.ok(!p.members);
});

test('失败/不完整保留该表旧 pending；完整无缺才清该表', () => {
  let s = C.mergeStatus({}, 'materials', { complete: true, pendingKeys: ['A'], reason: 'needs-human', lastCheckedAt: 1 });
  s = C.mergeStatus(s, 'materials', { complete: false, scanned: 2, total: 4, error: '', lastCheckedAt: 2 });
  assert.deepEqual(C.pendingFromStatus(s).materials.keys, ['A']);
  s = C.mergeStatus(s, 'materials', { complete: false, error: 'network', lastCheckedAt: 3 });
  assert.deepEqual(C.pendingFromStatus(s).materials.keys, ['A']);
  s = C.mergeStatus(s, 'materials', { complete: true, scanned: 4, total: 4, pendingKeys: [], lastCheckedAt: 4 });
  assert.ok(!C.pendingFromStatus(s).materials);
});

test('状态可序列化恢复完整性、空键与时间', () => {
  let s = C.mergeStatus({}, 'locations', { complete: true, scanned: 10, total: 10, blankKeys: 2, pendingKeys: ['L1'], lastCheckedAt: 123 });
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(restored.tables.locations.blankKeys, 2);
  assert.equal(restored.tables.locations.lastCheckedAt, 123);
  assert.deepEqual(C.pendingFromStatus(restored).locations.keys, ['L1']);
});
