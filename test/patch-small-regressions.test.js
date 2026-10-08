'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
const Store = require('../lib/store');
const Persist = require('../lib/item-persistence');
const Core = require('../mes-core');
const Client = require('../lib/item-client');

function sample() {
 return { items: [], containers: [], locations: [], itemOperations: [], workorders: [], transactions: [], materials: [], members: [], manuals: [], necOrders: [] };
}
async function persistenceFixture() {
 const db=Store.createIndexedDbStore({indexedDB,IDBKeyRange,dbName:'small-patch-'+Math.random()});
 await db.open(); let state=sample();
 const p=Persist.create({store:db,getState:()=>state,publish:next=>state=next,canWrite:()=>true});
 return {p,db,getState:()=>state};
}
function req(id) {return {schemaVersion:1,kind:'issueBatch',opId:id,source:{},items:[{itemCode:id,expectedItemVersion:0,sub:true,locCode:'SUB'}]};}
test('补丁 S1：两组命令使用一个 IDB 事务；出现冲突时整组零落库',async()=>{
 const f=await persistenceFixture();
 await assert.rejects(f.p.enqueueBatch([req('P-1'),req('P-1')],'sess-1',{rows:[]}),/OP_ID_PAYLOAD_CONFLICT|DUPLICATE_OP_ID/);
 assert.deepEqual(await f.db.getAll('outbox'),[]);
 assert.equal(f.getState().__itmPending && Object.keys(f.getState().__itmPending).length || 0,0);
 assert.equal(await f.db.get('syncMeta','itmDraft:sess-1'),undefined);
 await f.p.enqueueBatch([req('P-1'),req('P-2')],'sess-1',{rows:[{rowId:'r1'}]});
 assert.equal((await f.db.getAll('outbox')).length,2);
 assert.equal(Object.keys(f.getState().__itmPending).length,2);
 assert.ok((await f.db.get('syncMeta','itmDraft:sess-1')).value);
 await f.db.close();
});
test('补丁 S1：已存在 outbox 同 opId 不被覆盖，也不重复提交',async()=>{
 const f=await persistenceFixture();
 await f.p.enqueueBatch([req('P-3')]);
 await f.p.enqueueBatch([req('P-3')]);
 assert.equal((await f.db.getAll('outbox')).length,1);
 await f.db.close();
});
function subState(status) {
 return {items:[{code:'WP-SUB',status:status,version:2,loc:status==='in_stock'?'SUB':'',container:''}],locations:[{code:'SUB',role:'容器子位',parentContainer:'CT',status:'active'}],containers:[{code:'CT',loc:'',status:'active',version:3}],workorders:[],materials:[],transactions:[]};
}
test('补丁 S2：子位直存物品工单出库生成 sub 源命令',()=>{
 const s=subState('in_stock');const order=Core.createOrder(s,{code:'LL-S',type:'LL',items:[{itemCodes:['WP-SUB']}]}).order;
 const plan=Core.buildItemExecCommands(s,order,['WP-SUB']);
 assert.equal(plan.ok,true,JSON.stringify(plan.errors));
 assert.deepEqual(plan.commands[0].source,{loc:'SUB',container:'',sub:true});
 assert.deepEqual(plan.ops[0].fromContainer,'');
});
test('补丁 S2：子位目标工单入库与冲销均可生成合法命令',()=>{
 const s=subState('pending');const order=Core.createOrder(s,{code:'BH-S',type:'BH',items:[{itemCodes:['WP-SUB']}]}).order;
 const plan=Core.buildItemExecCommands(s,order,['WP-SUB'],{target:{loc:'SUB',container:''}});
 assert.equal(plan.ok,true,JSON.stringify(plan.errors));
 assert.deepEqual(plan.commands[0].target,{loc:'SUB',container:'',sub:true});
 s.items[0].status='in_stock';s.items[0].loc='SUB';
 Core.applyItemExecResult(s,order,[{opId:'BH-S-WP-SUB',itemCode:'WP-SUB',phase:'APPLIED',fromLoc:'SUB',fromContainer:''}]);
 const reversed=Core.buildItemReverseCommands(s,order);
 assert.equal(reversed.ok,true,JSON.stringify(reversed.errors));
 assert.equal(reversed.commands[0].kind,'issue');
 assert.deepEqual(reversed.commands[0].source,{loc:'SUB',container:'',sub:true});
});
test('补丁 S2：子位出库冲销退回原子位，不因容器为空拒绝',()=>{
 const s=subState('in_stock');const order=Core.createOrder(s,{code:'LL-REV',type:'LL',items:[{itemCodes:['WP-SUB']}]}).order;
 Core.applyItemExecResult(s,order,[{opId:'LL-REV-WP-SUB',itemCode:'WP-SUB',phase:'APPLIED',fromLoc:'SUB',fromContainer:''}]);
 s.items[0].status='out';
 const reversed=Core.buildItemReverseCommands(s,order);
 assert.equal(reversed.ok,true,JSON.stringify(reversed.errors));
 assert.deepEqual(reversed.commands[0].target,{loc:'SUB',container:'',sub:true});
});
test('补丁 S3：同浏览器同 opId 同时调用 submit，远程 POST 只发一次',async()=>{
 let release;const gate=new Promise(r=>release=r);let calls=0;
 const request=req('P-DUP');
 const p={acknowledge:async()=>{},markUnknown:async()=>{}};
 const client=Client.create({persistence:p,fetch:async()=>{calls++;await gate;return {ok:true,json:async()=>({ok:true,operation:{code:'P-DUP',phase:'APPLIED',request}})};}});
 const command={id:'P-DUP',op:'itemOperation',request};
 const first=client.submit(command),second=client.submit(command);
 await Promise.resolve();release();
 const a=await first,b=await second;
 assert.equal(calls,1);
 assert.equal(a.phase,'APPLIED');assert.equal(b.phase,'APPLIED');
});
