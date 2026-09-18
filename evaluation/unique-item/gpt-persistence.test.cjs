'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {indexedDB,IDBKeyRange}=require('fake-indexeddb');
const Store=require('../../.dev-lines/gpt6/lib/store.js');
const P=require('../../.dev-lines/gpt6/lib/item-persistence.js');
const fixture=require('./fixture.json');
test('GPT persistence: stale acknowledgement cannot roll back newer confirmed version',async()=>{
 const store=Store.createIndexedDbStore({dbName:'independent-stale-ack-'+Date.now(),indexedDB,IDBKeyRange});await store.open();
 let state=structuredClone(fixture);const p=P.create({store,getState:()=>state,publish:s=>{state=s;},canWrite:()=>true});
 const request={schemaVersion:1,opId:'old-op',kind:'issue',itemCode:'I-A',expected:{itemVersion:3,containerVersion:2},source:{loc:'L-A',container:'C-A'}};
 try{
 await p.enqueue(request,'row1',{});
 const item=state.items.find(i=>i.code==='I-A');Object.assign(item,{version:5,lastOpId:'newer-op',status:'in_stock',container:'C-B'});
 const response={code:'old-op',phase:'APPLIED',request,after:{items:[{code:'I-A',version:4,lastOpId:'old-op',status:'out',container:''}]}};
 try{await p.acknowledge(response);}catch(e){assert.ok(e);}
 const current=state.items.find(i=>i.code==='I-A');assert.equal(current.version,5,'late ACK overwrote newer version');assert.equal(current.container,'C-B');
 }finally{await store.close();}
});
test('GPT persistence: proven newer snapshot permits old command cleanup without rollback',async()=>{
 const store=Store.createIndexedDbStore({dbName:'independent-proven-ack-'+Date.now(),indexedDB,IDBKeyRange});await store.open();
 let state=structuredClone(fixture);const p=P.create({store,getState:()=>state,publish:s=>{state=s;},canWrite:()=>true});
 const request={schemaVersion:1,opId:'old-op',kind:'issue',itemCode:'I-A',expected:{itemVersion:3,containerVersion:2},source:{loc:'L-A',container:'C-A'}};
 try{
 await p.enqueue(request,'row1',{});
 const newer={code:'I-A',version:5,lastOpId:'newer-op',status:'in_stock',container:'C-B'};
 Object.assign(state.items.find(i=>i.code==='I-A'),newer);
 state.itemOperations.push({code:'newer-op',phase:'APPLIED',after:{items:[newer]}});
 await p.acknowledge({code:'old-op',phase:'APPLIED',request,after:{items:[{code:'I-A',version:4,lastOpId:'old-op',status:'out',container:''}]}});
 assert.equal(state.items.find(i=>i.code==='I-A').version,5);
 assert.equal(await store.get('outbox','old-op'),undefined);
 assert.ok(state.itemOperations.some(o=>o.code==='old-op'));
 }finally{await store.close();}
});
