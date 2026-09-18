'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../../.dev-lines/gpt6/lib/item-repository');
test('GPT repository: incomplete listing cannot prove opId absence',async()=>{
 const api={tenantToken:async()=> 'FAKE',TABLES:{itemOperations:'FAKE-OPS'},TABLE_DEFS:{itemOperations:{down:f=>f}},T:x=>String(x||''),listRecords:async()=>[],listRecordsEx:async()=>({items:[],complete:false,total:3,fetched:0})};
 await assert.rejects(()=>create(api).operations('prior-op'),/INCOMPLETE|完整|partial/i);
});
