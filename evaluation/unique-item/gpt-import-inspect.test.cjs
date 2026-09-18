'use strict';const test=require('node:test'),assert=require('node:assert/strict');const Client=require('../../.dev-lines/gpt6/lib/item-client');
test('imported command inspection is GET-only and never acknowledges or queues data',async()=>{
 let mutations=0,observed;const client=Client.create({persistence:{async acknowledge(){mutations++;},async markUnknown(){mutations++;}},fetch:async(url,options)=>{observed={url,options};return{ok:true,json:async()=>({ok:true,operation:{code:'original/id',phase:'APPLIED'}})};}});
 const result=await client.inspect('original/id');assert.equal(result.phase,'APPLIED');assert.equal(observed.options.method,'GET');assert.match(observed.url,/original%2Fid/);assert.equal(observed.options.body,undefined);assert.equal(mutations,0);
});
test('failed imported inspection leaves local commands untouched',async()=>{let mutations=0;const client=Client.create({persistence:{async acknowledge(){mutations++;},async markUnknown(){mutations++;}},fetch:async()=>{throw Error('offline');}});await assert.rejects(()=>client.inspect('unknown'),/offline/);assert.equal(mutations,0);});
