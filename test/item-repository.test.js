'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Repository=require('../lib/item-repository');
test('repository every exact lookup refuses incomplete lists and refreshes token via API',async()=>{let tokens=0,writes=0;const api={TABLES:{items:'i',itemOperations:'o'},TABLE_DEFS:{items:{key:'物品码'},itemOperations:{key:'操作ID'}},T:String,async tenantToken(){tokens++;return 'fake';},async listRecordsEx(){return {complete:false,items:[{record_id:'first',fields:{'物品码':'I','操作ID':'op'}}]};},async batchUpdate(){writes++;}};const r=Repository.create(api);await assert.rejects(r.operations('op'),/INCOMPLETE/);await assert.rejects(r.apply({items:[{code:'I',container:''}]}),/INCOMPLETE/);await assert.rejects(r.readAfter({items:[{code:'I'}]}),/INCOMPLETE/);assert.equal(writes,0);assert.equal(tokens,12,'INCOMPLETE 重试 4 次（4 次读×3 路径）——5 台压测竞态窗口实测需要');});
test('strict item-operation handler fails closed without contacting Feishu',async()=>{const handler=require('../api/feishu/item-operation').handlerFor(require('../lib/item-runtime').createRuntime({mode:'strict'}));let status,body;const res={setHeader(){},status(n){status=n;return this;},json(v){body=v;return this;},end(){}};await handler({method:'GET',query:{opId:'op'}},res);assert.equal(status,401);assert.equal(body.error,'UNAUTHENTICATED');});


test('repository writes subloc unbind as explicit 自由位 select + cleared parent text',async()=>{
 let update=null;
 const api={
  KIND:{SELECT:'select'},
  TABLES:{locations:'loc'},
  TABLE_DEFS:{locations:{key:'库位码',fields:[
   ['code','库位码','text'],['status','状态','select'],['role','库位角色','select'],['parentContainer','所属容器码','text']
  ]}},
  T:v=>v==null?'':String(v),
  async tenantToken(){return 'fake';},
  async listRecordsEx(){return {complete:true,items:[{record_id:'rec-sub',fields:{'库位码':'SUB-1','状态':'active','库位角色':'容器子位','所属容器码':'C-A'}}]};},
  async batchUpdate(_token,_table,rows){update=structuredClone(rows);}
 };
 const r=Repository.create(api);
 await r.apply({locations:[{code:'SUB-1',status:'active',role:'自由位',parentContainer:''}]},{kind:'activateLocation'});
 assert.deepEqual(update,[{record_id:'rec-sub',fields:{'状态':'active','库位角色':'自由位','所属容器码':''}}],
  '解绑必须同时把单选写成自由位、父容器文本显式清空，不能形成半解绑');
});
