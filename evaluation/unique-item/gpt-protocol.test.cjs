'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../../.dev-lines/gpt6/lib/item-operation');
const {coordinatorFixture,repositoryFixture}=require('../../.dev-lines/gpt6/test/fixtures/item-protocol');
test('GPT protocol: authenticated identity without reader/operator role cannot retrieve operation',async()=>{
 const coordinator=coordinatorFixture();await coordinator.claim({opId:'private-op',requestHash:'h',operator:'owner'});await coordinator.finish('private-op',{code:'private-op',phase:'APPLIED',operator:'owner',request:{sensitive:'fixture'}});
 const service=create({repository:repositoryFixture(),coordinator,enabled:true,authenticate:async()=>({id:'unprivileged',roles:[]})});
 await assert.rejects(()=>service.get({},'private-op'),e=>e.status===403);
});
