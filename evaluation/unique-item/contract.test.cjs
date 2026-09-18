'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixture.json');
const { itemView, containerView, locationView, oldMaterialFingerprint } = require('./contract.cjs');
const fresh = () => structuredClone(fixture);
test('oracle: item/container/location give the same confirmed relationship', () => {
  const s = fresh();
  assert.deepEqual(itemView(s, 'I-A'), { code:'I-A', status:'in_stock', container:'C-A', location:'L-A' });
  assert.deepEqual(containerView(s, 'C-A'), { code:'C-A', location:'L-A', items:['I-A'] });
  assert.deepEqual(locationView(s, 'L-A'), { code:'L-A', containers:['C-A','C-X'], items:['I-A'] });
});
test('oracle: legacy/out/pending records do not invent current location', () => {
  const s = fresh();
  assert.equal(itemView(s, 'I-U').status, 'unknown');
  for (const code of ['I-U','I-O','I-P','I-R']) assert.equal(itemView(s, code).location, null);
});
test('oracle: whole container move derives new location without changing MAT', () => {
  const s = fresh(), before = oldMaterialFingerprint(s);
  s.containers.find(c=>c.code==='C-A').loc = 'L-B';
  assert.equal(itemView(s,'I-A').location, 'L-B');
  assert.deepEqual(locationView(s,'L-B').items,['I-A','I-B']);
  assert.equal(oldMaterialFingerprint(s),before);
});
test('oracle: conflicting duplicate codes fail rather than pick first', () => {
  const s = fresh(); s.items.push({...s.items[1]});
  assert.throws(()=>itemView(s,'I-A'),/DUPLICATE_ITEM/);
});
test('oracle: leading zero identifiers remain distinct', () => {
  const s = fresh();
  assert.equal(itemView(s,'001').code,'001');
  assert.equal(itemView(s,'1').code,'1');
});
test('oracle: queries are side-effect free', () => {
  const s = fresh(), before = JSON.stringify(s);
  itemView(s,'I-A');containerView(s,'C-A');locationView(s,'L-A');
  assert.equal(JSON.stringify(s),before);
});
