(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./unique-items'),require('./item-link'));else root.ItemScan=factory(root.UniqueItems,root.ItemLink);})(typeof globalThis!=='undefined'?globalThis:this,function(U,L){
'use strict';
const sequences={receive:['LOC','CTN','ITM'],issue:['ITM'],verifyLegacy:['LOC','CTN','ITM'],transfer:['ITM','LOC','CTN'],moveContainer:['CTN','LOC'],placeContainer:['LOC','CTN']};
function create({getState,id}){
 let session={sessionId:id(),rows:[],active:0};
 function row(){return session.rows[session.active];}
 function add(kind){if(!sequences[kind])throw Error('不支持的扫码动作');const r={rowId:id(),kind,generation:0,values:[],locked:false,opId:null};session.rows.push(r);session.active=session.rows.length-1;return r;}
 function token(){const r=row();return {sessionId:session.sessionId,rowId:r.rowId,step:r.values.length,generation:r.generation};}
 function select(index){if(!session.rows[index])throw Error('行不存在');if(row())row().generation++;session.active=index;row().generation++;}
 function reset(step=0){const r=row();if(r.locked)throw Error('该行已锁定');r.values=r.values.slice(0,step);r.opId=null;r.generation++;}
 function parse(text){const raw=String(text).trim();
  /* 物品二维码短链优先：/i/8位 或裸8位 → 本地解码出物品码（离线可用） */
  if(L){const link=L.parseScanText(raw);if(link)return{type:'ITM',code:link.code};}
  const m=raw.match(/^(LOC|CTN|ITM)[:|](.+)$/);if(!m){const r=row();if(sequences[r.kind][r.values.length]==='ITM'&&/^WP-[A-Za-z0-9_-]+$/.test(raw)){U.unique(getState(),'items',raw);return {type:'ITM',code:raw};}throw Error('请使用LOC:/CTN:/ITM:类型前缀，裸码仅接受ITM步骤已建档唯一WP码');}return {type:m[1],code:m[2]};}
 function accept(text,captured){const r=row(),now=token();if(captured&&Object.keys(now).some(k=>now[k]!==captured[k]))return {ignored:true};if(r.locked)throw Error('该行已锁定');const p=parse(text),steps=sequences[r.kind];
 if(r.values.length&&r.values[r.values.length-1].type===p.type&&r.values[r.values.length-1].code===p.code)return {duplicate:true};
 if(!steps[r.values.length])throw Error('本行已填齐，无需再扫码；请核对后点「确认本行，保存待提交」');
 if(p.type!==steps[r.values.length])throw Error('当前请扫描'+steps[r.values.length]+'码');
 const st=getState(),table={LOC:'locations',CTN:'containers',ITM:'items'}[p.type],entity=U.unique(st,table,p.code);
 if(p.type==='LOC'&&entity.status!=='active')throw Error('库位未启用');
 /* 2.54.0 Phase1（容器移库反转）：CTN 是第0步、目标 LOC 是第1步——目标与当前库位相同在本地即拦 */
 if(r.kind==='moveContainer'&&p.type==='LOC'){const ctn=U.unique(st,'containers',r.values[0].code);if(ctn.loc===p.code)throw Error('目标库位与当前库位相同，无需移库');}
 if(p.type==='CTN'){
  if(entity.status!=='active')throw Error('容器未启用');
  if(r.kind==='moveContainer'){
   /* 2.54.0 Phase1：CTN 是第0步（无先前 LOC），来源库位由容器现状派生 */
   if(!entity.loc)throw Error('容器尚未定位，请改用「容器定位」作业');
  } else {
   const loc=r.values[r.values.length-1].code;
   if(r.kind==='placeContainer'){if(entity.loc)throw Error('容器已有库位');}
   else if(r.kind==='transfer'){
    /* 2.56.1 Phase3：目标容器===物品当前容器 → 本地拦 NO_CHANGE */
    const it0=U.unique(st,'items',r.values[0].code);
    if(entity.code===it0.container)throw Error('目标容器与当前容器相同，无需换箱');
    if(entity.loc!==loc)throw Error('容器与库位归属不符');
   }
   else if(entity.loc!==loc)throw Error('容器与库位归属不符');
  }
 }
 if(p.type==='ITM'){
  /* 2.53.1：防重只看未锁定行——锁定行（已提交的命令）由服务端状态机裁决，
     否则自动恢复的已完成行会让同一物品的所有后续操作永远被误拦（实测）。 */
  if(session.rows.some(other=>other!==r&&!other.locked&&other.values.some(v=>v.type==='ITM'&&v.code===p.code)))throw Error('批次已包含此物品');
  if(r.kind==='issue'){
   /* 2.54.2 Phase2（物品驱动）：来源（库位/容器）由物品现状派生，不再要求先扫；
      派生实体的冲突守卫提前到扫码时暴露（UNRESOLVED_ENTITY_CONFLICT 走引导分支）。 */
   if(entity.status!=='in_stock')throw Error('物品当前不在库，不能出库');
   if(!entity.container)throw Error('物品档案缺少容器归属，请安全重拉核对后再试');
   const srcCtn=U.unique(st,'containers',entity.container);
   U.unique(st,'locations',srcCtn.loc);
  }
  else if(r.kind==='transfer'){
   /* 2.56.1 Phase3（物品驱动换箱）：与出库同款现状校验，来源由物品现状派生 */
   if(entity.status!=='in_stock')throw Error('物品当前不在库，不能换箱');
   if(!entity.container)throw Error('物品档案缺少容器归属，请安全重拉核对后再试');
   const srcCtn=U.unique(st,'containers',entity.container);
   U.unique(st,'locations',srcCtn.loc);
  }
  if(r.kind==='receive'&&!['pending','out'].includes(entity.status))throw Error(entity.status==='in_stock'?'物品已在库，不能重复入库':entity.status==='unknown'?'物品是旧档案，尚待核实':'物品当前状态不允许入库');
  if(r.kind==='verifyLegacy'&&entity.status!=='unknown')throw Error('不是待核实旧物品');
 }
 r.values.push({...p,version:entity.version});return {complete:r.values.length===steps.length};}
 /* 2.53.1：命令终态（APPLIED/REJECTED）后从会话移除对应行——
    否则已完成的行永远占着「批次已包含此物品」防重检查，同一物品在本页的
    后续任何操作都被误拦（实测：换箱成功后立即出库同一物品被拒）。 */
 function forget(opId){
  const idx=session.rows.findIndex(r=>r.opId===opId);
  if(idx<0)return false;
  const kind=session.rows[idx].kind;
  session.rows.splice(idx,1);
  if(!session.rows.length)add(kind);
  if(session.active>=session.rows.length)session.active=session.rows.length-1;
  return true;
 }
 function request(){const r=row(),v=r.values;if(v.length!==sequences[r.kind].length)throw Error('步骤尚未填齐');const st=getState();v.forEach(value=>U.unique(st,{LOC:'locations',CTN:'containers',ITM:'items'}[value.type],value.code));if(!r.opId)r.opId=id();
  /* 2.54.2 Phase2（物品驱动出库）：source 从 currentPosition 派生（服务端 pair/SOURCE_MISMATCH 仍终审） */
  if(r.kind==='issue'){
   const it=U.unique(st,'items',v[0].code);
   if(it.status!=='in_stock'||!it.container)throw Error('物品当前不在库，不能出库');
   const ctn=U.unique(st,'containers',it.container);
   const loc=U.unique(st,'locations',ctn.loc);
   return {schemaVersion:1,opId:r.opId,kind:r.kind,itemCode:it.code,source:{loc:loc.code,container:ctn.code},expected:{itemVersion:it.version,containerVersion:ctn.version}};
  }
  const q={schemaVersion:1,opId:r.opId,kind:r.kind,expected:{containerVersion:v[1].version}};
 if(r.kind==='moveContainer'){
  /* 2.54.0 Phase1：source 从容器现状派生（服务端 pair/SOURCE_MISMATCH 仍终审） */
  const ctn=U.unique(st,'containers',v[0].code);
  q.containerCode=ctn.code;q.source={loc:ctn.loc};q.target={loc:v[1].code};q.expected.containerVersion=ctn.version;
 }
 else if(r.kind==='placeContainer'){q.containerCode=v[1].code;q.target={loc:v[0].code};}
 else if(r.kind==='transfer'){
  /* 2.56.1 Phase3：source 从物品现状派生，target 取扫码目标（服务端 pair/SOURCE_MISMATCH 仍终审） */
  const it=U.unique(st,'items',v[0].code);
  if(it.status!=='in_stock'||!it.container)throw Error('物品当前不在库，不能换箱');
  const srcCtn=U.unique(st,'containers',it.container);
  const srcLoc=U.unique(st,'locations',srcCtn.loc);
  const tgtCtn=U.unique(st,'containers',v[2].code);
  return {schemaVersion:1,opId:r.opId,kind:r.kind,itemCode:it.code,
    source:{loc:srcLoc.code,container:srcCtn.code},
    target:{loc:v[1].code,container:tgtCtn.code},
    expected:{itemVersion:it.version,containerVersion:srcCtn.version,targetContainerVersion:tgtCtn.version}};
 }
 else {q.itemCode=v[2].code;q.expected.itemVersion=v[2].version;q[r.kind==='receive'||r.kind==='verifyLegacy'?'target':'source']={loc:v[0].code,container:v[1].code};}
 return q;}
 function lock(){const q=request();row().locked=true;row().generation++;return q;}
 return {add,row,token,select,reset,accept,request,lock,forget,unlock(){row().locked=false;row().generation++;},snapshot:()=>JSON.parse(JSON.stringify(session)),restore(value){session=JSON.parse(JSON.stringify(value));session.rows.forEach(r=>r.generation++);}};
}
return {create,sequences};
});
