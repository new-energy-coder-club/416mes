(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./unique-items'),require('./item-scan'));else root.ItemUI=factory(root.UniqueItems,root.ItemScan);})(typeof globalThis!=='undefined'?globalThis:this,function(U,Scan){
'use strict';
function mount({document:doc,getState,getPersistence,getCommands,id,mediaDevices,getClient,refreshConflicts}){
 const el=n=>doc.getElementById(n),scan=Scan.create({getState,id});scan.add('receive');
 const status=text=>{el('itmStatus').textContent=text;};
 const searchStatus=text=>{el('itmSearchStatus').textContent=text;};
 const types={locations:'库位',containers:'容器',items:'物品',LOC:'库位',CTN:'容器',ITM:'物品'};
 const kinds={receive:'入库',issue:'出库',transfer:'换箱',moveContainer:'容器移库',placeContainer:'容器定位',verifyLegacy:'旧物品核实',activateLocation:'核实启用库位',activateContainer:'核实启用容器',registerItem:'物品建档',registerLocation:'库位建档',registerContainer:'容器建档',retire:'物品退役'};
 const states={active:'已启用',disabled:'已停用',inactive:'已停用',pending:'待入库',out:'已出库',in_stock:'在库',unknown:'待核实',retired:'已退役',PREPARED:'已准备，待确认',APPLIED:'已完成',REJECTED:'已拒绝',UNKNOWN:'结果待确认',unknown_commit:'结果待确认',needs_attention:'需人工核验'};
 const kindLabel=value=>kinds[value]||'待核实操作';
 const stateLabel=value=>states[value]||'状态待核实';
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
 function search(){const q=el('itmSearch').value.trim(),box=el('itmResults');box.replaceChildren();try{const st=getState();const typed=q.match(/^(LOC|CTN|ITM)[:|](.+)$/);const tables=typed?[{LOC:'locations',CTN:'containers',ITM:'items'}[typed[1]]]:['locations','containers','items'];const key=typed?typed[2]:q;const exact=tables.flatMap(table=>(st[table]||[]).filter(r=>r.code===key).map(r=>({table,r})));if(exact.length===1){detail(exact[0].table,key);return;}if(exact.length>1){searchStatus('编码有多个候选，请按类型选择；同表重复码禁止作业');line(box,'编码有多个候选，请按类型选择');exact.forEach(({table,r})=>candidate(box,table,r));return;}if(typed){searchStatus('该类型未找到编码：'+key);return;}
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
 }
 async function run(action){try{await action();render();}catch(e){status(e.message);}}
 function accept(text,token){return run(()=>{scan.accept(text,token);el('itmCode').value='';status('已填写草稿，尚未提交');});}
 el('itmSearchBtn').addEventListener('click',search);el('itmSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();search();}});
 el('itmNewRow').addEventListener('click',()=>run(()=>{stopCamera();scan.add(el('itmKind').value);}));
 el('itmRows').addEventListener('change',()=>run(()=>{stopCamera();scan.select(Number(el('itmRows').value));}));
 el('itmReset').addEventListener('click',()=>run(()=>{stopCamera();scan.reset();}));
 el('itmScanBtn').addEventListener('click',()=>accept(el('itmCode').value));
 el('itmCode').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();accept(el('itmCode').value);}});
 el('itmDraftSave').addEventListener('click',()=>run(async()=>{const p=getPersistence();if(!p)throw Error('IDB不可用，草稿仅临时保留');await p.saveDraft(scan.snapshot().sessionId,scan.snapshot());status('草稿已保存本机');}));
 el('itmDraftRestore').addEventListener('click',()=>run(async()=>{const p=getPersistence();if(!p)throw Error('IDB不可用');const recovered=await p.recover();const drafts=recovered.drafts.filter(d=>d.value&&Array.isArray(d.value.rows));if(!drafts.length)throw Error('没有可恢复草稿');scan.restore(drafts[drafts.length-1].value);status('已恢复草稿；锁定命令须查询原opId，不自动重发');}));
 el('itmConfirm').addEventListener('click',()=>run(async()=>{if(scan.row().locked)return;const p=getPersistence();if(!p)throw Error('IDB不可用，不能提交');const request=scan.lock();render();try{await p.enqueue(request,scan.snapshot().sessionId,scan.snapshot());}catch(e){scan.unlock();render();throw e;}status('本机已保存，待提交；不代表业务完成');await pending();}));
 async function pending(){const box=el('itmPending');box.replaceChildren();const commands=await getCommands();if(!commands.length)line(box,'暂无待处理命令。完成步骤并确认后，会显示在这里。');for(const c of commands){const request=c.request||{},section=card(box,kindLabel(request.kind)+' · '+(c.status==='pending'?'待提交':c.status==='unknown'?'结果待确认':stateLabel(c.status)));line(section,'对象：'+(request.itemCode||request.containerCode||request.locationCode||request.entity?.code||'待核实'));if(request.source)line(section,'来源：'+[request.source.loc,request.source.container].filter(Boolean).join(' → '));if(request.target)line(section,'目标：'+[request.target.loc,request.target.container].filter(Boolean).join(' → '));meta(section,'原命令编号：'+c.id);if(getClient){const execute=method=>run(async()=>{const result=await getClient()[method](c);status(result&&result.phase==='APPLIED'?'远端已确认且本机已保存':'结果：'+stateLabel(result&&result.phase));await pending();});if(c.status==='pending')section.appendChild(button('提交原命令',()=>execute('submit')));section.appendChild(button('查询原命令结果',()=>execute('query')));}}}
 async function runQuery(action){try{await action();}catch(e){searchStatus('查询失败：'+e.message);}}
 let queryStream=null,queryGeneration=0,queryTimer=null;
 function queryScan(text){el('itmSearch').value=text;search();}
 function stopQueryCamera(){queryGeneration++;clearTimeout(queryTimer);if(queryStream)queryStream.getTracks().forEach(t=>t.stop());queryStream=null;el('itmSearchVideo').srcObject=null;el('itmSearchVideo').style.display='none';}
 el('itmSearchCameraStop').addEventListener('click',stopQueryCamera);
 el('itmSearchCamera').addEventListener('click',()=>runQuery(async()=>{stopQueryCamera();const generation=queryGeneration;const devices=mediaDevices||doc.defaultView.navigator.mediaDevices;if(!devices)throw Error('查询相机不可用，请扫码枪输入检索框');const acquired=await devices.getUserMedia({video:{facingMode:'environment'}});if(generation!==queryGeneration){acquired.getTracks().forEach(t=>t.stop());return;}queryStream=acquired;const video=el('itmSearchVideo');video.srcObject=acquired;video.style.display='block';try{await video.play();}catch(e){stopQueryCamera();throw Error('查询相机播放失败，请手输查询');}async function frame(){if(generation!==queryGeneration||!queryStream)return;try{if(video.videoWidth){const c=doc.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(video,0,0);const image=ctx.getImageData(0,0,c.width,c.height),win=doc.defaultView;let text=win.jsQR?.(image.data,image.width,image.height)?.data;try{if(!text)text=await win.ItemBarcode.frame(image);}catch{}if(text&&generation===queryGeneration)queryScan(text);}}catch(e){searchStatus('查询解码失败，请使用扫码枪或手输查询');}finally{if(generation===queryGeneration&&queryStream)queryTimer=setTimeout(frame,300);}}frame();}));
 doc.defaultView.addEventListener('pagehide',stopQueryCamera);
 let adminBusy=false;
 async function activate(kind){if(adminBusy)return;adminBusy=true;try{const st=getState(),loc=U.unique(st,'locations',el('itmAdminLoc').value.trim());const request={schemaVersion:1,opId:id(),kind,expected:{}};if(kind==='activateLocation'){request.locationCode=loc.code;request.expected.locationStatus=loc.status;}else{const c=U.unique(st,'containers',el('itmAdminContainer').value.trim());request.containerCode=c.code;request.target={loc:loc.code};request.expected.containerVersion=c.version;}const p=getPersistence();if(!p)throw Error('IDB不可用');await p.enqueue(request);status('核实启用命令已保存，请在待处理区提交并核对结果');await pending();}finally{adminBusy=false;}}
 el('itmRegister').addEventListener('click',()=>run(async()=>{if(adminBusy)return;adminBusy=true;try{const kind=el('itmRegisterType').value||'registerItem',prefix={registerItem:'WP-',registerLocation:'LOC-',registerContainer:'CTN-'}[kind],code=prefix+id();const name=el('itmRegisterName').value.trim();const entity={code,...(kind==='registerItem'?{name}:kind==='registerLocation'?{desc:name}:{spec:name})};const p=getPersistence();if(!p)throw Error('IDB不可用');await p.enqueue({schemaVersion:1,opId:id(),kind,entity});status('建档申请已保存：'+code+'；确认前不打印正式标签');await pending();}finally{adminBusy=false;}}));
 el('itmRetire').addEventListener('click',()=>run(async()=>{if(adminBusy)return;adminBusy=true;try{const item=U.unique(getState(),'items',el('itmRetireCode').value.trim());if(!['pending','out'].includes(item.status))throw Error('仅待入库或已出库物品允许退役');const reason=el('itmRetireReason').value.trim();if(!reason)throw Error('请填写退役原因');const p=getPersistence();if(!p)throw Error('IDB不可用');await p.enqueue({schemaVersion:1,opId:id(),kind:'retire',itemCode:item.code,expected:{itemVersion:item.version},reason});status('退役申请已保存，请在待处理区提交并核对结果，不代表已退役');await pending();}finally{adminBusy=false;}}));
 el('itmActivateLoc').addEventListener('click',()=>run(()=>activate('activateLocation')));
 el('itmActivateContainer').addEventListener('click',()=>run(()=>activate('activateContainer')));
 let stream=null,timer=null,cameraGeneration=0;
 function stopCamera(){stopQueryCamera();cameraGeneration++;clearTimeout(timer);timer=null;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;el('itmVideo').srcObject=null;el('itmVideo').style.display='none';}
 doc.defaultView.addEventListener('pagehide',stopCamera);
 el('itmCameraStop').addEventListener('click',stopCamera);
 el('itmCamera').addEventListener('click',()=>run(async()=>{
  stopCamera();const generation=cameraGeneration,start=scan.token();const nav={mediaDevices:mediaDevices||doc.defaultView.navigator.mediaDevices};if(!nav.mediaDevices||!nav.mediaDevices.getUserMedia)throw Error('相机不可用，请使用扫码枪/手输；草稿已保留');
  try{const acquired=await nav.mediaDevices.getUserMedia({video:{facingMode:'environment'}});if(generation!==cameraGeneration||scan.token().rowId!==start.rowId){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;}catch(e){throw Error('相机权限失败，请使用扫码枪/手输；草稿已保留');}
  const video=el('itmVideo');video.srcObject=stream;video.style.display='block';try{await video.play();}catch(e){stopCamera();throw Error('相机播放失败，已释放设备，请使用扫码枪/手输');}
  async function tick(){if(!stream||generation!==cameraGeneration||scan.token().rowId!==start.rowId)return;const captured=scan.token();try{if(video.videoWidth){const canvas=doc.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0);const image=ctx.getImageData(0,0,canvas.width,canvas.height);let text='';const win=doc.defaultView;
   if(win.jsQR){const qr=win.jsQR(image.data,image.width,image.height);if(qr)text=qr.data;}
   if(!text&&win.ItemBarcode)try{text=await win.ItemBarcode.frame(image);}catch(e){}
   if(text&&generation===cameraGeneration)await accept(text,captured);
  }}catch(e){status('解码失败，可继续扫码枪/手输');}if(generation===cameraGeneration&&stream)timer=setTimeout(tick,250);}
  tick();
 }));
 render();return {scan,render,search,detail,accept,pending,stopCamera,queryScan};
}
return {mount};
});
