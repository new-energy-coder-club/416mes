'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),UI=require('../lib/item-ui'),Client=require('../lib/item-client');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(state,opts={}){const {document}=parseHTML(html);let n=0;const page=UI.mount({document,getState:()=>state,getPersistence:()=>opts.persistence,getCommands:async()=>[],id:()=> 'op-'+(++n),...opts});return {document,page};}
test('S5.1 imported commands display original payload and inspect GET without mutation/requeue',async()=>{
 const state={__itmRecoveryReview:{commands:[{id:'original',op:'itemOperation',request:{opId:'original',itemCode:'I'}}]}};let method,url;
 const client=Client.create({persistence:{acknowledge(){throw Error('must not ACK');},markUnknown(){throw Error('must not mutate');}},fetch:async(u,o)=>{method=o.method;url=u;return {ok:true,json:async()=>({ok:true,operation:{code:'original',phase:'APPLIED'}})};}});
 const {document:d}=setup(state,{getClient:()=>client});const before=JSON.stringify(state);
 assert.match(d.getElementById('itmRecoveryReview').textContent,/1 条，未自动重发/);
 d.getElementById('itmRecoveryReview').querySelector('button').click();await tick();
 assert.equal(method,'GET');assert.match(url,/opId=original/);assert.match(d.getElementById('itmRecoveryReview').textContent,/APPLIED/);assert.equal(JSON.stringify(state),before);
});
test('S5.1 conflict panel shows both facts and refresh never freely resolves',async()=>{
 const state={__itmConflicts:{'items:I':{reason:'external-edit',local:{container:'C-A'},observed:{container:'C-B'}}}};let calls=0;
 const {document:d}=setup(state,{refreshConflicts:async()=>{calls++;}});const before=JSON.stringify(state);
 assert.match(d.getElementById('itmConflictPanel').textContent,/items:I.*external-edit/);assert.match(d.getElementById('itmConflictPanel').textContent,/C-A/);assert.match(d.getElementById('itmConflictPanel').textContent,/C-B/);
 d.getElementById('itmConflictRefresh').click();await tick();assert.equal(calls,1);assert.equal(JSON.stringify(state),before);assert.match(d.getElementById('itmStatus').textContent,/继续阻断/);
});
test('S5.1 retire UI only queues pending/out with version, never directly retires',async()=>{
 for(const status of ['pending','out','in_stock','unknown','retired']){const state={items:[{code:'I',status,version:2}]};const queued=[];const {document:d}=setup(state,{persistence:{async enqueue(q){queued.push(q);}}});
 d.getElementById('itmRetireCode').value='I';d.getElementById('itmRetireReason').value='damaged';d.getElementById('itmRetire').click();await tick();assert.equal(queued.length,['pending','out'].includes(status)?1:0);if(queued.length){assert.equal(queued[0].kind,'retire');assert.equal(queued[0].expected.itemVersion,2);}assert.equal(state.items[0].status,status);}
});
test('S5.1 actual legacy generation click handlers exit before any archive or label mutation',()=>{
 const handlers={},alerts=[],tabs=[];const context=vm.createContext({state:{__itmSchemaColumns:{locations:['状态']}},document:{getElementById:id=>({addEventListener:(event,fn)=>{handlers[id]=fn;}})},alert:x=>alerts.push(x),goTab:x=>tabs.push(x)});
 const start=html.indexOf('function blockLegacyUniqueLabels()');vm.runInContext(html.slice(start,html.indexOf('/* ================= ③',start)),context);
 for(const id of ['btnGenShelf','btnGenOpen','btnGenWs','btnGenCtn','btnGenZone']){const at=html.indexOf("document.getElementById('"+id+"').addEventListener");vm.runInContext(html.slice(at,html.indexOf('\n});',at)+4),context);handlers[id]();}
 assert.equal(alerts.length,5);assert.ok(alerts.every(s=>s.includes('不会新增本地档案')));assert.deepEqual(tabs,Array(5).fill('item-work'));
 context.state={locations:[{code:'old',status:'unknown',version:0}]};assert.equal(context.blockLegacyUniqueLabels(),false);
 context.state={__itmControlledMode:true};assert.equal(context.blockLegacyUniqueLabels(),true);
 context.state={containers:[{code:'C',version:1,lastOpId:'confirmed'}]};assert.equal(context.blockLegacyUniqueLabels(),true);
});
