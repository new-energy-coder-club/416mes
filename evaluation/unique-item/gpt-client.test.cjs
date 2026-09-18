'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const Client=require('../../.dev-lines/gpt6/lib/item-client');
test('GPT client: timeout covers stalled response body as well as response headers',async()=>{
 let marked=0;const client=Client.create({timeoutMs:20,persistence:{async markUnknown(){marked++;},async acknowledge(){throw Error('unexpected');}},fetch:async()=>({ok:true,json:()=>new Promise(()=>{})})});
 const cmd={id:'body-timeout',op:'itemOperation',request:{opId:'body-timeout'}};
 const result=await Promise.race([client.submit(cmd).then(()=>({kind:'success'}),e=>({kind:'rejected',message:e.message})),new Promise(resolve=>setTimeout(()=>resolve({kind:'hung'}),120))]);
 assert.equal(result.kind,'rejected','body parse stalled beyond timeout without settling');assert.equal(marked,1);
});
