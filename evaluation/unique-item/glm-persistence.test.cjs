'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Store=require('../../.dev-lines/glm53/lib/store'),I=require('../../.dev-lines/glm53/lib/item-store');
const fixture=require('./fixture.json');
test('GLM confirm: late failure must not mutate caller state outside aborted IDB transaction',async()=>{
 const store=Store.createMemoryStore();await store.open();await store.put('outbox',{id:'cmd',op:'itemOperation',opId:'cmd',requestHash:'same'});
 const state=structuredClone(fixture),before=JSON.stringify(state);
 const broken={transaction(names,fn){return store.transaction(names,tx=>fn({...tx,put:async(name,value,key)=>{if(name==='syncMeta'&&value.key==='state-v1')throw Error('injected final persistence failure');return tx.put(name,value,key);}}));}};
 const result=await I.confirmResult({store:broken,opId:'cmd',requestHash:'same',state,applied:{operation:{code:'cmd',phase:'APPLIED',requestHash:'same'},entities:{items:{code:'I-A',status:'out',container:'',version:4,lastOpId:'cmd'}}}});
 assert.equal(result.ok,false);assert.ok(await store.get('outbox','cmd'));assert.equal(JSON.stringify(state),before,'external state changed despite persistence rollback');await store.close();
});
test('GLM log merge: phase advancement must not accept changed immutable payload hash',()=>{
 const r=I.mergeOpsCache([{code:'cmd',phase:'PREPARED',requestHash:'original'}],[{code:'cmd',phase:'APPLIED',requestHash:'different'}]);
 assert.ok(r.conflicts.length>0,'PREPARED to APPLIED bypassed payload identity check');
});
