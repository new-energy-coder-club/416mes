'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom'),F=require('fake-indexeddb');
const UI=require('../lib/item-ui'),Store=require('../lib/store'),Persistence=require('../lib/item-persistence'),Client=require('../lib/item-client'),Sync=require('../lib/item-sync');
const {create}=require('../lib/item-operation'),{handlerFor}=require('../api/feishu/item-operation'),{coordinatorFixture,repositoryFixture}=require('./fixtures/item-protocol');
test('DOM page to real IDB to localhost handler to second client confirmation, MAT unchanged',async t=>{
 const repository=repositoryFixture();repository.state.materials=[{code:'M-KEEP',qty:7}];const handler=handlerFor(create({repository,coordinator:coordinatorFixture(),enabled:true,authenticate:async()=>({id:'fake',roles:['operator']})}));
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');req.query=Object.fromEntries(url.searchParams);res.status=n=>{res.statusCode=n;return res;};res.json=o=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(o));};handler(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 const store=Store.createIndexedDbStore({indexedDB:new F.IDBFactory(),IDBKeyRange:F.IDBKeyRange,dbName:'mes416-state'});await store.open();t.after(()=>store.close());let state=structuredClone(repository.state);state.itemOperations=[];const p=Persistence.create({store,getState:()=>state,publish:s=>state=s,canWrite:()=>true});const client=Client.create({persistence:p,fetch:(url,opts)=>fetch(origin+url,opts)});
 const {document}=parseHTML(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'));let i=0;const ui=UI.mount({document,getState:()=>state,getPersistence:()=>p,getCommands:async()=>(await p.recover()).commands,getClient:()=>client,id:()=> 'test-'+(++i)});
 ui.scan.add('issue');for(const code of ['LOC:L','CTN:C','ITM:I'])await ui.accept(code);document.getElementById('itmConfirm').click();
 for(let k=0;k<100&&!document.getElementById('itmPending').textContent.includes('提交原命令');k++)await new Promise(r=>setTimeout(r,5));
 const submit=[...document.getElementById('itmPending').querySelectorAll('button')].find(b=>b.textContent==='提交原命令');assert.ok(submit);submit.click();
 for(let k=0;k<200&&!document.getElementById('itmStatus').textContent.includes('远端已确认');k++)await new Promise(r=>setTimeout(r,5));
 assert.match(document.getElementById('itmStatus').textContent,/远端已确认/);assert.equal(state.items[0].status,'out');assert.equal((await store.getAll('outbox')).length,0);assert.equal(repository.writes,1);
 const second={items:[],containers:structuredClone(state.containers),locations:structuredClone(state.locations),itemOperations:[],materials:[{code:'M-KEEP',qty:7}]};Sync.merge(second,{items:structuredClone(repository.state.items),itemOperations:structuredClone(repository.logs)});assert.equal(second.items[0].container,'');assert.equal(second.items[0].status,'out');assert.equal(state.materials[0].qty,7);assert.equal(second.materials[0].qty,7);
});
