'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRuntime}=require('../lib/item-runtime');
const {repositoryFixture}=require('./fixtures/item-protocol');

test('feishu trial mode runs without auth/coordinator injection and remains explicitly best-effort',async()=>{
 const repository=repositoryFixture();repository.allOperations=async()=>repository.logs;
 const service=require('../lib/item-operation').create({repository,coordinator:require('../lib/item-trial-coordinator').create(repository),enabled:true,mode:'feishu-trial'});
 assert.equal(service.mode,'feishu-trial');
 const result=await service.post({}, {schemaVersion:1,opId:'trial-issue',kind:'issue',itemCode:'I',source:{loc:'L',container:'C'},expected:{itemVersion:3,containerVersion:2},reason:'trial'});
 assert.equal(result.phase,'APPLIED',result.error);assert.equal(repository.state.items[0].status,'out');assert.equal(repository.writes,1);
});

test('trial mode duplicate same opId returns existing result and different payload conflicts',async()=>{
 const repository=repositoryFixture();repository.allOperations=async()=>repository.logs;const coord=require('../lib/item-trial-coordinator').create(repository);
 const service=require('../lib/item-operation').create({repository,coordinator:coord,enabled:true,mode:'feishu-trial'});
 const request={schemaVersion:1,opId:'same',kind:'issue',itemCode:'I',source:{loc:'L',container:'C'},expected:{itemVersion:3,containerVersion:2}};
 assert.equal((await service.post({},request)).phase,'APPLIED');assert.equal((await service.post({},request)).phase,'APPLIED');
 await assert.rejects(()=>service.post({}, {...request,reason:'different'}),/OP_ID_PAYLOAD_CONFLICT/);assert.equal(repository.writes,1);
});
