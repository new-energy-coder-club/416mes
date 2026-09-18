'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./fixture.json');const S=require('../../.dev-lines/gpt6/lib/item-sync.js');
test('GPT sync: missing location status column does not reset confirmed active to unknown',()=>{
 const state=structuredClone(fixture);
 state.itemOperations=[{code:'activate-a',kind:'activateLocation',phase:'APPLIED',after:{locations:[{code:'L-A',status:'active'}]}}];
 S.merge(state,{locations:[{code:'L-A',desc:'ordinary edit from old schema'}]});
 assert.equal(state.locations.find(x=>x.code==='L-A').status,'active');
});
test('GPT sync: APPLIED proof alone cannot validate dangling container relation',()=>{
 const state=structuredClone(fixture);
 const incoming={...state.items[1],container:'MISSING-CTN',version:4,lastOpId:'dangling-op'};
 const remote={items:[incoming],itemOperations:[{code:'dangling-op',phase:'APPLIED',after:{items:[incoming]}}]};
 const result=S.merge(state,remote);
 assert.equal(state.items.find(x=>x.code==='I-A').container,'C-A','accepted item pointing at nonexistent container');
 assert.ok(result.conflicts.length>0);
});
test('GPT sync: older locator proof cannot silently roll active location back',()=>{
 const state=structuredClone(fixture);
 // Without an explicit revision/order contract, a proof is not a valid current-authority marker.
 state.itemOperations=[{code:'old-disable',phase:'APPLIED',after:{locations:[{code:'L-A',status:'disabled'}]}},{code:'new-enable',phase:'APPLIED',after:{locations:[{code:'L-A',status:'active'}]}}];
 const before=state.locations.find(x=>x.code==='L-A').status;
 const result=S.merge(state,{locations:[{code:'L-A',status:'disabled'}]});
 assert.ok(result.conflicts.length>0 || state.locations.find(x=>x.code==='L-A').status===before,'unversioned locator proof must not silently be treated as current authority');
});
