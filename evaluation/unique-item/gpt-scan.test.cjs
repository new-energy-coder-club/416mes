'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Scan=require('../../.dev-lines/gpt6/lib/item-scan.js');const fixture=require('./fixture.json');
function setup(){let n=0;const scan=Scan.create({getState:()=>structuredClone(fixture),id:()=>`probe-${++n}`});scan.add('receive');return scan;}
test('GPT scan: strict step order rejects ITM first',()=>{const s=setup();assert.throws(()=>s.accept('ITM:I-P'));assert.equal(s.row().values.length,0);});
test('GPT scan: asynchronous captured result cannot land after switching rows',()=>{const s=setup(),token=s.token();s.add('receive');assert.deepEqual(s.accept('LOC:L-A',token),{ignored:true});assert.equal(s.row().values.length,0);});
test('GPT scan: full flow keeps code identity and final row locked',()=>{const s=setup();s.accept('LOC:L-A');s.accept('CTN:C-A');s.accept('ITM:I-P');const q=s.lock();assert.equal(q.itemCode,'I-P');assert.equal(q.target.container,'C-A');assert.throws(()=>s.accept('ITM:I-B'));});
test('GPT scan: changed intent after persistence failure cannot reuse old opId',()=>{const s=setup();s.accept('LOC:L-A');s.accept('CTN:C-A');s.accept('ITM:I-P');const before=s.lock();s.unlock();s.reset(0);s.accept('LOC:L-B');s.accept('CTN:C-B');s.accept('ITM:I-P');const after=s.lock();assert.notEqual(after.opId,before.opId,'same opId now has different target container');});
