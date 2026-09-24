'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom'),UI=require('../lib/item-ui');
function setup(persistence=null,scanCamera=null){const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document}=parseHTML(html);let n=0,writes=0;const state={locations:[{code:'SAME',status:'active',desc:'location'},{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'SAME',name:'item',status:'pending',version:0},{code:'I-P',name:'part',status:'pending',version:0}]};const page=UI.mount({document,scanCamera,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>[],id:()=>String(++n)});return {document,state,page,writes};}
function fakeCam(){return {opened:0,closed:0,lastOpts:null,isOpen:()=>false,async open(o){this.opened++;this.lastOpts=o;},close(){this.closed++;}};}
test('DOM query typed prefix selects item and bare collision lists candidates without write',()=>{const {document:d,state}=setup(),before=JSON.stringify(state);d.getElementById('itmSearch').value='SAME';d.getElementById('itmSearchBtn').click();assert.match(d.getElementById('itmResults').textContent,/多个候选/);assert.equal(d.getElementById('itmResults').querySelectorAll('button').length,2);d.getElementById('itmSearch').value='ITM:SAME';d.getElementById('itmSearchBtn').click();assert.match(d.getElementById('itmResults').textContent,/数量：1/);assert.equal(JSON.stringify(state),before);});
test('DOM draft save/restore and double confirm persist exactly one command',async()=>{let draft=null,calls=0;const persistence={async saveDraft(id,value){draft={key:'itmDraft:'+id,value:structuredClone(value)};},async recover(){return {drafts:draft?[draft]:[],commands:[]};},async enqueue(){calls++;}};const {document:d,page}=setup(persistence);await page.accept('LOC:L-A');await page.accept('CTN:C-A');d.getElementById('itmDraftSave').click();await new Promise(r=>setImmediate(r));page.scan.reset();d.getElementById('itmDraftRestore').click();await new Promise(r=>setImmediate(r));assert.equal(page.scan.row().values.length,2);await page.accept('ITM:I-P');d.getElementById('itmConfirm').click();d.getElementById('itmConfirm').click();await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.match(d.getElementById('itmStatus').textContent,/本机已保存/);});
test('DOM IDB enqueue failure does not display completion and leaves retry available',async()=>{const {document:d,page}=setup({async enqueue(){throw Error('IDB写失败');}});for(const text of ['LOC:L-A','CTN:C-A','ITM:I-P'])await page.accept(text);d.getElementById('itmConfirm').click();await new Promise(r=>setImmediate(r));assert.match(d.getElementById('itmStatus').textContent,/IDB写失败/);assert.equal(page.scan.row().locked,false);assert.equal(d.getElementById('itmConfirm').disabled,false);});
test('work camera opens shared ScanCamera; confirm card fills input box, then user confirms into step',async()=>{const cam=fakeCam();const {document:d,page}=setup(null,cam);d.getElementById('itmCamera').click();await new Promise(r=>setImmediate(r));assert.equal(cam.opened,1);cam.lastOpts.onConfirm('LOC:L-A');await new Promise(r=>setImmediate(r));assert.equal(d.getElementById('itmCode').value,'LOC:L-A');assert.equal(page.scan.row().values.length,0);assert.match(d.getElementById('itmStatus').textContent,/已填入输入框/);d.getElementById('itmScanBtn').click();await new Promise(r=>setImmediate(r));assert.equal(page.scan.row().values.length,1);assert.equal(page.scan.row().values[0].code,'L-A');page.stopCamera();assert.equal(cam.closed,1);});
test('acceptGuided with expired token shows ignored status instead of lying about success',async()=>{const {document:d,page}=setup();const token=page.scan.token();page.scan.add('receive');await page.accept('LOC:L-A',token);assert.match(d.getElementById('itmStatus').textContent,/被忽略/);assert.doesNotMatch(d.getElementById('itmStatus').textContent,/已填写草稿/);});
test('query camera confirm fills query box only after user confirms',async()=>{const cam=fakeCam();const {document:d}=setup(null,cam);d.getElementById('itmSearchCamera').click();await new Promise(r=>setImmediate(r));assert.equal(cam.opened,1);cam.lastOpts.onConfirm('ITM:I-P');await new Promise(r=>setImmediate(r));assert.equal(d.getElementById('itmSearch').value,'ITM:I-P');assert.match(d.getElementById('itmResults').textContent,/part/);});
test('work describe rejects wrong-type code before filling',async()=>{const cam=fakeCam();const {document:d}=setup(null,cam);d.getElementById('itmCamera').click();await new Promise(r=>setImmediate(r));const verdict=cam.lastOpts.describe({text:'ITM:I-P',format:'条形码'});assert.equal(verdict.ok,false);assert.match(verdict.text,/库位/);});
test('admin activation UI queues controlled command without mutating legacy location',async()=>{let queued;const {document:d,state}=setup({async enqueue(r){queued=r;}});state.locations.push({code:'LEGACY',status:'unknown'});d.getElementById('itmAdminLoc').value='LEGACY';d.getElementById('itmActivateLoc').click();await new Promise(r=>setImmediate(r));assert.equal(queued.kind,'activateLocation');assert.equal(queued.expected.locationStatus,'unknown');assert.equal(state.locations.at(-1).status,'unknown');});
test('query scan cannot fill operation row; row table resolves APPLIED by opId',async()=>{const {document:d,page,state}=setup();const before=page.scan.snapshot();page.queryScan('ITM:I-P');assert.deepEqual(page.scan.snapshot(),before);assert.match(d.getElementById('itmResults').textContent,/数量：1/);for(const code of ['LOC:L-A','CTN:C-A','ITM:I-P'])await page.accept(code);const q=page.scan.lock();state.itemOperations=[{code:q.opId,phase:'APPLIED'}];page.render();assert.match(d.getElementById('itmRowTable').textContent,/已完成/);assert.equal(page.scan.row().locked,true);});
test('query camera error stays in visible query status and does not overwrite work status',async()=>{const {document:d}=setup();const work=d.getElementById('itmStatus').textContent;d.getElementById('itmSearchCamera').click();await new Promise(r=>setImmediate(r));assert.match(d.getElementById('itmSearchStatus').textContent,/查询失败|不可用/);assert.equal(d.getElementById('itmStatus').textContent,work);});
test('work UI translates kind, renders dynamic steps and mobile table labels',async()=>{const {document:d,page}=setup();assert.match(d.getElementById('itmStep').textContent,/入库.*目标库位/s);await page.accept('LOC:L-A');assert.match(d.getElementById('itmStep').textContent,/✓ 1 目标库位：L-A.*目标容器/s);const cells=[...d.getElementById('itmRowTable').querySelectorAll('td')];assert.deepEqual(cells.map(x=>x.getAttribute('data-th')),['行','库位','容器','物品','操作','状态']);assert.match(d.getElementById('itmRowTable').textContent,/入库/);assert.doesNotMatch(d.getElementById('itmStep').textContent,/行 \d+；/);});
test('search results are Chinese cards with translated state and separate status',()=>{const {document:d}=setup();d.getElementById('itmSearch').value='part';d.getElementById('itmSearchBtn').click();assert.equal(d.getElementById('itmResults').querySelectorAll('.itm-result-card').length,1);assert.match(d.getElementById('itmResults').textContent,/物品.*待入库/s);assert.match(d.getElementById('itmSearchStatus').textContent,/找到 1 条/);});
test('six operation types keep original sequences with distinct Chinese step guides',()=>{const {document:d,page}=setup();for(const [kind,count,label] of [['receive',3,'入库物品'],['issue',1,'出库物品（自动带出当前库位/容器）'],['transfer',3,'目标容器'],['moveContainer',2,'目标库位'],['placeContainer',2,'待定位容器'],['verifyLegacy',3,'旧物品']]){page.scan.add(kind);page.render();assert.equal(d.getElementById('itmStep').querySelectorAll('li').length,count);assert.match(d.getElementById('itmStep').textContent,new RegExp(label));assert.equal(d.getElementById('itmConfirm').disabled,true);}});
test('pending cards never auto-submit and preserve original command for explicit actions',async()=>{const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);const command={id:'uuid-long-original-command',status:'pending',request:{kind:'receive',itemCode:'I-P',target:{loc:'L-A',container:'C-A'}}};let submitted=0,queried=0;const page=UI.mount({document:d,getState:()=>({}),id:()=> 'id',getPersistence:()=>null,getCommands:async()=>[command],getClient:()=>({submit:async c=>{assert.equal(c,command);submitted++;return {phase:'APPLIED'};},query:async c=>{assert.equal(c,command);queried++;return {phase:'PREPARED'};}})});await page.pending();assert.equal(submitted,0);assert.equal(queried,0);const card=d.getElementById('itmPending').querySelector('article');assert.match(card.textContent,/入库 · 待提交/);assert.match(card.querySelector('.itm-meta').textContent,/uuid-long-original-command/);card.querySelector('button').click();await new Promise(r=>setImmediate(r));assert.equal(submitted,1);assert.equal(queried,0);d.getElementById('itmPending').querySelectorAll('button')[1].click();await new Promise(r=>setImmediate(r));assert.equal(queried,1);assert.match(d.getElementById('itmStatus').textContent,/已准备，待确认/);});
test('query missing codes and detail errors stay local without mutating state or drafts',()=>{const {document:d,page,state}=setup();const before=JSON.stringify(state),draft=page.scan.snapshot(),work=d.getElementById('itmStatus').textContent;page.queryScan('ITM:missing');assert.match(d.getElementById('itmSearchStatus').textContent,/未找到编码/);page.detail('items','missing');assert.match(d.getElementById('itmSearchStatus').textContent,/查询失败/);assert.equal(d.getElementById('itmStatus').textContent,work);assert.equal(JSON.stringify(state),before);assert.deepEqual(page.scan.snapshot(),draft);});
test('DOM location drilldown to container then item works via actual clicks',()=>{const {document:d,state}=setup();state.items[1]={...state.items[1],status:'in_stock',container:'C-A'};d.getElementById('itmSearch').value='LOC:L-A';d.getElementById('itmSearchBtn').click();d.getElementById('itmResults').querySelector('button').click();const buttons=[...d.getElementById('itmResults').querySelectorAll('button')];buttons.find(b=>b.textContent.includes('I-P')).click();assert.match(d.getElementById('itmResults').textContent,/C-A → L-A/);});
const tickN=async(n=6)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
function setupGuided(){const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document}=parseHTML(html);let n=0;const state={locations:[{code:'L-OLD',status:'unknown'},{code:'L-A',status:'active'}],containers:[{code:'C-OLD',loc:'L-A',status:'unknown',version:0}],items:[]};let queued=null,submitted=0;const persistence={async enqueue(r){queued=r;},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};let clientSubmit=null;const client={async submit(c){submitted++;if(clientSubmit)return clientSubmit(c);if(c.request.kind==='activateLocation')state.locations[0].status='active';if(c.request.kind==='activateContainer')state.containers[0].status='active';return {phase:'APPLIED',code:c.id};}};const page=UI.mount({document,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>queued?[{id:queued.opId,op:'itemOperation',request:queued}]:[],getClient:()=>client,id:()=>'guided-'+(++n)});return {document,state,page,get queued(){return queued},get submitted(){return submitted},set clientSubmit(f){clientSubmit=f;}};}
/* ================= 3.7.0 C1（单端直提）：扫到未启用实体自动核实启用，不再等人工点按钮 ================= */
test('guided activate: unknown LOC auto-activates without manual click and retries into step',async()=>{
 const s=setupGuided();const d=s.document,page=s.page;
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN(12);
 assert.match(d.getElementById('itmStatus').textContent,/自动核实启用|已启用|已填写草稿/,'扫码即自动启用（无需任何按钮）');
 assert.equal(s.queued&&s.queued.kind,'activateLocation');assert.equal(s.submitted,1);
 assert.deepEqual(page.scan.row().values.map(v=>v.code),['L-OLD'],'APPLIED后自动重试填入原步骤');
 assert.equal(d.getElementById('itmStatus').querySelector('button'),null,'全程零人工按钮');
});
test('guided activate: conflict-guard must not masquerade as missing LOC archive (user-reported regression)',async()=>{
 /* 3.2.2 用户实测：「库位未启用」→点「现场确认启用该库位并继续」→反而报「未找到该库位档案」。
    根因：entityStatus 用 U.unique——冲突守卫(UNRESOLVED_ENTITY_CONFLICT)先于 NOT_FOUND
    抛出、状态被吞成 null，真实存在的实体被判成查无此档。修复：读 expected 时对目标
    实体自身临时豁免冲突守卫（与域层 uniqueForActivation 同款语义）。 */
 const s=setupGuided();
 s.state.__itmConflicts={'locations:L-OLD':{reason:'server-snapshot-unverified',observed:{status:'unknown'}}};
 const d=s.document,page=s.page;
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN();
 const action=d.getElementById('itmStatus').querySelector('button');assert.ok(action,'未启用应提供引导按钮');
 action.click();await tickN(12);
 assert.doesNotMatch(d.getElementById('itmStatus').textContent,/未找到该库位档案/,'冲突堵死的实体不是查无此档');
 assert.equal(s.queued&&s.queued.kind,'activateLocation');
 assert.equal(s.queued&&s.queued.expected.locationStatus,'unknown','expected 取本地真实状态（豁免冲突守卫后读得到）');
 assert.deepEqual(page.scan.row().values.map(v=>v.code),['L-OLD'],'APPLIED后自动重试填入原步骤');
});
test('guided activate: conflict-guard must not masquerade as missing container archive',async()=>{
 const s=setupGuided();
 s.state.__itmConflicts={'containers:C-OLD':{reason:'unverified-controlled-change',observed:{version:0}}};
 const d=s.document,page=s.page;
 await page.accept('LOC:L-A');
 d.getElementById('itmCode').value='CTN:C-OLD';d.getElementById('itmScanBtn').click();await tickN();
 const action=d.getElementById('itmStatus').querySelector('button');assert.ok(action,'容器未启用应提供引导按钮');
 action.click();await tickN(12);
 assert.doesNotMatch(d.getElementById('itmStatus').textContent,/未找到该容器档案/,'冲突堵死的容器不是查无此档');
 assert.equal(s.queued&&s.queued.kind,'activateContainer');
 assert.equal(s.queued&&s.queued.expected.containerVersion,0,'expected.version 取本地真实版本（豁免冲突守卫后读得到）');
 assert.equal(s.submitted,1);
});
test('guided activate: genuinely missing archive still reports missing with recovery hints',async()=>{
 const s=setupGuided();
 const d=s.document;
 d.getElementById('itmCode').value='LOC:L-NOPE';d.getElementById('itmScanBtn').click();await tickN();
 /* NOT_FOUND 走 ITM 未建档分支之外的裸抛——直接调 guidedActivate 的兜底：없는实体 */
 assert.match(d.getElementById('itmStatus').textContent,/未识别|未启用|未找到/,'不存在的编码不得伪装成成功');
 assert.equal(s.submitted,0,'不得产生任何激活命令');
});
test('guided activate: unknown container auto-activates using current row LOC as target and resumes',async()=>{
 const s=setupGuided();const d=s.document,page=s.page;
 await page.accept('LOC:L-A');
 d.getElementById('itmCode').value='CTN:C-OLD';d.getElementById('itmScanBtn').click();await tickN(12);
 assert.match(d.getElementById('itmStatus').textContent,/自动核实启用|已启用|已填写草稿/,'容器未启用也自动启用');
 assert.equal(s.queued&&s.queued.kind,'activateContainer');assert.equal(s.queued&&s.queued.target.loc,'L-A');assert.equal(s.submitted,1);
 assert.deepEqual(page.scan.row().values.map(v=>v.code),['L-A','C-OLD']);
});
test('guided verify 并入入库：unknown 物品直接入库成功（旧物品核实入口已移除）',async()=>{
 const s=setupGuided();s.state.items.push({code:'WP-OLD',name:'旧物品'});
 s.state.containers[0].status='active';
 await s.page.accept('LOC:L-A');await s.page.accept('CTN:C-OLD');
 s.document.getElementById('itmCode').value='ITM:WP-OLD';s.document.getElementById('itmScanBtn').click();await tickN();
 assert.match(s.document.getElementById('itmStatus').textContent,/已填齐（草稿未提交|已填写草稿/);
 assert.equal(s.page.scan.row().values.length,3,'unknown 物品三步填齐');
 assert.equal(s.document.getElementById('itmStatus').querySelector('button'),null,'不再提供切换引导');
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
 assert.match(d.getElementById('itmStatus').textContent,/已填齐|已填写草稿/);
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
test('E1：手动码路径保留——填码即带码入队；在线即时提交（v3.4.0 R4）',async()=>{
 const s=setupE1(),d=s.document;
 pick(d,'itmRegisterCat','TS');
 d.getElementById('itmRegisterName').value='现场扫到的码';d.getElementById('itmRegisterCode').value='WP-999';
 d.getElementById('itmRegister').click();await tickN();
 assert.equal(s.queued.entity.code,'WP-999','手动码原样带上（规范形校验在服务端）');
 assert.equal(s.submitted&&s.submitted.request.entity.code,'WP-999','v3.4.0：在线即时提交（幂等低风险，不需要去待处理区手动执行）');
 assert.match(d.getElementById('itmRegisterResult').textContent,/已建档：WP-999/,'结果就地显示');
 assert.doesNotMatch(d.getElementById('itmRegisterResult').textContent,/已分配物品码/,'手动码不发号');
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

/* ================= 2.48.0：入库死端修复 ================= */
test('conflict-blocked fill offers guided activate instead of raw table:key error',async()=>{
 const s=setupGuided();const d=s.document,page=s.page;
 s.state.__itmConflicts={'locations:L-OLD':{table:'locations',key:'L-OLD',reason:'unverified-controlled-change',local:{code:'L-OLD',status:'unknown'},observed:{code:'L-OLD',status:'active'}}};
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN();
 const text=d.getElementById('itmStatus').textContent;
 assert.match(text,/未核验的云端变更|现场核实/,'错误必须可读，不得裸报 locations: 码');
 assert.doesNotMatch(text,/locations: L-OLD$/,'不得只有裸表名+码');
 const action=d.getElementById('itmStatus').querySelector('button');
 assert.ok(action,'冲突拦截也必须给出出口');
 // mock client 的 APPLIED 同时模拟真实 acknowledge 的副作用：凭据落地 → 冲突解除
 s.clientSubmit=()=>{delete s.state.__itmConflicts['locations:L-OLD'];s.state.locations[0].status='active';return {phase:'APPLIED',code:s.queued?s.queued.opId:'x'};};
 action.click();await tickN(12);
 assert.equal(s.queued&&s.queued.kind,'activateLocation','冲突路径同样生成核实启用命令');
 assert.deepEqual(s.page.scan.row().values.map(v=>v.code),['L-OLD'],'凭据落地后自动重填成功');
});
test('guided activate REJECTED (STATE_CONFLICT) reports rejection honestly without dead-end wording',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-OLD',status:'unknown'}],containers:[],items:[]};
 let queuedCmd=null;
 const persistence={async enqueue(r){queuedCmd=r;},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>queuedCmd?[{id:queuedCmd.opId,op:'itemOperation',request:queuedCmd}]:[],getClient:()=>({async submit(){return {phase:'REJECTED',error:'STATE_CONFLICT'};}}),id:()=>'g3-x'});
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN();
 const action=d.getElementById('itmStatus').querySelector('button');assert.ok(action);
 action.click();await tickN(12);
 const text=d.getElementById('itmStatus').textContent;
 assert.match(text,/启用被拒绝/,'如实说被拒绝');
 assert.match(text,/请核对现场状态后重试/,'给出下一步（v3.5.0：重试启用按钮就地重建，不再要求重新扫码）');
 assert.match(text,/重试启用/,'v3.5.0：就地重试按钮');
 assert.doesNotMatch(text,/启用结果待确认/,'不得再说「待确认」');
 assert.doesNotMatch(text,/请查询原命令/,'拒绝后卡已删除，不得指向查询');
});
test('retired entity shows plain notice without activate button',async()=>{
 const s=setupGuided();const d=s.document;
 s.state.locations[0]={code:'L-OLD',status:'retired'};
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN();
 const text=d.getElementById('itmStatus').textContent;
 assert.match(text,/已退役/);assert.equal(d.getElementById('itmStatus').querySelector('button'),null,'退役不得提供启用按钮');
});
test('guided activate REJECTED legacy mismatch offers override resubmit',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 let n=0,queued=null;
 const state={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-OLD',loc:'W-ELSEWHERE',status:'unknown',version:0}],items:[]};
 const persistence={async enqueue(r){queued=r;},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
 const client={async submit(){return {phase:'REJECTED',error:'LEGACY_LOCATION_CONFLICT'};}};
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>queued?[{id:queued.opId,op:'itemOperation',request:queued}]:[],getClient:()=>client,id:()=>'g2-'+(++n)});
 await page.accept('LOC:L-A');
 d.getElementById('itmCode').value='CTN:C-OLD';d.getElementById('itmScanBtn').click();await tickN();
 const action=d.getElementById('itmStatus').querySelector('button');
 assert.ok(action,'容器未启用有启用按钮');action.click();await tickN(12);
 const override=[...d.getElementById('itmStatus').querySelectorAll('button')].find(b=>b.textContent.includes('以现场扫描为准'));
 assert.ok(override,'REJECTED(LEGACY_LOCATION_CONFLICT) 应提供现场扫描为准重发');
 override.click();await tickN(12);
 assert.equal(queued.confirmLegacyLocOverride,true,'重发命令带现场确认覆盖标记');
 assert.doesNotMatch(d.getElementById('itmStatus').textContent,/请查询原命令/,'拒绝后不再指向已删除的卡');
});
test('pending card surfaces lastError and offers needs_attention retry (v3.5.0：同 opId 重放键已删)',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const command={id:'stuck-1',status:'needs_attention',lastError:'请求超时，结果未知，请查询原opId',request:{schemaVersion:1,opId:'stuck-1',kind:'registerItem',entity:{category:'TS',name:'示波器'}}};
 let submitted=0;
 const page=UI.mount({document:d,getState:()=>({}),id:()=>'id',getPersistence:()=>null,getCommands:async()=>[command],getClient:()=>({submit:async()=>{submitted++;return {phase:'APPLIED'};},query:async()=>({phase:'REPAIR_REQUIRED',error:'原命令未决'})})});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 assert.match(card.textContent,/上次结果：/,'核验卡必须显示真实失败原因');
 assert.match(card.textContent,/超时/);
 const btns=[...card.querySelectorAll('button')].map(b=>b.textContent);
 assert.ok(btns.some(t=>t==='重试（按最新数据）'),'v3.5.0：未决卡主键=重试（按最新数据），所有卡可达');
 assert.ok(btns.some(t=>t==='查询云端结果'),'只读查询保留');
 assert.ok(!btns.some(t=>t==='重新执行'),'同 opId 重放键已删（云端未决时它是死循环）');
});
test('work tab conflict banner lists blocked codes',()=>{
 const s=setupGuided();const d=s.document;
 s.state.__itmConflicts={'locations:L-OLD':{table:'locations',key:'L-OLD',reason:'unverified-controlled-change',local:{code:'L-OLD',status:'unknown'},observed:{code:'L-OLD',status:'active'}}};
 s.page.render();
 const banner=d.getElementById('itmConflictBanner');
 assert.equal(banner.hidden,false,'有冲突时横幅必须可见');
 assert.match(banner.textContent,/locations:L-OLD/);
 assert.match(banner.textContent,/现场核实并启用/,'横幅要给出出口说明');
});

test('confirm card on complete row says 已填齐 instead of 当前步骤需要undefined码',async()=>{
 const cam=fakeCam();const {document:d,page}=setup(null,cam);
 await page.accept('LOC:L-A');await page.accept('CTN:C-A');await page.accept('ITM:I-P');
 d.getElementById('itmCamera').click();await new Promise(r=>setImmediate(r));
 /* 用户实测场景：行已填齐后重扫物品短链 → 确认卡必须说清「无需再扫」，不得出现 undefined */
 const verdict=cam.lastOpts.describe({text:'HTTPS://MES.NEWENERGYCODER.CLUB/I/XW4QYARX',format:'二维码'});
 assert.equal(verdict.ok,false);
 assert.match(verdict.text,/本行步骤已填齐/);
 assert.match(verdict.text,/确认本行/,'要指明下一步动作');
 assert.doesNotMatch(verdict.text,/undefined/,'不得出现 undefined 字样');
 assert.equal(verdict.action,'本行已填齐，无需重扫','按钮不得误导为「类型不符，请重扫」');
 page.stopCamera();
});

/* ================= 2.49.2：草稿自动保存/恢复（刷新不再丢扫码行） ================= */
test('refresh auto-restores the latest unfinished draft row',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const saved={sessionId:'sess-7',rows:[{rowId:'r1',kind:'receive',generation:2,values:[{type:'LOC',code:'L-A',version:0}],locked:false,opId:null}],active:0,savedAt:1234};
 const persistence={async recover(){return{drafts:[{key:'itmDraft:sess-7',value:saved}],commands:[]};},async saveDraft(){},async enqueue(){}};
 const state={locations:[{code:'L-A',status:'active'}],containers:[],items:[]};
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>[],id:()=>'n'});
 await page.autoRestoreDraft();
 assert.deepEqual(page.scan.row().values.map(v=>v.code),['L-A'],'刷新后应恢复未完成的扫码行');
 assert.match(d.getElementById('itmStatus').textContent,/已自动恢复/);
 assert.match(d.getElementById('itmStep').textContent,/✓ 1 目标库位：L-A/);
});
test('auto-restore skips all-locked or empty drafts',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const saved={sessionId:'s9',rows:[{rowId:'r1',kind:'receive',generation:1,values:[{type:'LOC',code:'L-A',version:0}],locked:true,opId:'op-1'}],active:0,savedAt:9};
 let restored=false;
 const persistence={async recover(){return{drafts:[{key:'k',value:saved}],commands:[]};},saveDraft:async()=>{restored=true;}};
 const page=UI.mount({document:d,getState:()=>({locations:[],containers:[],items:[]}),getPersistence:()=>persistence,getCommands:async()=>[],id:()=>'n'});
 await page.autoRestoreDraft();
 assert.equal(page.scan.row().values.length,0,'锁定行已在待处理区，不再还原');
});
test('every render persists the session snapshot (auto-save)',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 let savedSnap=null;
 const persistence={async saveDraft(id,v){savedSnap=v;},async recover(){return{drafts:[],commands:[]}}};
 const page=UI.mount({document:d,getState:()=>({locations:[{code:'L-A',status:'active'}],containers:[],items:[]}),getPersistence:()=>persistence,getCommands:async()=>[],id:()=>'n'});
 await page.accept('LOC:L-A');
 await new Promise(r=>setImmediate(r));
 assert.ok(savedSnap,'render 应触发草稿自动保存');
 assert.equal(savedSnap.rows[0].values[0].code,'L-A');
 assert.ok(savedSnap.savedAt>0,'快照带时间戳供恢复时取最新');
 assert.match(d.getElementById('itmStatus').textContent,/已填写草稿/);
});
test('complete-row status explains that stock is untouched until confirm+submit',async()=>{
 const {document:d,page}=setup();
 await page.accept('LOC:L-A');await page.accept('CTN:C-A');await page.accept('ITM:I-P');
 assert.match(d.getElementById('itmStatus').textContent,/库存还没动/);
 assert.match(d.getElementById('itmStatus').textContent,/确认本行/);
});

test('conflicted entity detail renders read-only card with conflict info instead of empty failure',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-X',status:'unknown',desc:'X位'}],containers:[],items:[],
   __itmConflicts:{'locations:L-X':{table:'locations',key:'L-X',reason:'unverified-controlled-change',
     local:{code:'L-X',status:'unknown'},observed:{code:'L-X',status:'active'}}}};
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>null,getCommands:async()=>[],id:()=>'cf'});
 page.detail('locations','L-X');
 const box=d.getElementById('itmResults').innerText;
 assert.match(box,/待核实/,'冲突实体详情必须可见');
 assert.match(box,/未核验的云端变更/,'必须显示冲突说明');
 assert.match(box,/云端观察值/,'必须显示云端观察值供人工比对');
 assert.doesNotMatch(d.getElementById('itmSearchStatus').textContent,/查询失败/,'只读查询不得被冲突守卫拦成失败');
});

test('manual item code is canonicalized before enqueue (wp-ts-999 → WP-TS-999, shortlink intact)',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const LINK=require('../lib/item-link');d.defaultView.ItemLink=LINK;
 let queued=null;
 const page=UI.mount({document:d,getState:()=>({locations:[],containers:[],items:[]}),getPersistence:()=>({async enqueue(r){queued=r;},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}}),getCommands:async()=>[],id:()=>'c1',isOnline:()=>false,qrSvg:()=>''});
 pick(d,'itmRegisterCat','TS');
 d.getElementById('itmRegisterName').value='遥控器';
 d.getElementById('itmRegisterCode').value='wp-ts-777';
 d.getElementById('itmRegister').click();await tickN(4);
 assert.equal(queued.entity.code,'WP-TS-777','入队前规范形化，服务端必收且短链可用');
 assert.match(d.getElementById('itmRegisterResult').textContent,/已规范为标准写法/);
});

/* ================= BUG-C/D 修复回归（全链路实测报告 v3.1.1 发现） =================
   BUG-C：批量模式拒裸码，与 placeholder「WP-…」承诺矛盾——裸码按台账归属推断类型。
   BUG-D：批量命令入队后批量模式不退出，旧面板/sticky 遮挡单行作业。 */
function setupBatchCD(){const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document}=parseHTML(html);let n=0;const state={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'I-P',name:'part',status:'pending',version:0}]};let enqueued=null;const persistence={async enqueue(r){enqueued=r;},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};const page=UI.mount({document,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>[],id:()=>'cd-'+(++n)});const fill=async t=>{document.getElementById('itmCode').value=t;document.getElementById('itmScanBtn').click();await tickN();};return {document,state,page,fill,get enqueued(){return enqueued}};}

test('BUG-C 批量模式裸码兜底：裸库位/容器码锚定 + 裸 WP 码入批 + 未建档裸码仍拒',async()=>{
 const {document:d,page,fill}=setupBatchCD();
 d.getElementById('itmBatchStart-receive').click();await tickN();
 await fill('L-A');                                    /* 裸库位码（无 LOC: 前缀） */
 assert.equal(page.scan.batchState()._loc.code,'L-A');
 await fill('C-A');                                    /* 裸容器码 */
 assert.equal(page.scan.batchState().anchor.loc,'L-A');
 assert.equal(page.scan.batchState().anchor.ctn,'C-A');
 page.scan.setBatchQty(1);
 await fill('i-p');                                    /* 裸物品码（小写也命中） */
 assert.match(d.getElementById('itmStatus').textContent,/I-P 已入批/);
 await fill('NOPE-404');                               /* 未建档裸码仍明确拒绝 */
 assert.match(d.getElementById('itmStatus').textContent,/无法识别编码/);
});

test('BUG-D 批量提交入队后自动退出批量模式，单行作业界面恢复',async()=>{
 const {document:d,page,fill,enqueued:_e}=setupBatchCD();
 d.getElementById('itmBatchStart-receive').click();await tickN();
 await fill('LOC:L-A');await fill('CTN:C-A');
 page.scan.setBatchQty(1);
 await fill('ITM:I-P');
 d.getElementById('itmConfirm').click();await tickN();   /* 批量模式下 = 提交本批 */
 assert.equal(page.scan.batchState(),null,'命令入队后批量会话必须结束');
 assert.match(d.getElementById('itmStatus').textContent,/已退出批量模式/);
 assert.equal(d.getElementById('itmConfirm').textContent,'确认本行，保存待提交','确认键恢复单行语义');
 assert.equal(d.getElementById('itmBatchAbandon').style.display,'none','放弃本批按钮收起');
});

/* ================= 阶段B 查询页改造回归（用户反馈「只知道名称、找不到东西在哪」） =================
   ① 结果卡直接带位置摘要（不必逐条点详情）② 空查询不再全表渲染
   ③ 每张表按自己真实字段匹配（库位 kind / 容器 loc / 物品 category·materialCode）
   ④ 多关键词 AND + 物品优先排序 + 上限 */
function setupSearch(){
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document}=parseHTML(html);
 const state={
  locations:[{code:'L-A',status:'active',kind:'货架库位',desc:'A区角钢货架'},{code:'W01-G01',status:'active',kind:'工位收纳格',desc:'1号工位'}],
  containers:[{code:'C-A',loc:'L-A',status:'active',type:'收纳盒',spec:'32×25×34cm',version:2},{code:'C-B',loc:'',status:'active',type:'零件盒',spec:'小',version:1}],
  items:[
   {code:'WP-TS-001',name:'内六角扳手',spec:'M3',category:'TS',status:'pending',version:1},
   {code:'WP-GJ-001',name:'螺丝刀',spec:'十字 PH2',category:'GJ',status:'in_stock',container:'C-A',version:2}]
 };
 const page=UI.mount({document,getState:()=>state,getPersistence:()=>null,getCommands:async()=>[],id:()=>'x'});
 return {document,state,page};
}
test('B-1：按名称模糊查找，结果卡直接带位置摘要（不必逐条点详情）',()=>{
 const {document:d}=setupSearch();
 d.getElementById('itmSearch').value='内六角';d.getElementById('itmSearchBtn').click();
 const cards=d.getElementById('itmResults').querySelectorAll('.itm-result-card');
 assert.equal(cards.length,1,'名称命中唯一物品');
 assert.match(d.getElementById('itmResults').textContent,/物品 · 内六角扳手/);
 assert.match(d.getElementById('itmSearchStatus').textContent,/找到 1 条/);
});
test('B-1：在库物品的结果卡显示 容器 → 库位',()=>{
 const {document:d}=setupSearch();
 d.getElementById('itmSearch').value='螺丝刀';d.getElementById('itmSearchBtn').click();
 assert.match(d.getElementById('itmResults').textContent,/位置：当前 C-A → L-A/,'结果卡必须带容器→库位，不用点详情');
});
test('B-1：按说明搜库位时结果卡显示容器数与在库件数',()=>{
 const {document:d}=setupSearch();
 d.getElementById('itmSearch').value='角钢货架';d.getElementById('itmSearchBtn').click();
 assert.equal(d.getElementById('itmResults').querySelectorAll('.itm-result-card').length,1,'按 desc 命中库位');
 assert.match(d.getElementById('itmResults').textContent,/位置：容器 1 个 · 在库单件 1/,'库位卡应给出容器数与在库件数');
});
test('B-2：空查询给引导，不再把全表渲染成卡片',()=>{
 const {document:d}=setupSearch();
 d.getElementById('itmSearch').value='   ';d.getElementById('itmSearchBtn').click();
 assert.equal(d.getElementById('itmResults').querySelectorAll('.itm-result-card').length,0,'空查询禁止全表渲染（扫码枪误触回车曾卡死移动端）');
 assert.match(d.getElementById('itmSearchStatus').textContent,/请输入名称、规格、分类或编码/);
 assert.match(d.getElementById('itmResults').textContent,/按名称查找/);
});
test('B-3：库位类型 kind / 容器库位 loc / 物品分类 category 均可检索',()=>{
 const {document:d}=setupSearch();
 const qv=v=>{d.getElementById('itmSearch').value=v;d.getElementById('itmSearchBtn').click();return d.getElementById('itmResults').textContent;};
 assert.match(qv('货架库位'),/L-A/,'locations.kind 此前不在匹配字段里');
 assert.match(qv('L-A'),/C-A/,'反查容器（containers.loc 此前不在匹配字段里）');
 assert.match(qv('TS'),/内六角扳手/,'按分类查物品（items.category 此前不在匹配字段里）');
});
test('B-4：多关键词 AND 命中 + 物品优先于容器库位',()=>{
 const {document:d}=setupSearch();
 d.getElementById('itmSearch').value='扳手 M3';d.getElementById('itmSearchBtn').click();
 assert.match(d.getElementById('itmResults').textContent,/内六角扳手/,'两个词都命中才返回');
 assert.match(d.getElementById('itmSearchStatus').textContent,/找到 1 条/);
 d.getElementById('itmSearch').value='A';d.getElementById('itmSearchBtn').click();
 const titles=[...d.getElementById('itmResults').querySelectorAll('.itm-result-card h3')].map(h=>h.textContent);
 assert.ok(titles.length>=2);
 assert.match(titles[0],/^容器 ·/,'物品>容器>库位：容器必须排在库位之前');
 assert.ok(titles.findIndex(t=>/^库位/.test(t))>titles.findIndex(t=>/^容器/.test(t)),'库位排最后');
});

/* ================= P1a：批量模式容器未启用自动启用，目标=批量锚点库位（用户实测误报「请先扫描库位码」） ================= */
test('P1a 批量锚点已扫：未启用容器自动启用，以批量锚点库位为目标，不再误报缺库位',async()=>{
 const s=setupGuided();const d=s.document,page=s.page;
 page.scan.startBatch('receive');
 d.getElementById('itmCode').value='LOC:L-A';d.getElementById('itmScanBtn').click();await tickN();   /* 批量库位锚点（active）——走用户真实路径 itmScanBtn→acceptGuided→acceptBatchCode */
 assert.match(d.getElementById('itmStatus').textContent,/库位锚点 L-A/);
 d.getElementById('itmCode').value='CTN:C-OLD';d.getElementById('itmScanBtn').click();await tickN(12);
 assert.doesNotMatch(d.getElementById('itmStatus').textContent,/请先扫描该容器所在的库位码/,'批量锚点已定，不得再要求扫库位');
 assert.equal(s.queued&&s.queued.kind,'activateContainer');
 assert.equal(s.queued&&s.queued.target.loc,'L-A','目标库位=批量锚点（旧实现在当前行 values 找不到 LOC 直接抛错）');
 assert.deepEqual(page.scan.batchState()&&page.scan.batchState().anchor,{loc:'L-A',ctn:'C-OLD',ctnVersion:0},'APPLIED后自动重试锚点容器成功');
});

/* ================= P1b：屏障/版本拒绝的批量命令整批重建（旧实现只重建第一行→一批拆成一件） ================= */
test('P1b 版本类拒绝的批量命令：重建按钮解锁全部行并重建为一条 N 件批量命令',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'I-P',name:'p',status:'pending',version:0},{code:'I-Q',name:'q',status:'pending',version:0}],itemOperations:[]};
 const oldOpId='batch-op-1';
 const queuedAll=[{id:oldOpId,op:'itemOperation',status:'unknown',lastError:'提交结果未知：TRIAL_PRECONDITION_CHANGED: 版本过期',request:{schemaVersion:1,opId:oldOpId,kind:'receiveBatch',target:{loc:'L-A'},items:[{itemCode:'I-P',containerCode:'C-A',expectedItemVersion:0,expectedContainerVersion:2},{itemCode:'I-Q',containerCode:'C-A',expectedItemVersion:0,expectedContainerVersion:2}]}}];
 const submitted=[];
 const persistence={async enqueue(r){queuedAll.push({id:r.opId,op:'itemOperation',request:r});},async recover(){return{drafts:[],commands:[]}},async abandonCommand(id){const i=queuedAll.findIndex(c=>c.id===id);if(i>=0)queuedAll.splice(i,1);}};
 let n=0;
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>queuedAll,
  getClient:()=>({submit:async c=>{submitted.push(structuredClone(c.request));return {phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request};}}),
  id:()=>'new-'+(++n),refreshConflicts:async()=>{}});
 /* 扫码会话：两行已锁定到旧批量 opId（模拟被拒后的现场） */
 page.scan.restore({sessionId:'s1',active:0,batch:null,rows:[
  {rowId:'r1',kind:'receive',generation:1,locked:true,opId:oldOpId,values:[{type:'LOC',code:'L-A',version:0},{type:'CTN',code:'C-A',version:2},{type:'ITM',code:'I-P',version:0}]},
  {rowId:'r2',kind:'receive',generation:1,locked:true,opId:oldOpId,values:[{type:'LOC',code:'L-A',version:0},{type:'CTN',code:'C-A',version:2},{type:'ITM',code:'I-Q',version:0}]}]});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const btns=[...card.querySelectorAll('button')];
 const rebuild=btns.find(b=>b.textContent.includes('重试（按最新数据）'));
 assert.ok(rebuild,'版本类拒绝的批量卡必须提供重建入口');
 rebuild.click();await tickN(10);
 assert.equal(submitted.length,1,'只提交一轮（P2a：不再 8 轮退避）');
 const req=submitted[0];
 assert.equal(req.kind,'receiveBatch','重建后仍是一条批量命令（旧实现变成单件 receive）');
 assert.equal(req.items.length,2,'N 件仍是 N 件');
 assert.notEqual(req.opId,oldOpId,'换新 opId');
 assert.equal(queuedAll.find(c=>c.id===oldOpId),undefined,'旧命令已 abandon');
 const locked=page.scan.snapshot().rows.filter(r=>r.locked);
 assert.equal(locked.length,0,'APPLIED 后整批行移除');
});

/* ================= P4：在线确认后自动提交；离线保持待处理区手动提交 ================= */
test('P4 在线时确认本行后自动提交一次；离线时只入队不提交',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'I-P',name:'p',status:'pending',version:0}],itemOperations:[]};
 const enqueued=[];let submitted=0;
 const persistence={async enqueue(r){enqueued.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:enqueued.map(r=>({id:r.opId,op:'itemOperation',request:r}))}}};
 const mk=(online)=>UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>enqueued.map(r=>({id:r.opId,op:'itemOperation',request:r})),
   getClient:()=>({submit:async c=>{submitted++;return {phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request};}}),
   isOnline:()=>online,id:()=>'p4-'+enqueued.length});
 /* 在线：确认 → 自动提交（无需去待处理区手动点） */
 const p1=mk(true);
 for(const t of ['LOC:L-A','CTN:C-A','ITM:I-P'])await p1.accept(t);
 d.getElementById('itmConfirm').click();await tickN(12);
 assert.equal(enqueued.length,1);assert.equal(submitted,1,'在线确认后必须自动提交');
 assert.match(d.getElementById('itmStatus').textContent,/远端已确认/);
 assert.equal(p1.scan.snapshot().rows.filter(r=>r.locked).length,0,'APPLIED 后行已清（可直接下一笔）');
 /* 离线：确认 → 只入队，命令留在待处理区 */
 enqueued.length=0;submitted=0;
 const p2=mk(false);
 for(const t of ['LOC:L-A','CTN:C-A','ITM:I-P'])await p2.accept(t);
 d.getElementById('itmConfirm').click();await tickN(12);
 assert.equal(enqueued.length,1);assert.equal(submitted,0,'离线不得自动提交');
 assert.match(d.getElementById('itmStatus').textContent,/当前离线/);
});

/* ================= P3c（3.7.0 C1 改写）：本地未启用但云端凭据已到 → 自动启用直达成功，无需人工出口 ================= */
test('P3c 本地已有 APPLIED 启用日志但状态未落地：扫码自动启用成功，全程零按钮',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 let n=0,refreshed=0,stored=null;
 const state={locations:[{code:'L-OLD',status:'unknown'}],containers:[],items:[],
  itemOperations:[{code:'act-1',kind:'activateLocation',phase:'APPLIED',containerCode:'',after:{locations:[{code:'L-OLD',status:'active'}]}}]};
 const persistence={async enqueue(r){stored=r;},async abandonCommand(){},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>stored?[{id:stored.opId,op:'itemOperation',request:stored}]:[],getClient:()=>({async submit(c){state.locations[0].status='active';return {phase:'APPLIED',code:c.id};}}),
  id:()=>'p3c-'+(++n),refreshConflicts:async()=>{refreshed++;state.locations[0].status='active';}});
 page.scan.add('receive');
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN(12);
 assert.equal(s0Buttons(d),null,'C1 后报错卡不再需要任何人工按钮（云端幂等启用直达成功）');
 assert.match(d.getElementById('itmStatus').textContent,/已填写草稿|已启用/,'自动启用后原步骤继续');
});
function s0Buttons(d){return d.getElementById('itmStatus').querySelector('button');}

/* ================= F2（v3.2.4 / 3.7.0 C1+C5）：版本类/状态类拒绝自动重建重提，无按钮无人工 ================= */
test('F2 激活命令版本类被拒：自动重拉换新 opId 重试一次，不再推用户去待处理区',async()=>{
 const s=setupGuided();const d=s.document,page=s.page;
 let calls=0;s.clientSubmit=async c=>{calls++;
  if(calls===1)return {phase:'REJECTED',code:c.id,error:'TRIAL_CONCURRENT_OPERATION_DETECTED'};
  s.state.locations[0].status='active';return {phase:'APPLIED',code:c.id};};
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN(20);
 assert.equal(s.submitted,2,'首拒后自动换新 opId 重试一次');
 assert.match(d.getElementById('itmStatus').textContent,/已启用|已填写草稿|目标库位/,'重试成功继续原流程');
 assert.doesNotMatch(d.getElementById('itmStatus').textContent,/待处理区查询原命令/,'不再把用户推进待处理区');
 assert.deepEqual(page.scan.row().values.map(v=>v.code),['L-OLD']);
});
test('F2 重建后再被拒：如实报「启用被拒绝」，不无限循环',async()=>{
 const s=setupGuided();const d=s.document;
 let calls=0;s.clientSubmit=async c=>{calls++;return {phase:'REJECTED',code:c.id,error:'VERSION_CONFLICT'};};
 d.getElementById('itmCode').value='LOC:L-OLD';d.getElementById('itmScanBtn').click();await tickN(20);
 assert.equal(s.submitted,2,'只自动重试一次');
 assert.match(d.getElementById('itmStatus').textContent,/启用被拒绝/,'第二次拒绝如实呈现');
});

/* ================= F3（v3.2.4）：激活类命令卡的重建按钮（lastError 保留错误码后可达） ================= */
test('F3 激活卡版本类被拒：重建按钮可达，点击后 abandon 旧命令并按最新数据重发',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-OLD',loc:'L-A',status:'unknown',version:0}],items:[],itemOperations:[]};
 const oldId='act-old';
 const cards=[{id:oldId,op:'itemOperation',status:'needs_attention',lastError:'TRIAL_CONCURRENT_OPERATION_DETECTED｜本命令已放弃：与早前未完成的命令冲突（可能是你上一步超时的命令，并非其他设备）。可点「按最新数据重试」，或重新扫码',
  request:{schemaVersion:1,opId:oldId,kind:'activateContainer',containerCode:'C-OLD',target:{loc:'L-A'},expected:{containerVersion:0}}}];
 const enqueued=[];const abandoned=[];
 const persistence={async enqueue(r){enqueued.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}},async abandonCommand(id){abandoned.push(id);}};
 let n=0;const submitted=[];
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>cards.concat(enqueued.map(r=>({id:r.opId,op:'itemOperation',request:r}))),
  getClient:()=>({submit:async c=>{submitted.push(structuredClone(c.request));state.containers[0].status='active';return {phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request};}}),
  id:()=>'rebuild-'+(++n),refreshConflicts:async()=>{}});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const rebuild=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('重试（按最新数据）'));
 assert.ok(rebuild,'lastError 保留错误码后重建按钮必须可达（v3.2.3 回归：文案覆写错误码致按钮永不出现）');
 rebuild.click();await tickN(12);
 /* v3.4.0 R2：guidedActivate 入队前的同实体清理与重建按钮自身的 abandon 各删一次同一 id——abandonCommand 幂等，去重后恰一条 */
 assert.deepEqual([...new Set(abandoned)],[oldId],'旧命令已收走');
 const req=enqueued[0];
 assert.equal(req.kind,'activateContainer','激活类重建 = 重取最新实体状态生成新激活命令');
 assert.notEqual(req.opId,oldId,'换新 opId');
 assert.equal(submitted.length,1,'重建后自动提交一轮');
 assert.match(d.getElementById('itmStatus').textContent,/已启用|已填写草稿|目标库位/);
});

/* ================= F1 配套：可重建拒绝不丢扫码行绑定 ================= */
test('F1 retryable 拒绝经待处理区提交后行绑定保留（重建按钮要靠 opId 找回行）',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'I-P',name:'p',status:'pending',version:0}],itemOperations:[]};
 const oldOpId='row-op-1';
 const cards=[{id:oldOpId,op:'itemOperation',status:'pending',request:{schemaVersion:1,opId:oldOpId,kind:'receive',itemCode:'I-P',target:{loc:'L-A',container:'C-A'},expected:{itemVersion:0,containerVersion:2}}}];
 const persistence={async enqueue(r){},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
 let n=0;
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>cards,
  getClient:()=>({submit:async c=>({phase:'REJECTED',code:c.id,error:'VERSION_CONFLICT',retryable:true,request:c.request})}),
  id:()=>'keep-'+(++n)});
 page.scan.restore({sessionId:'s1',active:0,batch:null,rows:[
  {rowId:'r1',kind:'receive',generation:1,locked:true,opId:oldOpId,values:[{type:'LOC',code:'L-A',version:0},{type:'CTN',code:'C-A',version:2},{type:'ITM',code:'I-P',version:0}]}]});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const submit=[...card.querySelectorAll('button')].find(b=>b.textContent==='执行');
 submit.click();await tickN(8);
 const row=page.scan.snapshot().rows.find(r=>r.opId===oldOpId);
 assert.ok(row,'retryable 拒绝后行绑定必须保留（旧实现 forget 掉行 → 重建按钮报「找不到扫码行」）');
});

/* ================= C1/C2/C3（v3.3.1）：待处理区死锁根治——全状态作废/收口通用化/取消补解锁 =================
   用户实测：上次会话把启用命令提交到待处理区后没同意，本次继续操作时命令堆叠、
   卡删不掉（取消按钮只对 pending 状态渲染）、扫码行锁死 → 死锁。 */
function setupPendingCards(cards,opts={}){
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state=Object.assign({locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'I-P',name:'p',status:'pending',version:0}],itemOperations:[]},opts.state||{});
 const abandoned=[];const acknowledged=[];
 const persistence={async enqueue(){},async saveDraft(){},async recover(){return{drafts:[],commands:[]}},
  async abandonCommand(id){abandoned.push(id);},
  async acknowledge(r){acknowledged.push(r);},
  async markUnknown(){}};
 let n=0;
 const page=UI.mount({document:d,getState:()=>state,getPersistence:()=>persistence,getCommands:async()=>cards,
  getClient:()=>({submit:async c=>({phase:'APPLIED',code:c.id,request:c.request}),
   /* 模拟 item-client.call 的终态语义：APPLIED/REJECTED → acknowledge（落凭据+清卡） */
   query:async c=>{const r=opts.query?opts.query(c):{phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request};if(['APPLIED','REJECTED'].includes(r.phase))await persistence.acknowledge(r);return r;},
   settle:async opId=>opts.settle?opts.settle(opId):{phase:'APPLIED',code:opId}}),
  id:()=>'pc-'+(++n),refreshConflicts:opts.refreshConflicts});
 if(opts.row)page.scan.restore({sessionId:'s1',active:0,batch:null,rows:[opts.row]});
 return {d,page,abandoned,acknowledged,persistence};
}
test('C1 卡死的未决命令卡可作废：按钮可达，点击后删卡+解锁扫码行',async t=>{
 const oldConfirm=global.confirm;global.confirm=()=>true;t.after(()=>{global.confirm=oldConfirm;});
 const opId='stuck-ctn';
 const {d,page,abandoned}=setupPendingCards([
  {id:opId,op:'itemOperation',status:'needs_attention',lastError:'提交超时且自动查询未获终态：云端仍在处理',
   request:{schemaVersion:1,opId,kind:'activateContainer',containerCode:'C-A',target:{loc:'L-A'},expected:{containerVersion:2}}}],
  {row:{rowId:'r1',kind:'activate',generation:1,locked:true,opId,values:[{type:'LOC',code:'L-A',version:0},{type:'CTN',code:'C-A',version:2}]}});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const discard=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('删除记录'));
 assert.ok(discard,'needs_attention 卡必须提供作废出口（旧实现只有 pending 卡能取消）');
 discard.click();await tickN();
 assert.deepEqual(abandoned,[opId],'命令卡已从本机删除');
 assert.ok(!page.scan.snapshot().rows.some(r=>r.opId===opId),'扫码行已解锁/移除，不再「本行已锁定」死锁');
 assert.match(d.getElementById('itmStatus').textContent,/已删除记录/);
});
test('v3.5.0 C2：未决卡不再提供 settle/重放入口——主键=重试（按最新数据），死亡按钮全部移除',async t=>{
 const oldConfirm=global.confirm;let confirmed=0;global.confirm=()=>{confirmed++;return true;};t.after(()=>{global.confirm=oldConfirm;});
 const opId='undecided-1';
 let settled=null;
 const {d,page}=setupPendingCards([
  {id:opId,op:'itemOperation',status:'needs_attention',lastError:'结果待确认',
   request:{schemaVersion:1,opId,kind:'receive',itemCode:'I-P',target:{loc:'L-A',container:'C-A'},expected:{itemVersion:0,containerVersion:2}}}],
  {settle:op=>{settled=op;return {phase:'APPLIED',code:op};}});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const btns=[...card.querySelectorAll('button')].map(b=>b.textContent);
 assert.ok(btns.some(x=>x==='重试（按最新数据）'),'未决卡主键=重试（按最新数据）');
 assert.ok(!btns.some(x=>x.includes('核对云端实际状态')),'settle 键已删（operator 必 403，且 confirm 被吞后是死按钮）');
 assert.ok(!btns.some(x=>x==='重新执行'),'同 opId 重放键已删');
 assert.equal(settled,null,'不提供 settle 入口');
});
test('v3.5.0 C2：REPAIR_REQUIRED 卡单击直接删除（无 confirm——用户环境 confirm 被吞导致按钮失效的根因）',async t=>{
 const oldConfirm=global.confirm;let confirmed=0;global.confirm=()=>{confirmed++;return true;};t.after(()=>{global.confirm=oldConfirm;});
 const opId='repair-1';
 const {d,page,abandoned}=setupPendingCards([
  {id:opId,op:'itemOperation',status:'needs_attention',lastError:'写入中断｜人工收口：实体实际状态与目标快照不一致',
   request:{schemaVersion:1,opId,kind:'activateContainer',containerCode:'C-A',target:{loc:'L-A'},expected:{containerVersion:2}}}],
  {});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const discard=[...card.querySelectorAll('button')].find(b=>b.textContent==='删除记录');
 assert.ok(discard,'删除记录按钮可达');
 discard.click();await tickN();
 assert.equal(confirmed,0,'v3.5.0：不再弹任何 confirm');
 assert.deepEqual(abandoned,[opId],'单击直接删除本机记录');
 assert.match(d.getElementById('itmStatus').textContent,/已删除记录/);
});
test('C3 pending 卡手动取消后扫码行解锁（不再绕回「本行已锁定」）',async t=>{
 const oldConfirm=global.confirm;global.confirm=()=>true;t.after(()=>{global.confirm=oldConfirm;});
 const opId='pending-row-1';
 const {d,page,abandoned}=setupPendingCards([
  {id:opId,op:'itemOperation',status:'pending',
   request:{schemaVersion:1,opId,kind:'receive',itemCode:'I-P',target:{loc:'L-A',container:'C-A'},expected:{itemVersion:0,containerVersion:2}}}],
  {row:{rowId:'r1',kind:'receive',generation:1,locked:true,opId,values:[{type:'LOC',code:'L-A',version:0},{type:'CTN',code:'C-A',version:2},{type:'ITM',code:'I-P',version:0}]}});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const cancel=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('删除记录'));
 assert.ok(cancel,'pending 卡保留取消入口');
 cancel.click();await tickN();
 assert.deepEqual(abandoned,[opId]);
 assert.ok(!page.scan.snapshot().rows.some(r=>r.opId===opId),'取消后行解锁（旧实现只删卡不解锁行）');
});
test('C1 retryable 拒绝卡：作废与重建并存，作废后不再保留行绑定',async t=>{
 const oldConfirm=global.confirm;global.confirm=()=>true;t.after(()=>{global.confirm=oldConfirm;});
 const opId='retry-row-1';
 const {d,page,abandoned}=setupPendingCards([
  {id:opId,op:'itemOperation',status:'needs_attention',
   lastError:'VERSION_CONFLICT｜数据刚被更新（可能来自你上一步操作）',
   request:{schemaVersion:1,opId,kind:'receive',itemCode:'I-P',target:{loc:'L-A',container:'C-A'},expected:{itemVersion:0,containerVersion:2}}}],
  {row:{rowId:'r1',kind:'receive',generation:1,locked:true,opId,values:[{type:'LOC',code:'L-A',version:0},{type:'CTN',code:'C-A',version:2},{type:'ITM',code:'I-P',version:0}]}},
  );
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const btns=[...card.querySelectorAll('button')].map(b=>b.textContent);
 assert.ok(btns.some(x=>x==='重试（按最新数据）'),'重建按钮不受影响（F1/F3 语义保留）');
 assert.ok(btns.some(x=>x.includes('删除记录')),'作废与重建并存——不想重建时可以放弃');
 const discard=[...card.querySelectorAll('button')].find(b=>b.textContent.includes('删除记录'));
 discard.click();await tickN();
 assert.deepEqual(abandoned,[opId]);
 assert.ok(!page.scan.snapshot().rows.some(r=>r.opId===opId),'作废即放弃跟踪，行绑定解除');
});
test('v3.3.2 并发 pending() 不叠卡：两次调用交错后同一条命令只渲染一张',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const cards=[{id:'dup-1',op:'itemOperation',status:'pending',
  request:{schemaVersion:1,opId:'dup-1',kind:'activateLocation',locationCode:'L-A',expected:{locationStatus:'unknown'}}}];
 let calls=0;
 const persistence={async enqueue(){},async saveDraft(){},async abandonCommand(){},async recover(){calls++;await new Promise(r=>setTimeout(r,calls===1?30:1));return{drafts:[],commands:structuredClone(cards)};}};
 const page=UI.mount({document:d,getState:()=>({locations:[{code:'L-A',status:'active'}],containers:[],items:[]}),
  getPersistence:()=>persistence,getCommands:async()=>(await persistence.recover()).commands,
  getClient:()=>({submit:async c=>({phase:'APPLIED',code:c.id,request:c.request}),query:async c=>({phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request})}),
  id:()=>'dup'});
 const p1=page.pending();await new Promise(r=>setImmediate(r));   /* P1 挂起在 getCommands 上 */
 const p2=page.pending();await Promise.all([p1,p2]);await tickN();
 assert.equal(d.querySelectorAll('#itmPending article').length,1,'并发渲染必须收敛为一张卡（旧写法叠成两张，用户看到「命令堆积」）');
 assert.equal(d.querySelectorAll('#itmPending article button').length,3,'按钮不得翻倍（提交/查询/取消）');
});
test('v3.3.2 提交失败落卡后待处理区必须刷新（不再停留在旧 pending 卡）',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const command={id:'fail-1',op:'itemOperation',status:'pending',
  request:{schemaVersion:1,opId:'fail-1',kind:'activateLocation',locationCode:'L-A',expected:{locationStatus:'unknown'}}};
 let unknownSaved=null;
 const persistence={async enqueue(){},async saveDraft(){},async abandonCommand(){},
  async recover(){return {drafts:[],commands:[command]};},
  async markUnknown(id,msg){unknownSaved={id,msg};command.status='needs_attention';command.lastError=msg;}};
 const page=UI.mount({document:d,getState:()=>({locations:[{code:'L-A',status:'active'}],containers:[],items:[]}),
  getPersistence:()=>persistence,getCommands:async()=>[command],
  getClient:()=>({submit:async c=>{await persistence.markUnknown(c.id,'操作接口拒绝');throw Error('操作接口拒绝');},query:async c=>({phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request})}),
  id:()=>'fail'});
 await page.pending();
 const card=d.getElementById('itmPending').querySelector('article');
 const submit=[...card.querySelectorAll('button')].find(b=>b.textContent==='执行');
 submit.click();await tickN(10);
 assert.ok(unknownSaved,'item-client 已 markUnknown');
 const btns=[...d.getElementById('itmPending').querySelectorAll('article button')].map(b=>b.textContent);
 assert.ok(btns.some(t=>t==='重试（按最新数据）'),'失败刷新后应看到 needs_attention 卡的新主键（旧实现停在旧 pending 卡）');
 assert.ok(btns.some(t=>t==='删除记录'),'删除出口随刷新出现');
});

/* ================= v3.4.0：启用/建档即时化 + 同实体去重 + 文案简化 ================= */
function setupActivateUI(opts={}){
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state=Object.assign({locations:[{code:'L-X',status:'unknown'}],containers:[{code:'C-X',loc:'L-X',status:'unknown',version:0}],items:[]},opts.state||{});
 const preCards=opts.preCards||[];
 const enqueued=[];const submitted=[];const abandoned=[];
 const persistence={async enqueue(r){enqueued.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}},async abandonCommand(id){abandoned.push(id);}};
 const page=UI.mount({document:d,state,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>preCards.concat(enqueued.map(r=>({id:r.opId,op:'itemOperation',request:r,status:'pending'}))),
  getClient:()=>({submit:async c=>{submitted.push(structuredClone(c.request));return {phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request};},
   query:async c=>({phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request})}),
  id:()=>'act-'+(enqueued.length+1),isOnline:()=>opts.online!==false,refreshConflicts:async()=>{}});
 return {d,page,enqueued,submitted,abandoned,state};
}
test('v3.4.0 R1：核实启用（库位）在线即时提交并就地显示「已启用」',async()=>{
 const s=setupActivateUI();
 s.d.getElementById('itmAdminLoc').value='L-X';
 s.d.getElementById('itmActivateLoc').click();await tickN(8);
 assert.equal(s.submitted.length,1,'在线时直接提交，不再只入队等用户去待处理区手动执行');
 assert.equal(s.submitted[0].kind,'activateLocation');
 assert.match(s.d.getElementById('itmRegisterResult').textContent,/已启用 L-X/,'结果镜像到建档管理页（itmStatus 在物品作业页，建档页用户看不见）');
});
test('v3.4.0 R1：核实启用（容器）用面板目标库位即时提交',async()=>{
 const s=setupActivateUI();
 s.d.getElementById('itmAdminLoc').value='L-X';s.d.getElementById('itmAdminContainer').value='C-X';
 s.d.getElementById('itmActivateContainer').click();await tickN(8);
 assert.equal(s.submitted.length,1,'容器启用同样即时提交');
 assert.deepEqual(s.submitted[0].target,{loc:'L-X'},'目标库位=面板填写的 itmAdminLoc（guidedActivate 的 opts.targetLoc 覆盖）');
});
test('v3.4.0 R1：核实启用离线时仅入队并如实提示',async()=>{
 const s=setupActivateUI({online:false});
 s.d.getElementById('itmAdminLoc').value='L-X';
 s.d.getElementById('itmActivateLoc').click();await tickN(8);
 assert.equal(s.submitted.length,0,'离线不提交');
 assert.equal(s.enqueued.length,1,'离线仍入队（联网后自动提交或在待处理区执行）');
 assert.match(s.d.getElementById('itmRegisterResult').textContent,/当前离线/);
});
test('v3.4.0 R2：启用前自动删除同实体旧未决卡（杜绝「一个命令两个审核」）',async()=>{
 const s=setupActivateUI({preCards:[{id:'old-act',op:'itemOperation',status:'needs_attention',lastError:'结果待确认',
  request:{schemaVersion:1,opId:'old-act',kind:'activateLocation',locationCode:'L-X',expected:{locationStatus:'unknown'}}}]});
 s.d.getElementById('itmAdminLoc').value='L-X';
 s.d.getElementById('itmActivateLoc').click();await tickN(8);
 assert.deepEqual(s.abandoned,['old-act'],'同 kind 同实体的旧卡入队前被自动替换');
 assert.equal(s.submitted.length,1,'新命令照常即时提交');
});
test('v3.4.0 R4：库位建档在线即时提交，APPLIED 后显示「已建档」',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[],containers:[],items:[]};
 const enqueued=[];const submitted=[];
 const persistence={async enqueue(r){enqueued.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
 const page=UI.mount({document:d,state,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>enqueued.map(r=>({id:r.opId,op:'itemOperation',request:r,status:'pending'})),
  getClient:()=>({submit:async c=>{submitted.push(c.request);return {phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request};}}),
  id:()=>'reg-'+(enqueued.length+1),isOnline:()=>true,qrSvg:t=>'QR['+t+']'});
 pick(d,'itmRegisterType','registerLocation');
 d.getElementById('itmRegisterName').value='A 区 1 层';
 d.getElementById('itmRegisterCode').value='L-NEW';
 d.getElementById('itmRegister').click();await tickN(8);
 assert.equal(submitted.length,1,'建档在线即时提交（幂等低风险）');
 assert.equal(submitted[0].kind,'registerLocation');
 assert.match(d.getElementById('itmRegisterResult').textContent,/已建档：L-NEW/,'结果就地显示');
});
test('v3.4.0 R4：库位建档离线时仅入队',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[],containers:[],items:[]};
 const enqueued=[];const submitted=[];
 const persistence={async enqueue(r){enqueued.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
 const page=UI.mount({document:d,state,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>enqueued.map(r=>({id:r.opId,op:'itemOperation',request:r,status:'pending'})),
  getClient:()=>({submit:async c=>{submitted.push(c.request);return {phase:'APPLIED',code:c.id,kind:c.request.kind,request:c.request};}}),
  id:()=>'rego-'+(enqueued.length+1),isOnline:()=>false,qrSvg:t=>'QR['+t+']'});
 pick(d,'itmRegisterType','registerLocation');
 d.getElementById('itmRegisterName').value='A 区 1 层';
 d.getElementById('itmRegisterCode').value='L-NEW';
 d.getElementById('itmRegister').click();await tickN(8);
 assert.equal(submitted.length,0,'离线不提交');
 assert.equal(enqueued.length,1,'离线仍入队');
 assert.match(d.getElementById('itmRegisterResult').textContent,/已保存/);
});
test('v3.4.0 R3：摘要行零计数类目不显示（「需人工核验 0」噪音根除）',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const command={id:'sum-1',status:'pending',request:{kind:'receive',itemCode:'I-P',target:{loc:'L-A',container:'C-A'}}};
 const page=UI.mount({document:d,getState:()=>({}),id:()=>'id',getPersistence:()=>null,getCommands:async()=>[command],getClient:()=>({submit:async()=>({phase:'APPLIED'}),query:async()=>({phase:'PREPARED'})})});
 await page.pending();
 const sum=d.getElementById('itmPending').querySelector('.itm-pending-summary').textContent;
 assert.match(sum,/待提交 1/);
 assert.doesNotMatch(sum,/需人工核验/,'零计数不再出现');
 assert.doesNotMatch(sum,/已完结/,'零计数不再出现');
});

/* ================= v3.5.0 P2：启用发后不管——失败路径待处理区零残留 ================= */
test('v3.5.0 P2：启用提交异常 → 本机卡被删除 + 就地「重试启用」按钮',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-X',status:'unknown'}],containers:[{code:'C-X',loc:'L-X',status:'unknown',version:0}],items:[]};
 const enqueued=[];const abandoned=[];let submitted=0;
 const persistence={async enqueue(r){enqueued.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}},async abandonCommand(id){abandoned.push(id);}};
 const page=UI.mount({document:d,state,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>enqueued.filter(r=>!abandoned.includes(r.opId)).map(r=>({id:r.opId,op:'itemOperation',request:r,status:'pending'})),
  getClient:()=>({submit:async()=>{submitted++;throw Error('Failed to fetch');}}),
  id:()=>'fa-'+(enqueued.length+1),isOnline:()=>true,refreshConflicts:async()=>{}});
 d.getElementById('itmAdminLoc').value='L-X';
 d.getElementById('itmActivateLoc').click();await tickN(8);
 assert.equal(submitted,1,'在线即时提交');
 assert.deepEqual(abandoned,[enqueued[0].opId],'v3.5.0：失败后本机卡被删除（待处理区零残留）');
 assert.match(d.getElementById('itmRegisterResult').textContent,/启用命令提交失败/,'就地报错');
 assert.match(d.getElementById('itmRegisterResult').textContent,/重试启用/,'就地「重试启用」按钮（镜像自状态行）');
 assert.equal(d.getElementById('itmPending').querySelectorAll('article').length,0,'待处理区没有任何启用卡');
});
test('v3.5.0 P2：启用返回「原命令未决」→ 本机卡被删除 + 就地重试（不再推进待处理区死循环）',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-X',status:'unknown'}],containers:[{code:'C-X',loc:'L-X',status:'unknown',version:0}],items:[]};
 const enqueued=[];const abandoned=[];
 const persistence={async enqueue(r){enqueued.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}},async abandonCommand(id){abandoned.push(id);}};
 const page=UI.mount({document:d,state,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>enqueued.filter(r=>!abandoned.includes(r.opId)).map(r=>({id:r.opId,op:'itemOperation',request:r,status:'needs_attention'})),
  getClient:()=>({submit:async()=>({phase:'REPAIR_REQUIRED',code:'x',error:'原命令未决，不能自动重发'})}),
  id:()=>'fr-'+(enqueued.length+1),isOnline:()=>true,refreshConflicts:async()=>{}});
 d.getElementById('itmAdminLoc').value='L-X';
 d.getElementById('itmActivateLoc').click();await tickN(8);
 assert.deepEqual(abandoned,[enqueued[0].opId],'未决返回同样删本机卡');
 assert.match(d.getElementById('itmStatus').textContent,/云端仍在处理.*自动核对/,'如实告知云端在处理');
 const btn=[...d.getElementById('itmStatus').querySelectorAll('button')].find(b=>b.textContent==='重试启用');
 assert.ok(btn,'就地「重试启用」');
});
test('v3.5.0 P2：版本类重建轮仍拒 → 本机卡被删除 + 就地重试（旧实现留 retryable 卡）',async()=>{
 const {parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{document:d}=parseHTML(html);
 const state={locations:[{code:'L-X',status:'unknown'}],containers:[{code:'C-X',loc:'L-X',status:'unknown',version:0}],items:[]};
 const enqueued=[];const abandoned=[];let calls=0;
 const persistence={async enqueue(r){enqueued.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}},async abandonCommand(id){abandoned.push(id);},
  async markUnknown(){},async acknowledge(){}};
 const page=UI.mount({document:d,state,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>enqueued.map(r=>({id:r.opId,op:'itemOperation',request:r,status:'pending'})),
  getClient:()=>({submit:async c=>{calls++;const c2={...c,request:c.request};if(calls===1)return {phase:'REJECTED',code:c.id,kind:c.request.kind,request:c.request,error:'VERSION_CONFLICT',retryable:true};return {phase:'REJECTED',code:c.id,kind:c.request.kind,request:c.request,error:'VERSION_CONFLICT',retryable:true};}}),
  id:()=>'fv-'+(enqueued.length+1),isOnline:()=>true,refreshConflicts:async()=>{}});
 // mock item-client 语义：REJECTED retryable → markUnknown 保留卡（模拟 finishTerminal）
 d.getElementById('itmAdminLoc').value='L-X';
 d.getElementById('itmActivateLoc').click();await tickN(10);
 assert.ok(calls>=2,'版本类拒绝触发自动重建重试一轮');
 assert.match(d.getElementById('itmStatus').textContent,/启用被拒绝/,'重建轮仍拒如实报');
 const btn=[...d.getElementById('itmStatus').querySelectorAll('button')].find(b=>b.textContent==='重试启用');
 assert.ok(btn,'就地「重试启用」');
});
