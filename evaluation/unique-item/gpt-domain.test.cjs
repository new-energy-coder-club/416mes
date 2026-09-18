'use strict';
// Independent S1 domain probes. Does not claim UI/backend acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixture.json');
const oracle = require('./contract.cjs');
const candidate = require('../../.dev-lines/gpt6/lib/unique-items.js');
const fresh = () => structuredClone(fixture);
const actor = {id:'independent-test',roles:['operator']};
function issue(overrides={}) {return {schemaVersion:1,opId:'independent-issue',kind:'issue',itemCode:'I-A',source:{loc:'L-A',container:'C-A'},expected:{itemVersion:3,containerVersion:2},...overrides};}
test('GPT domain: confirmed and legacy positions match independent oracle',()=>{
 const s=fresh();for(const i of s.items){const got=candidate.currentPosition(s,i.code);const want=oracle.itemView(s,i.code);assert.equal(got.item.status,want.status);assert.equal(got.container?.code??null,want.container);assert.equal(got.location?.code??null,want.location);}
});
test('GPT domain: issue plans one physical item, leaves all state unchanged',()=>{
 const s=fresh(),before=JSON.stringify(s);const p=candidate.plan(s,issue(),actor);
 assert.equal(p.after.items.length,1);assert.equal(p.after.items[0].container,'');assert.equal(p.after.items[0].status,'out');assert.equal(p.after.items[0].version,4);assert.equal(JSON.stringify(s),before);
});
test('GPT domain: illegal source and stale item version rejected',()=>{
 assert.throws(()=>candidate.plan(fresh(),issue({source:{loc:'L-B',container:'C-B'},expected:{itemVersion:3,containerVersion:5}}),actor),{code:'SOURCE_MISMATCH'});
 assert.throws(()=>candidate.plan(fresh(),issue({expected:{itemVersion:2,containerVersion:2}}),actor),{code:'VERSION_CONFLICT'});
});
test('GPT domain: receive does not accept already in-stock item',()=>{
 assert.throws(()=>candidate.plan(fresh(),{schemaVersion:1,opId:'new',kind:'receive',itemCode:'I-A',target:{loc:'L-A',container:'C-A'},expected:{itemVersion:3,containerVersion:2}},actor),{code:'INVALID_TRANSITION'});
});
test('GPT domain: duplicate item identity and qty payload rejected',()=>{
 const s=fresh();s.items.push({...s.items[1]});assert.throws(()=>candidate.plan(s,issue(),actor),{code:'DUPLICATE_CODE'});
 assert.throws(()=>candidate.plan(fresh(),issue({qty:2}),actor),{code:'ITM_HAS_NO_QTY'});
});
test('GPT domain: move plan changes container only, not MAT or member item',()=>{
 const s=fresh(), before=JSON.stringify(s);const p=candidate.plan(s,{schemaVersion:1,opId:'move',kind:'moveContainer',containerCode:'C-A',source:{loc:'L-A'},target:{loc:'L-B'},expected:{containerVersion:2}},actor);
 assert.equal(p.after.containers[0].loc,'L-B');assert.equal(p.after.items,undefined);assert.equal(JSON.stringify(s),before);
});
test('GPT domain: ordinary item edit cannot carry controlled fields',()=>{
 assert.deepEqual(candidate.ordinaryFields('items',{...fixture.items[1],name:'renamed',loc:'BAD'}),{code:'I-A',name:'renamed',spec:'单件'});
 assert.throws(()=>candidate.ordinaryFields('itemOperations',{}),{code:'OPERATION_TABLE_READ_ONLY'});
});
