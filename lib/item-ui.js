(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./unique-items'),require('./item-scan'));else root.ItemUI=factory(root.UniqueItems,root.ItemScan);})(typeof globalThis!=='undefined'?globalThis:this,function(U,Scan){
'use strict';
function mount({document:doc,getState,getPersistence,getCommands,id,mediaDevices,getClient}){
 const el=n=>doc.getElementById(n),scan=Scan.create({getState,id});scan.add('receive');
 const status=text=>{el('itmStatus').textContent=text;};
 function button(text,action){const b=doc.createElement('button');b.type='button';b.className='btn ghost';b.textContent=text;b.addEventListener('click',action);return b;}
 function line(parent,text){const p=doc.createElement('p');p.textContent=text;parent.appendChild(p);}
 function detail(table,code){const box=el('itmResults');box.replaceChildren();try{
 const st=getState(),r=U.unique(st,table,code);line(box,code+' · '+(r.name||r.desc||r.type||'')+' · '+(r.status||'unknown'));
 if(table==='items'){const pos=U.currentPosition(st,code);line(box,'规格：'+(r.spec||'')+'；数量：1；版本：'+r.version);line(box,pos.container?'当前 '+pos.container.code+' → '+pos.location.code:(pos.legacy?'旧定位，容器待核实：':'当前不在库；历史线索：')+pos.historicalLoc);if(pos.container)box.appendChild(button('容器 '+pos.container.code,()=>detail('containers',pos.container.code)));
 (st.itemOperations||[]).filter(o=>o.itemCode===code||(o.after&&o.after.items||[]).some(i=>i.code===code)).forEach(o=>line(box,o.code+' '+o.kind+' '+o.phase));
 }else if(table==='containers'){line(box,'当前库位：'+(r.loc||'未定位'));if(r.loc)box.appendChild(button('库位 '+r.loc,()=>detail('locations',r.loc)));const items=(st.items||[]).filter(i=>i.status==='in_stock'&&i.container===code);line(box,'在库单件：'+items.length);items.forEach(i=>box.appendChild(button(i.code+' '+(i.name||''),()=>detail('items',i.code))));
 }else{const cs=(st.containers||[]).filter(c=>c.loc===code);line(box,'容器数：'+cs.length+'；在库单件：'+(st.items||[]).filter(i=>i.status==='in_stock'&&cs.some(c=>c.code===i.container)).length);cs.forEach(c=>box.appendChild(button(c.code,()=>detail('containers',c.code))));(st.items||[]).filter(i=>i.status==='unknown'&&i.loc===code).forEach(i=>box.appendChild(button('旧定位未绑定 '+i.code,()=>detail('items',i.code))));}
 if(st.__itmConflicts&&st.__itmConflicts[table+':'+code])line(box,'⚠ 关系冲突，暂停作业');
 line(box,'同步时间：'+(st.__savedAt||'待同步'));
 }catch(e){line(box,e.message);}}
 function search(){const q=el('itmSearch').value.trim(),box=el('itmResults');box.replaceChildren();const st=getState();const typed=q.match(/^(LOC|CTN|ITM)[:|](.+)$/);const tables=typed?[{LOC:'locations',CTN:'containers',ITM:'items'}[typed[1]]]:['locations','containers','items'];const key=typed?typed[2]:q;const exact=tables.flatMap(table=>(st[table]||[]).filter(r=>r.code===key).map(r=>({table,r})));if(exact.length===1){detail(exact[0].table,key);return;}if(exact.length>1){line(box,'编码有多个候选，请按类型选择；同表重复码禁止作业');exact.forEach(({table,r})=>box.appendChild(button(table+' '+r.code,()=>detail(table,r.code))));return;}if(typed){line(box,'该类型未找到编码：'+key);return;}
 for(const table of ['locations','containers','items'])for(const r of st[table]||[])if(!q||[r.code,r.name,r.spec,r.desc,r.type].some(v=>String(v||'').toLowerCase().includes(q.toLowerCase())))box.appendChild(button(table+' '+r.code+' '+(r.name||r.desc||''),()=>detail(table,r.code)));}
 function render(){const snapshot=scan.snapshot(),r=scan.row();const body=el('itmRowTable');body.replaceChildren();snapshot.rows.forEach((entry,index)=>{const tr=doc.createElement('tr');const operation=(getState().itemOperations||[]).find(o=>o.code===entry.opId);const rowStatus=operation?(operation.phase==='APPLIED'?'已完成':operation.phase==='REJECTED'?'已拒绝：'+(operation.error||'请重新建行'):operation.phase):entry.locked?'待提交/待确认':'草稿';const values=[String(index+1),entry.values.filter(v=>v.type==='LOC').map(v=>v.code).join(' → '),entry.values.filter(v=>v.type==='CTN').map(v=>v.code).join(' → '),entry.values.find(v=>v.type==='ITM')?.code||'—',entry.kind,rowStatus];values.forEach(value=>{const td=doc.createElement('td');td.textContent=value;tr.appendChild(td);});tr.tabIndex=0;tr.addEventListener('click',()=>{stopCamera();scan.select(index);render();});body.appendChild(tr);});el('itmRows').replaceChildren();snapshot.rows.forEach((row,index)=>{const o=doc.createElement('option');o.value=String(index);o.textContent=(index+1)+' · '+row.kind+(row.locked?' 已锁定':'');o.selected=index===snapshot.active;el('itmRows').appendChild(o);});el('itmStep').textContent='行 '+r.rowId+'；当前步骤 '+(Scan.sequences[r.kind][r.values.length]||'待确认')+'；'+r.values.map(v=>v.type+':'+v.code).join(' → ')+'；数量固定1';el('itmConfirm').disabled=r.locked||r.values.length!==Scan.sequences[r.kind].length;}
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
 async function pending(){const box=el('itmPending');box.replaceChildren();for(const c of await getCommands()){line(box,'待提交/待确认 '+c.id+' · '+c.status+' · '+(c.request.itemCode||c.request.containerCode||''));if(getClient){const execute=method=>run(async()=>{const result=await getClient()[method](c);status(result&&result.phase==='APPLIED'?'远端已确认且本机已保存':'结果：'+(result&&result.phase||'未知'));await pending();});if(c.status==='pending')box.appendChild(button('提交原命令',()=>execute('submit')));box.appendChild(button('查询原opId',()=>execute('query')));}}}
 let queryStream=null,queryGeneration=0,queryTimer=null;
 function queryScan(text){el('itmSearch').value=text;search();}
 function stopQueryCamera(){queryGeneration++;clearTimeout(queryTimer);if(queryStream)queryStream.getTracks().forEach(t=>t.stop());queryStream=null;el('itmSearchVideo').srcObject=null;el('itmSearchVideo').style.display='none';}
 el('itmSearchCameraStop').addEventListener('click',stopQueryCamera);
 el('itmSearchCamera').addEventListener('click',()=>run(async()=>{stopQueryCamera();const generation=queryGeneration;const devices=mediaDevices||doc.defaultView.navigator.mediaDevices;if(!devices)throw Error('查询相机不可用，请扫码枪输入检索框');const acquired=await devices.getUserMedia({video:{facingMode:'environment'}});if(generation!==queryGeneration){acquired.getTracks().forEach(t=>t.stop());return;}queryStream=acquired;const video=el('itmSearchVideo');video.srcObject=acquired;video.style.display='block';try{await video.play();}catch(e){stopQueryCamera();throw Error('查询相机播放失败，请手输查询');}async function frame(){if(generation!==queryGeneration||!queryStream)return;try{if(video.videoWidth){const c=doc.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(video,0,0);const image=ctx.getImageData(0,0,c.width,c.height),win=doc.defaultView;let text=win.jsQR?.(image.data,image.width,image.height)?.data;try{if(!text)text=await win.ItemBarcode.frame(image);}catch{}if(text&&generation===queryGeneration)queryScan(text);}}finally{if(generation===queryGeneration&&queryStream)queryTimer=setTimeout(frame,300);}}frame();}));
 doc.defaultView.addEventListener('pagehide',stopQueryCamera);
 let adminBusy=false;
 async function activate(kind){if(adminBusy)return;adminBusy=true;try{const st=getState(),loc=U.unique(st,'locations',el('itmAdminLoc').value.trim());const request={schemaVersion:1,opId:id(),kind,expected:{}};if(kind==='activateLocation'){request.locationCode=loc.code;request.expected.locationStatus=loc.status;}else{const c=U.unique(st,'containers',el('itmAdminContainer').value.trim());request.containerCode=c.code;request.target={loc:loc.code};request.expected.containerVersion=c.version;}const p=getPersistence();if(!p)throw Error('IDB不可用');await p.enqueue(request);status('管理员核实命令已保存，仍需服务端认证与提交');await pending();}finally{adminBusy=false;}}
 el('itmRegister').addEventListener('click',()=>run(async()=>{if(adminBusy)return;adminBusy=true;try{const kind=el('itmRegisterType').value||'registerItem',prefix={registerItem:'WP-',registerLocation:'LOC-',registerContainer:'CTN-'}[kind],code=prefix+id();const name=el('itmRegisterName').value.trim();const entity={code,...(kind==='registerItem'?{name}:kind==='registerLocation'?{desc:name}:{spec:name})};const p=getPersistence();if(!p)throw Error('IDB不可用');await p.enqueue({schemaVersion:1,opId:id(),kind,entity});status('建档申请已保存：'+code+'；确认前不打印正式标签');await pending();}finally{adminBusy=false;}}));
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
