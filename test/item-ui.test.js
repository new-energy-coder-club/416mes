'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom'),UI=require('../lib/item-ui');
function setup(persistence=null,scanCamera=null){const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document}=parseHTML(html);let n=0,writes=0;const state={locations:[{code:'SAME',status:'active',desc:'location'},{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'SAME',name:'item',status:'pending',version:0},{code:'I-P',name:'part',status:'pending',version:0}]};const page=UI.mount({document,scanCamera,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>[],id:()=>String(++n)});return {document,state,page,writes};}
function fakeCam(){return {opened:0,closed:0,lastOpts:null,isOpen:()=>false,async open(o){this.opened++;this.lastOpts=o;},close(){this.closed++;}};}
test('DOM query typed prefix selects item and bare collision lists candidates without write',()=>{const {document:d,state}=setup(),before=JSON.stringify(state);d.getElementById('itmSearch').value='SAME';d.getElementById('itmSearchBtn').click();assert.match(d.getElementById('itmResults').textContent,/多个候选/);assert.equal(d.getElementById('itmResults').querySelectorAll('button').length,2);d.getElementById('itmSearch').value='ITM:SAME';d.getElementById('itmSearchBtn').click();assert.match(d.getElementById('itmResults').textContent,/数量：1/);assert.equal(JSON.stringify(state),before);});
test('DOM draft save/restore and double confirm persist exactly one command',async()=>{let draft=null,calls=0;const persistence={async saveDraft(id,value){draft={key:'itmDraft:'+id,value:structuredClone(value)};},async recover(){return {drafts:draft?[draft]:[],commands:[]};},async enqueue(){calls++;}};const {document:d,page}=setup(persistence);await page.accept('LOC:L-A');await page.accept('CTN:C-A');d.getElementById('itmDraftSave').click();await new Promise(r=>setImmediate(r));page.scan.reset();d.getElementById('itmDraftRestore').click();await new Promise(r=>setImmediate(r));assert.equal(page.scan.row().values.length,2);await page.accept('ITM:I-P');d.getElementById('itmConfirm').click();d.getElementById('itmConfirm').click();await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.match(d.getElementById('itmStatus').textContent,/不代表业务完成/);});
test('DOM IDB enqueue failure does not display completion and leaves retry available',async()=>{const {document:d,page}=setup({async enqueue(){throw Error('IDB写失败');}});for(const text of ['LOC:L-A','CTN:C-A','ITM:I-P'])await page.accept(text);d.getElementById('itmConfirm').click();await new Promise(r=>setImmediate(r));assert.match(d.getElementById('itmStatus').textContent,/IDB写失败/);assert.equal(page.scan.row().locked,false);assert.equal(d.getElementById('itmConfirm').disabled,false);});
test('work camera opens shared ScanCamera with row token; confirm card fills current step',async()=>{const cam=fakeCam();const {document:d,page}=setup(null,cam);d.getElementById('itmCamera').click();await new Promise(r=>setImmediate(r));assert.equal(cam.opened,1);assert.equal(typeof cam.lastOpts.captureToken,'function');const token=cam.lastOpts.captureToken();cam.lastOpts.onConfirm('LOC:L-A',token);await new Promise(r=>setImmediate(r));assert.equal(page.scan.row().values.length,1);assert.equal(page.scan.row().values[0].code,'L-A');page.stopCamera();assert.equal(cam.closed,1);});
test('query camera confirm fills query box only after user confirms',async()=>{const cam=fakeCam();const {document:d}=setup(null,cam);d.getElementById('itmSearchCamera').click();await new Promise(r=>setImmediate(r));assert.equal(cam.opened,1);cam.lastOpts.onConfirm('ITM:I-P');await new Promise(r=>setImmediate(r));assert.equal(d.getElementById('itmSearch').value,'ITM:I-P');assert.match(d.getElementById('itmResults').textContent,/part/);});
test('work describe rejects wrong-type code before filling',async()=>{const cam=fakeCam();const {document:d}=setup(null,cam);d.getElementById('itmCamera').click();await new Promise(r=>setImmediate(r));const verdict=cam.lastOpts.describe({text:'ITM:I-P',format:'条形码'});assert.equal(verdict.ok,false);assert.match(verdict.text,/库位/);});
test('admin activation UI queues controlled command without mutating legacy location',async()=>{let queued;const {document:d,state}=setup({async enqueue(r){queued=r;}});state.locations.push({code:'LEGACY',status:'unknown'});d.getElementById('itmAdminLoc').value='LEGACY';d.getElementById('itmActivateLoc').click();await new Promise(r=>setImmediate(r));assert.equal(queued.kind,'activateLocation');assert.equal(queued.expected.locationStatus,'unknown');assert.equal(state.locations.at(-1).status,'unknown');});
test('query scan cannot fill operation row; row table resolves APPLIED by opId',async()=>{const {document:d,page,state}=setup();const before=page.scan.snapshot();page.queryScan('ITM:I-P');assert.deepEqual(page.scan.snapshot(),before);assert.match(d.getElementById('itmResults').textContent,/数量：1/);for(const code of ['LOC:L-A','CTN:C-A','ITM:I-P'])await page.accept(code);const q=page.scan.lock();state.itemOperations=[{code:q.opId,phase:'APPLIED'}];page.render();assert.match(d.getElementById('itmRowTable').textContent,/已完成/);assert.equal(page.scan.row().locked,true);});
test('query camera error stays in visible query status and does not overwrite work status',async()=>{const {document:d}=setup();const work=d.getElementById('itmStatus').textContent;d.getElementById('itmSearchCamera').click();await new Promise(r=>setImmediate(r));assert.match(d.getElementById('itmSearchStatus').textContent,/查询失败|不可用/);assert.equal(d.getElementById('itmStatus').textContent,work);});
test('work UI translates kind, renders dynamic steps and mobile table labels',async()=>{const {document:d,page}=setup();assert.match(d.getElementById('itmStep').textContent,/入库.*目标库位/s);await page.accept('LOC:L-A');assert.match(d.getElementById('itmStep').textContent,/✓ 1 目标库位：L-A.*目标容器/s);const cells=[...d.getElementById('itmRowTable').querySelectorAll('td')];assert.deepEqual(cells.map(x=>x.getAttribute('data-th')),['行','库位','容器','物品','操作','状态']);assert.match(d.getElementById('itmRowTable').textContent,/入库/);assert.doesNotMatch(d.getElementById('itmStep').textContent,/行 \d+；/);});
test('search results are Chinese cards with translated state and separate status',()=>{const {document:d}=setup();d.getElementById('itmSearch').value='part';d.getElementById('itmSearchBtn').click();assert.equal(d.getElementById('itmResults').querySelectorAll('.itm-result-card').length,1);assert.match(d.getElementById('itmResults').textContent,/物品.*待入库/s);assert.match(d.getElementById('itmSearchStatus').textContent,/找到 1 条/);});
test('six operation types keep original sequences with distinct Chinese step guides',()=>{const {document:d,page}=setup();for(const [kind,count,label] of [['receive',3,'入库物品'],['issue',3,'出库物品'],['transfer',5,'目标容器'],['moveContainer',3,'待移动容器'],['placeContainer',2,'待定位容器'],['verifyLegacy',3,'旧物品']]){page.scan.add(kind);page.render();assert.equal(d.getElementById('itmStep').querySelectorAll('li').length,count);assert.match(d.getElementById('itmStep').textContent,new RegExp(label));assert.equal(d.getElementById('itmConfirm').disabled,true);}});
test('pending cards never auto-submit and preserve original command for explicit actions',async()=>{const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);const command={id:'uuid-long-original-command',status:'pending',request:{kind:'receive',itemCode:'I-P',target:{loc:'L-A',container:'C-A'}}};let submitted=0,queried=0;const page=UI.mount({document:d,getState:()=>({}),id:()=> 'id',getPersistence:()=>null,getCommands:async()=>[command],getClient:()=>({submit:async c=>{assert.equal(c,command);submitted++;return {phase:'APPLIED'};},query:async c=>{assert.equal(c,command);queried++;return {phase:'PREPARED'};}})});await page.pending();assert.equal(submitted,0);assert.equal(queried,0);const card=d.getElementById('itmPending').querySelector('article');assert.match(card.textContent,/入库 · 待提交/);assert.match(card.querySelector('.itm-meta').textContent,/uuid-long-original-command/);card.querySelector('button').click();await new Promise(r=>setImmediate(r));assert.equal(submitted,1);assert.equal(queried,0);d.getElementById('itmPending').querySelectorAll('button')[1].click();await new Promise(r=>setImmediate(r));assert.equal(queried,1);assert.match(d.getElementById('itmStatus').textContent,/已准备，待确认/);});
test('query missing codes and detail errors stay local without mutating state or drafts',()=>{const {document:d,page,state}=setup();const before=JSON.stringify(state),draft=page.scan.snapshot(),work=d.getElementById('itmStatus').textContent;page.queryScan('ITM:missing');assert.match(d.getElementById('itmSearchStatus').textContent,/未找到编码/);page.detail('items','missing');assert.match(d.getElementById('itmSearchStatus').textContent,/查询失败/);assert.equal(d.getElementById('itmStatus').textContent,work);assert.equal(JSON.stringify(state),before);assert.deepEqual(page.scan.snapshot(),draft);});
test('DOM location drilldown to container then item works via actual clicks',()=>{const {document:d,state}=setup();state.items[1]={...state.items[1],status:'in_stock',container:'C-A'};d.getElementById('itmSearch').value='LOC:L-A';d.getElementById('itmSearchBtn').click();d.getElementById('itmResults').querySelector('button').click();const buttons=[...d.getElementById('itmResults').querySelectorAll('button')];buttons.find(b=>b.textContent.includes('I-P')).click();assert.match(d.getElementById('itmResults').textContent,/C-A → L-A/);});
const tickN=async(n=6)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
function setupGuided(){const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document}=parseHTML(html);let n=0;const state={locations:[{code:'L-OLD',status:'unknown'},{code:'L-A',status:'active'}],containers:[{code:'C-OLD',loc:'L-A',status:'unknown',version:0}],items:[]};let queued=null,submitted=0;const persistence={async enqueue(r){queued=r;},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};const client={async submit(c){submitted++;if(c.request.kind==='activateLocation')state.locations[0].status='active';if(c.request.kind==='activateContainer')state.containers[0].status='active';return {phase:'APPLIED',code:c.id};}};const page=UI.mount({document,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>queued?[{id:queued.opId,op:'itemOperation',request:queued}]:[],getClient:()=>client,id:()=>'guided-'+(++n)});return {document,state,page,get queued(){return queued},get submitted(){return submitted}};}
test('guided activate: unknown LOC blocks fill, action button enables and retries into step',async()=>{
 const s=setupGuided();const d=s.document,page=s.page;
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN();
 assert.match(d.getElementById('itmStatus').textContent,/未启用/);assert.equal(page.scan.row().values.length,0);
 const action=d.getElementById('itmStatus').querySelector('button');assert.ok(action,'应提供现场核实启用按钮');
 action.click();await tickN(12);
 assert.equal(s.queued&&s.queued.kind,'activateLocation');assert.equal(s.submitted,1);
 assert.deepEqual(page.scan.row().values.map(v=>v.code),['L-OLD'],'APPLIED后自动重试填入原步骤');
});
test('guided activate: unknown container uses current row LOC as target and resumes',async()=>{
 const s=setupGuided();const d=s.document,page=s.page;
 await page.accept('LOC:L-A');
 d.getElementById('itmCode').value='CTN:C-OLD';d.getElementById('itmScanBtn').click();await tickN();
 const action=d.getElementById('itmStatus').querySelector('button');assert.ok(action,'容器未启用应提供引导按钮');
 action.click();await tickN(12);
 assert.equal(s.queued&&s.queued.kind,'activateContainer');assert.equal(s.queued&&s.queued.target.loc,'L-A');assert.equal(s.submitted,1);
 assert.deepEqual(page.scan.row().values.map(v=>v.code),['L-A','C-OLD']);
});
test('guided verify: unknown item on receive offers switching to verifyLegacy row',async()=>{
 const s=setupGuided();s.state.items.push({code:'WP-OLD',name:'旧物品'});
 s.state.containers[0].status='active';   // 先把容器置为可用，专注验证物品引导
 await s.page.accept('LOC:L-A');await s.page.accept('CTN:C-OLD');
 s.document.getElementById('itmCode').value='ITM:WP-OLD';s.document.getElementById('itmScanBtn').click();await tickN();
 assert.match(s.document.getElementById('itmStatus').textContent,/尚待核实|重复入库/);
 const action=s.document.getElementById('itmStatus').querySelector('button');assert.ok(action,'旧物品应提供切换引导');
 action.click();await tickN();
 assert.equal(s.page.scan.row().kind,'verifyLegacy');assert.match(s.document.getElementById('itmStep').textContent,/旧物品/);
});
test('empty fill shows explicit guidance instead of silent failure',async()=>{const {document:d}=setup();d.getElementById('itmCode').value='';d.getElementById('itmScanBtn').click();await new Promise(r=>setImmediate(r));assert.match(d.getElementById('itmStatus').textContent,/相机扫码|确定填入|手动输入/);});
test('unregistered ITM code offers register guidance with prefilled code',async()=>{
 const s=setupGuided();s.state.containers[0].status='active';
 await s.page.accept('LOC:L-A');await s.page.accept('CTN:C-OLD');
 s.document.getElementById('itmCode').value='ITM:WP-999';s.document.getElementById('itmScanBtn').click();await tickN();
 assert.match(s.document.getElementById('itmStatus').textContent,/未建档/);
 const action=s.document.getElementById('itmStatus').querySelector('button');assert.ok(action,'未建档应提供建档引导');
 action.click();await tickN();
 assert.equal(s.document.getElementById('itmRegisterCode').value,'WP-999');
 assert.ok(s.document.getElementById('itmRegister').closest('details').open,'建档区应自动展开');
});
test('rejected legacy conflict command offers override resubmit with new opId',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');const{document:d}=parseHTML(html);
 const command={id:'old-op',status:'pending',request:{kind:'verifyLegacy',itemCode:'WP-001',target:{loc:'W02-G01',container:'C-D'},error:'LEGACY_LOCATION_CONFLICT',phase:'REJECTED'}};
 let queued=null;const p={async enqueue(r){queued=r;}};
 const page=UI.mount({document:d,getState:()=>({items:[],containers:[],locations:[]}),getPersistence:()=>p,getCommands:async()=>[command],getClient:()=>({submit:async()=>({phase:'APPLIED'}),query:async()=>({phase:'REJECTED'})}),id:()=>'new-op'});
 await page.pending();
 const btns=[...d.getElementById('itmPending').querySelectorAll('button')].map(b=>b.textContent);
 assert.ok(btns.some(t=>t.includes('以实物为准重发')),'应有覆盖重发按钮');
 d.getElementById('itmPending').querySelectorAll('button').forEach(b=>{if(b.textContent.includes('以实物为准'))b.click();});
 await tickN(10);
 assert.equal(queued.confirmLegacyLocOverride,true);assert.equal(queued.opId,'new-op');assert.equal(queued.error,undefined);
});
/* ================= D2（§六待修③④）：短链归一进查询手输入口与建档引导 ================= */
const LINK=require('../lib/item-link');
function setupLink(state){const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document}=parseHTML(html);document.defaultView.ItemLink=LINK;let n=0;const page=UI.mount({document,getState:()=>state,getPersistence:()=>null,getCommands:async()=>[],id:()=>'d2-'+(++n)});return {document,state,page};}
const linkState=()=>({locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'WP-001',name:'灯珠',status:'pending',version:0}]});
test('D2-③：查询框手输整条短链按回车 → 归一成物品码并查到',()=>{
 const {document:d}=setupLink(linkState());
 const input=d.getElementById('itmSearch');input.value=LINK.linkFor('WP-001');
 const e=new d.defaultView.Event('keydown',{bubbles:true,cancelable:true});e.key='Enter';input.dispatchEvent(e);
 assert.equal(input.value,'WP-001','归一后回写物品码，让用户看见系统认出了什么');
 assert.match(d.getElementById('itmResults').textContent,/数量：1/);
});
test('D2-③：裸 8 位短码（含小写）手输同样查到；普通关键词不误归一',()=>{
 const {document:d}=setupLink(linkState());
 const input=d.getElementById('itmSearch');
 input.value=LINK.fromItemCode('WP-001');d.getElementById('itmSearchBtn').click();
 assert.equal(input.value,'WP-001');assert.match(d.getElementById('itmResults').textContent,/数量：1/);
 input.value=LINK.fromItemCode('WP-001').toLowerCase();d.getElementById('itmSearchBtn').click();
 assert.equal(input.value,'WP-001','小写裸码也归一');assert.match(d.getElementById('itmResults').textContent,/数量：1/);
 input.value='灯珠';d.getElementById('itmSearchBtn').click();
 assert.equal(input.value,'灯珠','非短链关键词原样保留');assert.match(d.getElementById('itmSearchStatus').textContent,/找到 1 条/);
});
test('D2-③：印刷版全大写短链手输同样查到（冻结规格整条大写）',()=>{
 const {document:d}=setupLink(linkState());
 const input=d.getElementById('itmSearch');input.value=LINK.linkFor('WP-001').toUpperCase();d.getElementById('itmSearchBtn').click();
 assert.equal(input.value,'WP-001');assert.match(d.getElementById('itmResults').textContent,/数量：1/);
});
test('D2-③：带 ?to=feishu 的短链手输也可查（query 不印码但手输可能被粘贴进来）',()=>{
 const {document:d}=setupLink(linkState());
 const input=d.getElementById('itmSearch');input.value=LINK.linkFor('WP-001')+'?to=feishu';d.getElementById('itmSearchBtn').click();
 assert.equal(input.value,'WP-001');assert.match(d.getElementById('itmResults').textContent,/数量：1/);
});
test('D2-④：扫短链（未建档）触发建档引导并预填物品码',async()=>{
 const {document:d,page}=setupLink({locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[]});
 await page.accept('LOC:L-A');await page.accept('CTN:C-A');
 d.getElementById('itmCode').value=LINK.linkFor('WP-999');d.getElementById('itmScanBtn').click();await tickN();
 assert.match(d.getElementById('itmStatus').textContent,/未建档/);
 const action=d.getElementById('itmStatus').querySelector('button');assert.ok(action,'未建档应提供建档引导');
 action.click();await tickN();
 assert.equal(d.getElementById('itmRegisterCode').value,'WP-999');
 assert.ok(d.getElementById('itmRegister').closest('details').open,'建档区应自动展开');
});
test('D2-④：裸 8 位短码（未建档）同样触发建档引导',async()=>{
 const {document:d,page}=setupLink({locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[]});
 await page.accept('LOC:L-A');await page.accept('CTN:C-A');
 d.getElementById('itmCode').value=LINK.fromItemCode('WP-998');d.getElementById('itmScanBtn').click();await tickN();
 assert.match(d.getElementById('itmStatus').textContent,/未建档/);
 d.getElementById('itmStatus').querySelector('button').click();await tickN();
 assert.equal(d.getElementById('itmRegisterCode').value,'WP-998');
});
test('D2-④：扫短链（已建档）正常填入当前步骤，不走引导',async()=>{
 const {document:d,page}=setupLink(linkState());
 await page.accept('LOC:L-A');await page.accept('CTN:C-A');
 d.getElementById('itmCode').value=LINK.linkFor('WP-001').toUpperCase();d.getElementById('itmScanBtn').click();await tickN();
 assert.deepEqual(page.scan.row().values.map(v=>v.code),['L-A','C-A','WP-001']);
 assert.match(d.getElementById('itmStatus').textContent,/已填写草稿/);
 assert.equal(d.getElementById('itmStatus').querySelector('button'),null,'不应出现引导按钮');
});
/* ================= E1（定稿§三.3 + §三.2 P4/P6）：建档改版 ================= */
function pick(d,id,value){const sel=d.getElementById(id);for(const o of sel.options){if(o.value===value)o.setAttribute('selected','');else o.removeAttribute('selected');}sel.dispatchEvent(new d.defaultView.Event('change',{bubbles:true}));}
function setupE1({online=true,appliedCode='WP-TS-001'}={}){
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document}=parseHTML(html);
 document.defaultView.ItemLink=LINK;
 const state={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[]};
 let n=0,queued=null,submitted=null;
 const persistence={async enqueue(r){queued=r;},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
 const client={async submit(c){submitted=c;return{phase:'APPLIED',code:c.id,request:{...c.request,entity:{...c.request.entity,code:appliedCode}},after:{items:[{code:appliedCode,name:c.request.entity.name,status:'pending',version:1,lastOpId:c.id}]}};}};
 const page=UI.mount({document,state,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>queued?[{id:queued.opId,op:'itemOperation',request:queued,status:'pending'}]:[],
  getClient:()=>client,id:()=>'e1-'+(++n),isOnline:()=>online,qrSvg:t=>'QR['+t+']'});
 return {document,state,page,get queued(){return queued},get submitted(){return submitted}};
}
test('E1：分类下拉 8 类且顺序与 item-link CATS 一致；分类/名称必填拦截',async()=>{
 const s=setupE1(),d=s.document;
 const values=[...d.getElementById('itmRegisterCat').options].map(o=>o.value).filter(Boolean);
 assert.deepEqual(values,['JG','DJ','DZ','GZ','TS','GJ','HC','QT'],'分类下拉顺序必须与短码 CATS 一致（P8）');
 d.getElementById('itmRegisterName').value='示波器';
 d.getElementById('itmRegister').click();await tickN();
 assert.match(d.getElementById('itmRegisterResult').textContent,/请先选择物品分类/,'建档校验提示就近落在建档区');
 assert.equal(s.queued,null,'未选分类不得入队');
 pick(d,'itmRegisterCat','TS');d.getElementById('itmRegisterName').value='';
 d.getElementById('itmRegister').click();await tickN();
 assert.match(d.getElementById('itmRegisterResult').textContent,/请填写物品名称/,'建档校验提示就近落在建档区');
 assert.equal(s.queued,null,'未填名称不得入队');
});
test('E1：在线建档不带码提交 → APPLIED 展示物品码 + 8 位短码 + 二维码预览',async()=>{
 const s=setupE1(),d=s.document;
 pick(d,'itmRegisterCat','TS');
 d.getElementById('itmRegisterName').value='示波器';d.getElementById('itmRegisterSpec').value='100MHz';
 d.getElementById('itmRegister').click();await tickN(10);
 assert.equal(s.queued.entity.code,undefined,'在线建档不带 code（服务端发号）');
 assert.equal(s.queued.entity.category,'TS');
 assert.ok(s.submitted,'在线应立即提交发号');
 assert.equal(s.submitted.request.entity.code,undefined,'提交服务端的请求同样不带 code');
 const box=d.getElementById('itmRegisterResult');
 assert.match(box.textContent,/已分配物品码：WP-TS-001/);
 assert.match(box.textContent,new RegExp('短码：'+LINK.fromItemCode('WP-TS-001')));
 assert.ok(box.querySelector('.itm-qr'),'应有二维码预览容器');
 assert.match(box.querySelector('.itm-qr').textContent,new RegExp('QR\\['+LINK.linkFor('WP-TS-001').toUpperCase().replace(/[/.]/g,'\\$&')+'\\]'),'二维码内容为冻结规格整条大写短链');
 assert.match(d.getElementById('itmRegisterResult').textContent,/建档完成：WP-TS-001/,'完成语追加在预览之后（不覆盖二维码）');
});
test('E1：「去入库」切 receive 行并在物品步骤预填新码',async()=>{
 const s=setupE1(),d=s.document;
 pick(d,'itmRegisterCat','TS');d.getElementById('itmRegisterName').value='示波器';
 d.getElementById('itmRegister').click();await tickN(10);
 const go=[...d.getElementById('itmRegisterResult').querySelectorAll('button')].find(b=>b.textContent==='去入库');
 assert.ok(go,'建档完成后应有「去入库」按钮');
 go.click();await tickN();
 assert.equal(s.page.scan.row().kind,'receive','应切到入库行');
 assert.equal(d.getElementById('itmKind').value,'receive','作业类型下拉应切到入库');
 await s.page.accept('LOC:L-A');await s.page.accept('CTN:C-A');
 assert.equal(d.getElementById('itmCode').value,'ITM:WP-TS-001','物品步骤应自动预填新码');
});
test('E1：离线只入队不提交，提示提交后分配物品码',async()=>{
 const s=setupE1({online:false}),d=s.document;
 pick(d,'itmRegisterCat','GJ');d.getElementById('itmRegisterName').value='扳手';
 d.getElementById('itmRegister').click();await tickN();
 assert.ok(s.queued,'离线也应入队保存');
 assert.equal(s.queued.entity.code,undefined);
 assert.equal(s.submitted,null,'离线不得提交');
 assert.match(d.getElementById('itmRegisterResult').textContent,/提交后由服务端分配物品码/);
});
test('E1：手动码路径保留——填码即带码入队、不走发号提交',async()=>{
 const s=setupE1(),d=s.document;
 pick(d,'itmRegisterCat','TS');
 d.getElementById('itmRegisterName').value='现场扫到的码';d.getElementById('itmRegisterCode').value='WP-999';
 d.getElementById('itmRegister').click();await tickN();
 assert.equal(s.queued.entity.code,'WP-999','手动码原样带上（规范形校验在服务端）');
 assert.equal(s.submitted,null,'手动码只入队，待在待处理区提交');
 assert.match(d.getElementById('itmRegisterResult').textContent,/手动码/);
});
test('E1（P6）：pending 卡对无码 registerItem 显示「物品建档·分类·待发号」',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const command={id:'reg-auto-1',status:'pending',request:{schemaVersion:1,opId:'reg-auto-1',kind:'registerItem',entity:{category:'TS',name:'示波器'}}};
 const page=UI.mount({document:d,getState:()=>({}),id:()=>'id',getPersistence:()=>null,getCommands:async()=>[command]});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 assert.match(card.textContent,/物品建档 · TS · 待发号/,'无码建档卡应明示待发号而不是待核实');
 assert.doesNotMatch(card.textContent,/待核实$/);
});
test('E1：errZh 覆盖发号/手动码四类新错误码',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const cases=[['SERIAL_EXHAUSTED','序号已用尽'],['NON_CANONICAL_ITEM_CODE','写法不规范'],['DUPLICATE_SHORTLINK_IDENTITY','短链身份冲突'],['BAD_CATEGORY','分类无效']];
 const commands=cases.map(([code],i)=>({id:'err-'+i,status:'pending',request:{schemaVersion:1,opId:'err-'+i,kind:'receive',itemCode:'I-P',error:code}}));
 const page=UI.mount({document:d,getState:()=>({}),id:()=>'id',getPersistence:()=>null,getCommands:async()=>commands});
 await page.pending();
 const text=d.getElementById('itmPending').textContent;
 for(const [code,zh] of cases){assert.ok(text.includes(zh),'应有中文文案：'+code);assert.ok(text.includes(code),'保留英文错误码便于排查：'+code);}
});
