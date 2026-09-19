(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./unique-items'),require('./item-scan'));else root.ItemUI=factory(root.UniqueItems,root.ItemScan);})(typeof globalThis!=='undefined'?globalThis:this,function(U,Scan){
'use strict';
function mount({document:doc,getState,getPersistence,getCommands,id,mediaDevices,getClient,refreshConflicts,scanCamera,isOnline,qrSvg}){
 const el=n=>doc.getElementById(n),scan=Scan.create({getState,id});scan.add('receive');
 const status=text=>{el('itmStatus').textContent=text;};
 const searchStatus=text=>{el('itmSearchStatus').textContent=text;};
 /* 阶段B：统一扫码浮层。生产从 window.ScanCamera 取（按 document 共享单例）；
    测试注入 scanCamera 假组件验证接线，相机生命周期由 scan-camera 自己负责。 */
 function getScanCamera(){if(scanCamera)return scanCamera;const win=doc.defaultView;if(!win||!win.ScanCamera)return null;return win.ScanCamera.forDocument({document:doc,win,mediaDevices});}
 /* 确认卡摘要：先按码值找命中对象；作业页还要按当前步骤校验类型，不符禁止确定。 */
 function entitySummary(type,code){try{const st=getState(),r=U.unique(st,{LOC:'locations',CTN:'containers',ITM:'items'}[type],code);return types[type]+' '+code+' · '+(r.name||r.desc||r.spec||'');}catch(e){return {LOC:'库位',CTN:'容器',ITM:'物品'}[type]+' '+code+'（未建档）';}}
 function describeHit(hit){const raw=String(hit.text).trim();const win=doc.defaultView,LL=win&&win.ItemLink;const link=LL&&LL.parseScanText(raw);if(link)return entitySummary('ITM',link.code)+'（物品二维码）';const m=raw.match(/^(LOC|CTN|ITM)[:|](.+)$/);if(!m)return {text:'识别为'+hit.format+'，但内容没有类型前缀，查询时请确认编码'};return entitySummary(m[1],m[2]);}
 function describeWorkHit(hit){const r=scan.row(),expected=Scan.sequences[r.kind][r.values.length];let raw=String(hit.text).trim();const win=doc.defaultView,LL=win&&win.ItemLink;const link=LL&&LL.parseScanText(raw);if(link)raw='ITM:'+link.code;const m=raw.match(/^(LOC|CTN|ITM)[:|](.+)$/);
  if(!m){
   if(expected==='ITM'&&/^WP-[A-Za-z0-9_-]+$/.test(raw)){try{U.unique(getState(),'items',raw);return entitySummary('ITM',raw)+'（条形码）';}catch(e){return {text:'条形码 '+raw+' 未建档，不能确定填入',ok:false};}}
   return {text:'识别到'+hit.format+'内容「'+raw+'」，当前步骤需要'+types[expected]+'码',ok:false};}
  if(m[1]!==expected)return {text:'识别到的是'+types[m[1]]+'码「'+m[2]+'」，当前步骤需要'+types[expected]+'码',ok:false};
  return entitySummary(m[1],m[2]);}
 const types={locations:'库位',containers:'容器',items:'物品',LOC:'库位',CTN:'容器',ITM:'物品'};
 const kinds={receive:'入库',issue:'出库',transfer:'换箱',moveContainer:'容器移库',placeContainer:'容器定位',verifyLegacy:'旧物品核实',activateLocation:'核实启用库位',activateContainer:'核实启用容器',registerItem:'物品建档',registerLocation:'库位建档',registerContainer:'容器建档',retire:'物品退役'};
 const states={active:'已启用',disabled:'已停用',inactive:'已停用',pending:'待入库',out:'已出库',in_stock:'在库',unknown:'待核实',retired:'已退役',PREPARED:'已准备，待确认',APPLIED:'已完成',REJECTED:'已拒绝',UNKNOWN:'结果待确认',unknown_commit:'结果待确认',needs_attention:'需人工核验'};
 const kindLabel=value=>kinds[value]||'待核实操作';
 const stateLabel=value=>states[value]||'状态待核实';
 const errZh={LEGACY_LOCATION_CONFLICT:'实物位置与档案旧库位不一致',CONTAINER_LOCATION_MISMATCH:'容器与库位归属不符',INVALID_TRANSITION:'当前状态不允许该操作',NOT_FOUND:'未找到对应档案',SOURCE_MISMATCH:'来源与记录不符',VERSION_CONFLICT:'数据刚被更新过，请刷新后重试',FORBIDDEN:'当前身份无权执行',STATE_CONFLICT:'状态冲突，请刷新后重试',CODE_ALREADY_REGISTERED:'编码已存在',ITM_HAS_NO_QTY:'唯一物品没有数量字段',UNSUPPORTED_CONTRACT:'请求格式不受支持',ALREADY_PLACED:'容器已定位',NO_CHANGE:'位置没有变化',
  /* E1（§三.2）：服务端发号/手动码校验的中文文案 */
  SERIAL_EXHAUSTED:'该分类序号已用尽，请联系管理员扩位',NON_CANONICAL_ITEM_CODE:'物品码写法不规范（应为 WP-分类-三位序号，如 WP-TS-001），不规范码没有短链',DUPLICATE_SHORTLINK_IDENTITY:'该码与已有物品的短链身份冲突（同分类同序号的不同写法），请核对实物后改码',BAD_CATEGORY:'物品分类无效，请选择八类之一'};
 function errText(e){const code=(e&&typeof e==='object'&&e.code)||'';const raw=typeof e==='string'?e:(e&&e.message)||String(e);if(code&&errZh[code])return errZh[code]+'（'+code+'）';for(const k in errZh)if(raw.includes(k))return errZh[k]+'（'+k+'）';return raw;}
 const stepLabels={receive:['目标库位','目标容器','入库物品'],issue:['来源库位','来源容器','出库物品'],transfer:['来源库位','来源容器','待换箱物品','目标库位','目标容器'],moveContainer:['来源库位','待移动容器','目标库位'],placeContainer:['目标库位','待定位容器'],verifyLegacy:['核实库位','核实容器','旧物品']};
 function card(parent,title){const section=doc.createElement('article');section.className='itm-result-card';const h=doc.createElement('h3');h.textContent=title;section.appendChild(h);parent.appendChild(section);return section;}
 function meta(parent,text){const p=doc.createElement('p');p.className='itm-meta';p.textContent=text;parent.appendChild(p);}
 function candidate(parent,table,r){const section=card(parent,types[table]+' · '+(r.name||r.desc||r.spec||'未命名'));line(section,r.code);line(section,'状态：'+stateLabel(r.status));section.appendChild(button('查看'+types[table]+'详情',()=>detail(table,r.code)));}
 function button(text,action){const b=doc.createElement('button');b.type='button';b.className='btn ghost';b.textContent=text;b.addEventListener('click',action);return b;}
 function line(parent,text){const p=doc.createElement('p');p.textContent=text;parent.appendChild(p);}
 function detail(table,code){const results=el('itmResults');results.replaceChildren();searchStatus('查询详情 · 只读，不改变库存');try{
 const st=getState(),r=U.unique(st,table,code),box=card(results,types[table]+' · '+(r.name||r.desc||r.spec||'未命名'));line(box,code);line(box,'状态：'+stateLabel(r.status));
 if(table==='items'){const pos=U.currentPosition(st,code);line(box,'规格：'+(r.spec||'')+'；数量：1；版本：'+r.version);line(box,pos.container?'当前 '+pos.container.code+' → '+pos.location.code:(pos.legacy?'旧定位，容器待核实：':'当前不在库；历史线索：')+pos.historicalLoc);if(pos.container)box.appendChild(button('容器 '+pos.container.code,()=>detail('containers',pos.container.code)));
 (st.itemOperations||[]).filter(o=>o.itemCode===code||(o.after&&o.after.items||[]).some(i=>i.code===code)).forEach(o=>{line(box,kindLabel(o.kind)+' · '+stateLabel(o.phase));meta(box,'操作编号：'+o.code);});
 }else if(table==='containers'){line(box,'当前库位：'+(r.loc||'未定位'));if(r.loc)box.appendChild(button('库位 '+r.loc,()=>detail('locations',r.loc)));const items=(st.items||[]).filter(i=>i.status==='in_stock'&&i.container===code);line(box,'在库单件：'+items.length);items.forEach(i=>box.appendChild(button(i.code+' '+(i.name||''),()=>detail('items',i.code))));
 }else{const cs=(st.containers||[]).filter(c=>c.loc===code);line(box,'容器数：'+cs.length+'；在库单件：'+(st.items||[]).filter(i=>i.status==='in_stock'&&cs.some(c=>c.code===i.container)).length);cs.forEach(c=>box.appendChild(button(c.code,()=>detail('containers',c.code))));(st.items||[]).filter(i=>i.status==='unknown'&&i.loc===code).forEach(i=>box.appendChild(button('旧定位未绑定 '+i.code,()=>detail('items',i.code))));}
 if(st.__itmConflicts&&st.__itmConflicts[table+':'+code])line(box,'⚠ 关系冲突，暂停作业');
 meta(box,'同步时间：'+(st.__savedAt||'待同步'));
 }catch(e){searchStatus('查询失败：'+e.message);}}
 function search(){let q=el('itmSearch').value.trim();const box=el('itmResults');box.replaceChildren();
  /* D2（§六待修③）：手输/扫码枪回车也先过 resolveLinkText —— 整条 /i/8位 短链或裸 8 位码
     都归一成物品码再查（相机确认卡走的 queryScan 已有此归一，这里补齐手输入口）。
     归一后回写输入框，让用户看见系统把短链认成了哪个物品码。 */
  const resolved=resolveLinkText(q);if(resolved!==q){q=resolved;el('itmSearch').value=resolved;}
  try{const st=getState();const typed=q.match(/^(LOC|CTN|ITM)[:|](.+)$/);const tables=typed?[{LOC:'locations',CTN:'containers',ITM:'items'}[typed[1]]]:['locations','containers','items'];const key=typed?typed[2]:q;const exact=tables.flatMap(table=>(st[table]||[]).filter(r=>r.code===key).map(r=>({table,r})));if(exact.length===1){detail(exact[0].table,key);return;}if(exact.length>1){searchStatus('编码有多个候选，请按类型选择；同表重复码禁止作业');line(box,'编码有多个候选，请按类型选择');exact.forEach(({table,r})=>candidate(box,table,r));return;}if(typed){searchStatus('该类型未找到编码：'+key);return;}
 let count=0;for(const table of ['locations','containers','items'])for(const r of st[table]||[])if(!q||[r.code,r.name,r.spec,r.desc,r.type].some(v=>String(v||'').toLowerCase().includes(q.toLowerCase()))){candidate(box,table,r);count++;}searchStatus(count?'找到 '+count+' 条记录 · 仅查询，不改变库存':'未找到匹配记录，请核对编码或换个关键词。');}catch(e){searchStatus('查询失败：'+e.message);}}
 const recoveryResults=new Map();
 function reviewPanels(){
  const st=getState(),box=el('itmRecoveryReview');box.replaceChildren();
  const commands=Array.isArray(st.__itmRecoveryReview?.commands)?st.__itmRecoveryReview.commands:[];
  line(box,'导入含待复核命令 '+commands.length+' 条，未自动重发；查询仅展示，不更新本机实体或队列。');
  commands.forEach(c=>{const opId=c.id||c.request?.opId;const section=doc.createElement('div');meta(section,'原命令编号：'+(opId||'缺失，禁止查询'));const pre=doc.createElement('pre');pre.textContent=JSON.stringify(c,null,2);section.appendChild(pre);if(typeof opId==='string'&&opId&&getClient)section.appendChild(button('只读查询原命令结果',()=>run(async()=>{const result=await getClient().inspect(opId);recoveryResults.set(opId,result);reviewPanels();})));if(recoveryResults.has(opId)){const out=doc.createElement('pre');out.textContent='查询结果（未应用）：'+JSON.stringify(recoveryResults.get(opId),null,2);section.appendChild(out);}box.appendChild(section);});
  const conflicts=el('itmConflictPanel');conflicts.replaceChildren();const entries=Object.entries(st.__itmConflicts||{});line(conflicts,'未解冲突 '+entries.length+' 个；暂停相关作业。重拉仅核验，不能任选本地/远端覆盖。');
  entries.forEach(([key,c])=>{line(conflicts,'对象：'+key+'；原因：'+(c.reason||'待核验'));const pre=doc.createElement('pre');pre.textContent=JSON.stringify({local:c.local,observed:c.observed},null,2);conflicts.appendChild(pre);});
 }
 el('itmConflictRefresh').addEventListener('click',()=>run(async()=>{if(!refreshConflicts)throw Error('请在同步页只读拉取并检查日志，不要推送覆盖');await refreshConflicts();reviewPanels();status('重拉检查完成；仍未解冲突继续阻断，请核对实物/操作凭据');}));
 function render(){
  reviewPanels();const snapshot=scan.snapshot(),r=scan.row(),body=el('itmRowTable');body.replaceChildren();
  snapshot.rows.forEach((entry,index)=>{const tr=doc.createElement('tr');const operation=(getState().itemOperations||[]).find(o=>o.code===entry.opId);const rowStatus=operation?(operation.phase==='REJECTED'?'已拒绝：'+(operation.error||'请重新建行'):stateLabel(operation.phase)):entry.locked?'待提交/待确认':'草稿';const values=[String(index+1),entry.values.filter(v=>v.type==='LOC').map(v=>v.code).join(' → ')||'—',entry.values.filter(v=>v.type==='CTN').map(v=>v.code).join(' → ')||'—',entry.values.find(v=>v.type==='ITM')?.code||'—',kindLabel(entry.kind),rowStatus];values.forEach((value,i)=>{const td=doc.createElement('td');td.setAttribute('data-th',['行','库位','容器','物品','操作','状态'][i]);td.textContent=value;tr.appendChild(td);});tr.tabIndex=0;tr.setAttribute('aria-selected',String(index===snapshot.active));const select=()=>{stopCamera();scan.select(index);render();};tr.addEventListener('click',select);tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});body.appendChild(tr);});
  el('itmRows').replaceChildren();snapshot.rows.forEach((row,index)=>{const o=doc.createElement('option');o.value=String(index);o.textContent='第 '+(index+1)+' 行 · '+kindLabel(row.kind)+(row.locked?' · 已锁定':' · 草稿');o.selected=index===snapshot.active;el('itmRows').appendChild(o);});
  const step=el('itmStep'),labels=stepLabels[r.kind],sequence=Scan.sequences[r.kind];step.replaceChildren();line(step,'第 '+(snapshot.active+1)+' 行 · '+kindLabel(r.kind)+' · '+(['moveContainer','placeContainer'].includes(r.kind)?'整容器作业':'物品数量固定1'));
  const list=doc.createElement('ol');labels.forEach((label,index)=>{const li=doc.createElement('li');li.textContent=(r.values[index]?'✓ ':'')+(index+1)+' '+label+(r.values[index]?'：'+r.values[index].code:'');if(index===r.values.length)li.setAttribute('aria-current','step');list.appendChild(li);});step.appendChild(list);
  line(step,r.locked?'本行已锁定，请在待处理区提交或查询原命令。':r.values.length===sequence.length?'步骤已填齐，请核对后确认；确认仅保存待提交命令。':'当前请填写：'+labels[r.values.length]+'（'+sequence[r.values.length]+':）');
  el('itmCode').placeholder=r.values.length<sequence.length?'扫描或输入 '+sequence[r.values.length]+': 编码':'本行已填齐，请核对后确认';el('itmConfirm').disabled=r.locked||r.values.length!==sequence.length;
  /* E1「去入库」：入库行走到物品步骤且输入框为空时，自动带入刚建档的新码 */
  if(prefillItem&&r.kind==='receive'&&!r.locked&&sequence[r.values.length]==='ITM'){const inp=el('itmCode');if(!inp.value)inp.value='ITM:'+prefillItem;}
 }
 async function run(action){try{await action();render();}catch(e){status(errText(e));}}
 function accept(text,token){return run(()=>{scan.accept(text,token);el('itmCode').value='';if(prefillItem&&scan.row().values.some(v=>v.type==='ITM'&&v.code===prefillItem))prefillItem=null;status('已填写草稿，尚未提交');});}
 /* 首次核实引导：旧库位/容器状态为 unknown 时，填入会被领域层拦截（正确），
    但用户实测「点了没反应、流程断掉」。这里在错误旁给出一键动作：
    生成 activateLocation/activateContainer 命令 → 提交 → APPLIED 后自动重试填入。 */
 function statusAction(text,btnText,fn){const box=el('itmStatus');box.textContent=text+' ';const b=button(btnText,()=>run(fn));box.appendChild(b);}
 async function guidedActivate(type,code,retry){
  const p=getPersistence();if(!p)throw Error('IDB不可用，不能核实启用');
  if(!getClient)throw Error('当前不支持在线提交，请稍后在待处理区提交');
  const st=getState();let request;
  if(type==='LOC'){const loc=U.unique(st,'locations',code);request={schemaVersion:1,opId:id(),kind:'activateLocation',locationCode:loc.code,expected:{locationStatus:loc.status}};}
  else{const c=U.unique(st,'containers',code);const locValue=(scan.row().values||[]).find(v=>v.type==='LOC');if(!locValue)throw Error('请先扫描该容器所在的库位码');request={schemaVersion:1,opId:id(),kind:'activateContainer',containerCode:c.code,target:{loc:locValue.code},expected:{containerVersion:c.version}};}
  status('已生成核实启用命令，正在提交…');render();
  await p.enqueue(request);await pending();
  const cmds=await getCommands();const cmd=(cmds||[]).find(x=>x.id===request.opId);
  if(!cmd)throw Error('命令未保存，请到待处理区检查');
  const result=await getClient().submit(cmd);
  if(result&&result.phase==='APPLIED'){status('已启用 '+code+'，正在继续填入…');await pending();await retry();}
  else status('启用结果待确认（'+stateLabel(result&&result.phase)+'），请在待处理区查询原命令，勿重复操作');
 }
 function acceptGuided(text,token){return run(async()=>{
  if(!String(text||'').trim()){status('请先用「相机扫码」（识别后在弹出的确认卡里点「确定填入」），或手动输入编码');return;}
  try{scan.accept(text,token);el('itmCode').value='';if(prefillItem&&scan.row().values.some(v=>v.type==='ITM'&&v.code===prefillItem))prefillItem=null;status('已填写草稿，尚未提交');}
  catch(e){
   const msg=(e&&e.message)||String(e);
   /* D2（§六待修④）：建档/核实引导先归一短链 —— 扫整条 /i/8位 短链或裸 8 位码时原文没有
      ITM: 前缀，不归一就匹配不上引导分支、静默抛错（scan.accept 内部已做同款归一，这里只为分支判断）。 */
   const win=doc.defaultView,LL=win&&win.ItemLink;let norm=String(text).trim();const link=LL&&LL.parseScanText(norm);if(link)norm='ITM:'+link.code;
   const m=norm.match(/^(LOC|CTN|ITM)[:|](.+)$/);
   if(m&&m[1]==='LOC'&&/未启用|未核实/.test(msg)){statusAction(msg,'现场确认启用该库位并继续',()=>guidedActivate('LOC',m[2],()=>acceptGuided(text,token)));return;}
   if(m&&m[1]==='CTN'&&/未启用|未核实/.test(msg)){statusAction(msg,'现场确认启用该容器并继续',()=>guidedActivate('CTN',m[2],()=>acceptGuided(text,token)));return;}
   if(m&&m[1]==='ITM'&&(/NOT_FOUND|不存在/.test(msg)||(e&&e.code)==='NOT_FOUND')){statusAction('该物品码未建档：'+m[2],'以该码建档（先注册，确认后重新入库）',()=>{const det=el('itmRegister').closest('details');if(det)det.open=true;const t=el('itmRegisterType');chooseOption(t,'registerItem');el('itmRegisterCode').value=m[2];syncRegisterType();const adv=el('itmRegisterAdvanced');if(adv)adv.open=true;status('已把 '+m[2]+' 带入建档区（高级·手动编码），确认后请重新按步骤扫码');});return;}
   if(m&&m[1]==='ITM'&&/尚待核实|不能重复入库/.test(msg)&&scan.row().kind==='receive'){statusAction(msg,'旧物品先核实：点此切换为「旧物品核实」作业，再按库位→容器→物品重扫',()=>{const sel=el('itmKind');for(const o of sel.options)o.selected=o.value==='verifyLegacy';stopCamera();scan.add('verifyLegacy');status('已切换为旧物品核实，请按步骤重新扫码；本行会沿用实物现场确认结果');});return;}
   throw e;
  }
 });}
 el('itmSearchBtn').addEventListener('click',search);el('itmSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();search();}});
 el('itmNewRow').addEventListener('click',()=>run(()=>{stopCamera();prefillItem=null;scan.add(el('itmKind').value);}));
 el('itmRows').addEventListener('change',()=>run(()=>{stopCamera();scan.select(Number(el('itmRows').value));}));
 el('itmReset').addEventListener('click',()=>run(()=>{stopCamera();scan.reset();}));
 el('itmScanBtn').addEventListener('click',()=>acceptGuided(el('itmCode').value));
 el('itmCode').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();acceptGuided(el('itmCode').value);}});
 el('itmDraftSave').addEventListener('click',()=>run(async()=>{const p=getPersistence();if(!p)throw Error('IDB不可用，草稿仅临时保留');await p.saveDraft(scan.snapshot().sessionId,scan.snapshot());status('草稿已保存本机');}));
 el('itmDraftRestore').addEventListener('click',()=>run(async()=>{const p=getPersistence();if(!p)throw Error('IDB不可用');const recovered=await p.recover();const drafts=recovered.drafts.filter(d=>d.value&&Array.isArray(d.value.rows));if(!drafts.length)throw Error('没有可恢复草稿');scan.restore(drafts[drafts.length-1].value);status('已恢复草稿；锁定命令须查询原opId，不自动重发');}));
 el('itmConfirm').addEventListener('click',()=>run(async()=>{if(scan.row().locked)return;const p=getPersistence();if(!p)throw Error('IDB不可用，不能提交');const request=scan.lock();render();try{await p.enqueue(request,scan.snapshot().sessionId,scan.snapshot());}catch(e){scan.unlock();render();throw e;}status('本机已保存，待提交；不代表业务完成');await pending();}));
 async function pending(){const box=el('itmPending');box.replaceChildren();const commands=await getCommands();if(!commands.length)line(box,'暂无待处理命令。完成步骤并确认后，会显示在这里。');for(const c of commands){const request=c.request||{},section=card(box,kindLabel(request.kind)+' · '+(c.status==='pending'?'待提交':c.status==='unknown'?'结果待确认':stateLabel(c.status)));
  /* P6（§三.2）：无码 registerItem（服务端发号建档）本地没有码可显示，明示「待发号」而非「待核实」 */
  const autoReg=request.kind==='registerItem'&&request.entity&&(request.entity.code==null||request.entity.code==='');
  line(section,'对象：'+(autoReg?'物品建档 · '+(request.entity.category||'?')+' · 待发号（提交后分配物品码）':(request.itemCode||request.containerCode||request.locationCode||request.entity?.code||'待核实')));if(request.source)line(section,'来源：'+[request.source.loc,request.source.container].filter(Boolean).join(' → '));if(request.target)line(section,'目标：'+[request.target.loc,request.target.container].filter(Boolean).join(' → '));if(request.error)line(section,'原因：'+errText(request.error));
 meta(section,'原命令编号：'+c.id);if(getClient){const execute=method=>run(async()=>{const result=await getClient()[method](c);status(result&&result.phase==='APPLIED'?'远端已确认且本机已保存':'结果：'+stateLabel(result&&result.phase));await pending();});if(c.status==='pending')section.appendChild(button('提交原命令',()=>execute('submit')));section.appendChild(button('查询原命令结果',()=>execute('query')));
   if(request.error&&/LEGACY_LOCATION_CONFLICT/.test(String(request.error)))section.appendChild(button('现场确认后以实物为准重发',()=>run(async()=>{const p=getPersistence();if(!p)throw Error('IDB不可用');const next={...request,confirmLegacyLocOverride:true,opId:id()};delete next.error;delete next.phase;delete next.finishedAt;await p.enqueue(next);status('已生成「以实物为准」的新命令，请在下方提交');await pending();})));}}}
 async function runQuery(action){try{await action();}catch(e){searchStatus('查询失败：'+e.message);}}
 function resolveLinkText(text){const win=doc.defaultView;const L=win&&win.ItemLink;if(!L)return text;const link=L.parseScanText(text);return link?link.code:text;}
 function queryScan(text){el('itmSearch').value=resolveLinkText(text);search();}
 /* 查询页/作业页共用同一个全屏浮层；stop* 保持原 API，实际关闭共享浮层。 */
 function closeSharedCamera(){const c=getScanCamera();if(c)c.close('switch');}
 function stopQueryCamera(){closeSharedCamera();}
 el('itmSearchCameraStop').addEventListener('click',stopQueryCamera);
 el('itmSearchCamera').addEventListener('click',()=>runQuery(async()=>{
  const c=getScanCamera();if(!c)throw Error('查询相机不可用，请扫码枪输入检索框');
  await c.open({hint:'对准库位/容器二维码或物品条形码，识别后确认填入查询框',describe:describeHit,onConfirm:text=>queryScan(text)});
 }));
 doc.defaultView.addEventListener('pagehide',stopQueryCamera);
 let adminBusy=false;
 async function activate(kind){if(adminBusy)return;adminBusy=true;try{const st=getState(),loc=U.unique(st,'locations',el('itmAdminLoc').value.trim());const request={schemaVersion:1,opId:id(),kind,expected:{}};if(kind==='activateLocation'){request.locationCode=loc.code;request.expected.locationStatus=loc.status;}else{const c=U.unique(st,'containers',el('itmAdminContainer').value.trim());request.containerCode=c.code;request.target={loc:loc.code};request.expected.containerVersion=c.version;}const p=getPersistence();if(!p)throw Error('IDB不可用');await p.enqueue(request);status('核实启用命令已保存，请在待处理区提交并核对结果');await pending();}finally{adminBusy=false;}}
 /* ================= E1 建档改版（定稿§三.3） =================
    物品建档主流程：分类(必选)+名称(必填) → 在线时提交 registerItem **不带 code**（A 阶段服务端发号）
    → APPLIED 展示物品码 + 8 位短码 + 二维码预览 + 「去入库」；离线时只入队，提示提交后分配物品码。
    手动码降级为高级选项：填了编码就带码入队（§三.2 P3 服务端做规范形校验）。 */
 /* 选中下拉项：走 selected 属性而非 option.selected 属性赋值（linkedom 下后者不生效，浏览器两者等价） */
 function chooseOption(sel,value){for(const o of sel.options){if(o.value===value)o.setAttribute('selected','');else o.removeAttribute('selected');}}
 let prefillItem=null;   // 「去入库」带入的新码：入库行走到物品步骤时预填进 itmCode
 function syncRegisterType(){
  const isItem=(el('itmRegisterType').value||'registerItem')==='registerItem';
  const catWrap=el('itmRegisterCatWrap'),specWrap=el('itmRegisterSpecWrap'),adv=el('itmRegisterAdvanced');
  if(catWrap)catWrap.hidden=!isItem;
  if(specWrap)specWrap.hidden=!isItem;
  if(adv&&!isItem)adv.open=true;   // 库位/容器没有发号流程，编码框直接摊开
 }
 el('itmRegisterType').addEventListener('change',syncRegisterType);
 function showRegisterResult(code,name,category){
  const box=el('itmRegisterResult');if(!box)return;box.replaceChildren();
  const win=doc.defaultView,LL=win&&win.ItemLink;
  line(box,'已分配物品码：'+code+'（'+category+' · '+(name||'')+'）');
  const short=LL&&LL.fromItemCode(code),link=LL&&LL.linkFor(code);
  if(short&&link){
   line(box,'8 位短码：'+short);
   line(box,'短链：'+link.toUpperCase());
   /* 二维码预览复用 index.html 注入的 qrSvg（qrcode 库）；印刷版短链整条大写（§二冻结规格） */
   const svg=typeof qrSvg==='function'?qrSvg(link.toUpperCase()):null;
   if(svg){const holder=doc.createElement('div');holder.className='itm-qr';holder.innerHTML=svg;box.appendChild(holder);}
  }else line(box,'该码不是规范结构，无短链二维码（仍可按原码作业）');
  box.appendChild(button('去入库',()=>{
   chooseOption(el('itmKind'),'receive');
   stopCamera();scan.add('receive');prefillItem=code;render();
   status('已新建入库行并带入新码 '+code+'：请按步骤扫库位与容器，物品步骤会自动填入');
  }));
 }
 el('itmRegister').addEventListener('click',()=>run(async()=>{if(adminBusy)return;adminBusy=true;try{
  const kind=el('itmRegisterType').value||'registerItem';
  const name=el('itmRegisterName').value.trim();
  const manualCode=(el('itmRegisterCode')&&el('itmRegisterCode').value.trim())||'';
  const p=getPersistence();if(!p)throw Error('IDB不可用');
  if(kind!=='registerItem'){
   /* 库位/容器建档保持原路径：本地生成码或沿用填写的码，入队待提交 */
   const prefix={registerLocation:'LOC-',registerContainer:'CTN-'}[kind],code=manualCode||prefix+id();
   const entity={code,...(kind==='registerLocation'?{desc:name}:{spec:name})};
   await p.enqueue({schemaVersion:1,opId:id(),kind,entity});
   status('建档申请已保存：'+code+'；确认前不打印正式标签');await pending();return;
  }
  const category=(el('itmRegisterCat')&&el('itmRegisterCat').value)||'';
  if(!manualCode&&!category)throw Error('请先选择物品分类（决定物品码前缀 WP-分类-序号）');
  if(!name)throw Error('请填写物品名称');
  const spec=(el('itmRegisterSpec')&&el('itmRegisterSpec').value.trim())||'';
  if(manualCode){
   /* 手动码路径保留：带码入队，待处理区提交；服务端做规范形校验（NON_CANONICAL_ITEM_CODE 等） */
   const entity={code:manualCode,name};if(spec)entity.spec=spec;
   await p.enqueue({schemaVersion:1,opId:id(),kind,entity});
   status('建档申请已保存：'+manualCode+'（手动码；不规范形服务端会拒收且无短链）；请在待处理区提交，确认前不打印正式标签');await pending();return;
  }
  const entity={category,name};if(spec)entity.spec=spec;
  const request={schemaVersion:1,opId:id(),kind,entity};
  await p.enqueue(request);
  const online=getClient&&(!isOnline||isOnline());
  if(!online){status('建档申请已保存本机（当前离线）：提交后由服务端分配物品码，请联网后到待处理区提交');await pending();return;}
  status('已保存本机，正在提交发号…');
  const cmds=await getCommands();const cmd=(cmds||[]).find(x=>x.id===request.opId);
  if(!cmd)throw Error('命令未保存，请到待处理区检查');
  const result=await getClient().submit(cmd);
  await pending();
  if(result&&result.phase==='APPLIED'){
   const code=result.request&&result.request.entity&&result.request.entity.code;
   if(!code)throw Error('服务端未回填物品码，请在待处理区查询原命令结果');
   showRegisterResult(code,name,category);
   status('建档完成：'+code+'；打印以 APPLIED 返回的码与预览二维码为准');
  }else status('建档结果：'+stateLabel(result&&result.phase)+'；请在待处理区核对原命令，勿重复建档');
 }finally{adminBusy=false;}}));
 el('itmRetire').addEventListener('click',()=>run(async()=>{if(adminBusy)return;adminBusy=true;try{const item=U.unique(getState(),'items',el('itmRetireCode').value.trim());if(!['pending','out'].includes(item.status))throw Error('仅待入库或已出库物品允许退役');const reason=el('itmRetireReason').value.trim();if(!reason)throw Error('请填写退役原因');const p=getPersistence();if(!p)throw Error('IDB不可用');await p.enqueue({schemaVersion:1,opId:id(),kind:'retire',itemCode:item.code,expected:{itemVersion:item.version},reason});status('退役申请已保存，请在待处理区提交并核对结果，不代表已退役');await pending();}finally{adminBusy=false;}}));
 el('itmActivateLoc').addEventListener('click',()=>run(()=>activate('activateLocation')));
 el('itmActivateContainer').addEventListener('click',()=>run(()=>activate('activateContainer')));
 function stopCamera(){closeSharedCamera();}
 el('itmCameraStop').addEventListener('click',stopCamera);
 el('itmCamera').addEventListener('click',()=>run(async()=>{
  const c=getScanCamera();if(!c)throw Error('相机不可用，请使用扫码枪/手输；草稿已保留');
  const r=scan.row(),labels=stepLabels[r.kind]||[];
  await c.open({
   hint:'对准当前步骤的二维码/条形码，识别后需确认才填入本行',
   captureToken:()=>scan.token(),
   describe:describeWorkHit,
   onConfirm:(text,token)=>acceptGuided(text,token),
   onCancel:(reason,unconfirmed)=>{if(unconfirmed)status('已识别到「'+unconfirmed+'」，但你没点「确定填入」，未写入本行；重新扫码后请点确认');}
  });
 }));
 render();return {scan,render,search,detail,accept,pending,stopCamera,queryScan};
}
return {mount};
});
