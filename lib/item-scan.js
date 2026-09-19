(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./unique-items'),require('./item-link'));else root.ItemScan=factory(root.UniqueItems,root.ItemLink);})(typeof globalThis!=='undefined'?globalThis:this,function(U,L){
'use strict';
const sequences={receive:['LOC','CTN','ITM'],issue:['LOC','CTN','ITM'],verifyLegacy:['LOC','CTN','ITM'],transfer:['LOC','CTN','ITM','LOC','CTN'],moveContainer:['LOC','CTN','LOC'],placeContainer:['LOC','CTN']};
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
 if(p.type!==steps[r.values.length])throw Error('当前请扫描'+(steps[r.values.length]||'已完成，请确认'));
 const st=getState(),table={LOC:'locations',CTN:'containers',ITM:'items'}[p.type],entity=U.unique(st,table,p.code);
 if(p.type==='LOC'&&entity.status!=='active')throw Error('库位未启用');
 if(p.type==='CTN'){
  if(entity.status!=='active')throw Error('容器未启用');
  const loc=r.values[r.values.length-1].code;
  if(r.kind==='placeContainer'){if(entity.loc)throw Error('容器已有库位');}
  else if(entity.loc!==loc)throw Error('容器与库位归属不符');
 }
 if(p.type==='ITM'){
  if(session.rows.some(other=>other!==r&&other.values.some(v=>v.type==='ITM'&&v.code===p.code)))throw Error('批次已包含此物品');
  if(['issue','transfer'].includes(r.kind)&&(entity.status!=='in_stock'||entity.container!==r.values[1].code))throw Error('物品状态或来源容器不符');
  if(r.kind==='receive'&&!['pending','out'].includes(entity.status))throw Error(entity.status==='in_stock'?'物品已在库，不能重复入库':entity.status==='unknown'?'物品是旧档案，尚待核实':'物品当前状态不允许入库');
  if(r.kind==='verifyLegacy'&&entity.status!=='unknown')throw Error('不是待核实旧物品');
 }
 r.values.push({...p,version:entity.version});return {complete:r.values.length===steps.length};}
 function request(){const r=row(),v=r.values;if(v.length!==sequences[r.kind].length)throw Error('三码尚未完成');const st=getState();v.forEach(value=>U.unique(st,{LOC:'locations',CTN:'containers',ITM:'items'}[value.type],value.code));if(!r.opId)r.opId=id();const q={schemaVersion:1,opId:r.opId,kind:r.kind,expected:{containerVersion:v[1].version}};
 if(['moveContainer','placeContainer'].includes(r.kind)){q.containerCode=v[1].code;q.target={loc:v[r.kind==='moveContainer'?2:0].code};if(r.kind==='moveContainer')q.source={loc:v[0].code};}
 else {q.itemCode=v[2].code;q.expected.itemVersion=v[2].version;q[r.kind==='receive'||r.kind==='verifyLegacy'?'target':'source']={loc:v[0].code,container:v[1].code};if(r.kind==='transfer'){q.target={loc:v[3].code,container:v[4].code};q.expected.targetContainerVersion=v[4].version;}}
 return q;}
 function lock(){const q=request();row().locked=true;row().generation++;return q;}
 return {add,row,token,select,reset,accept,request,lock,unlock(){row().locked=false;row().generation++;},snapshot:()=>JSON.parse(JSON.stringify(session)),restore(value){session=JSON.parse(JSON.stringify(value));session.rows.forEach(r=>r.generation++);}};
}
return {create,sequences};
});
