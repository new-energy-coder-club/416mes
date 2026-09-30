(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./unique-items'),require('./item-link'));else root.ItemScan=factory(root.UniqueItems,root.ItemLink);})(typeof globalThis!=='undefined'?globalThis:this,function(U,L){
'use strict';
const sequences={receive:['LOC','CTN','ITM'],issue:['ITM'],verifyLegacy:['LOC','CTN','ITM'],transfer:['ITM','LOC','CTN']};
/* 3.13.33（A-9，用户实测：刚启用的库位 B-01-01-03 + 刚启用的容器 SLG-002 入库被拦
   「容器与库位归属不符」死端）：A-2 纯启用后 containers.loc 已退役（新启用容器恒 ''），
   旧门禁拿这个退役字段去比对目标库位，把「新容器×任意库位」全部拦死。
   新模型里容器与库位的从属唯一落点是 locations.parentContainer 子位标注（用户裁决：
   容器和库位默认不相干，标注后才建立从属）。
   本门禁只做分类与结构化拒绝（Error.code='CTN_LOC_UNBOUND'，detail={kind,...}），
   绝不静默放行——放行会派生旧模型 target={loc,container} 请求、被 apply 层 pair()
   再拒一次（unique-items.js:122），也绝不静默改数据——绑定必须由 UI 给出显式确认卡。
   kind 分类（UI 据此决定：出确认卡 / 出普通提示）：
   · own_sub         该库位已是本容器的子位（正常会被 stepsFor 分流掉子位步骤，
                     这里是锚定后镜像才翻转的竞态防御）→ 换按子位步骤重扫即可；
   · bound_other     该库位已是别的容器的子位（一格只属一个容器）→ 换库位或先解除从属；
   · legacy_occupied 该库位被别的容器以旧模型 loc 占位（同 LOC_ALREADY_BOUND 语义）；
   · unbound         两边都空闲 → 可以标注：UI 给「标注 X 为 Y 的子位并继续」确认卡。
   旧模型容器（containers.loc 非空）不进本门禁，保留原逐字比对（归属不符语义不变）。 */
function ctnUnboundGate(st,ctn,locCode){
 function fail(kind,text){const e=Error(text);e.code='CTN_LOC_UNBOUND';e.detail={kind:kind,ctnCode:ctn.code,locCode:locCode};throw e;}
 const locRow=(st.locations||[]).find(l=>l.code===locCode);
 if(locRow&&locRow.role==='容器子位'){
  if(locRow.parentContainer===ctn.code)fail('own_sub','库位 '+locCode+' 已是容器 '+ctn.code+' 的子位：子位直存/直取无需再扫容器码，请重扫让行按子位步骤继续');
  fail('bound_other','库位 '+locCode+' 已从属容器 '+locRow.parentContainer+'：一格只属一个容器，请换库位或先解除该格的从属再标注');
 }
 const occupied=(st.containers||[]).find(x=>x.loc===locCode&&x.code!==ctn.code);
 if(occupied)fail('legacy_occupied','库位 '+locCode+' 已被容器 '+occupied.code+' 以旧模型占位绑定：先清掉那边的归属再来标注');
 fail('unbound','容器 '+ctn.code+' 与库位 '+locCode+' 尚未建立从属关系：如物品确实放入该容器的该库位，请先把 '+locCode+' 标注为 '+ctn.code+' 的子位');
}
function create({getState,id}){
 let session={sessionId:id(),rows:[],active:0};
 /* P2（C1）：子位直存路径的步骤表——由**已扫值**动态判别，判别点未到时回退原表：
    receive：首扫 LOC 是「容器子位」→ 无容器步骤 ['LOC','ITM']（物品直存子位）；
    transfer：第 2 步 LOC（换箱目标）是「容器子位」→ 无目标容器步骤 ['ITM','LOC']；
    其余 kind 与判别未定（receive 未扫 LOC / transfer 未扫目标 LOC）→ sequences[r.kind] 原表。
    源侧（issue/transfer 的来源）沿用 2.54.2 物品驱动约定：由物品现状派生，不占扫码步骤。 */
 function stepsFor(r){
  const base=sequences[r.kind];
  if(!base)return base||[];
  const st=getState();
  if(r.kind==='receive'){
   const first=(r.values||[])[0];
   if(first&&first.type==='LOC'){
    const loc=(st.locations||[]).find(l=>l.code===first.code);
    if(loc&&loc.role==='容器子位')return ['LOC','ITM'];
   }
   return base;
  }
  if(r.kind==='transfer'){
   const second=(r.values||[])[1];
   if(second&&second.type==='LOC'){
    const loc=(st.locations||[]).find(l=>l.code===second.code);
    if(loc&&loc.role==='容器子位')return ['ITM','LOC'];
   }
   return base;
  }
  return base;
 }
 function row(){return session.rows[session.active];}
 function add(kind){if(!sequences[kind])throw Error('不支持的扫码动作：'+kind+'（请重新选择作业类型）');const r={rowId:id(),kind,generation:0,values:[],locked:false,opId:null};session.rows.push(r);session.active=session.rows.length-1;return r;}
 /* 2.97.0 Phase 1（锚点批量）：session.batch = null | { kind:'receive'|'issue', anchor:{loc,ctn,ctnVersion}|null }
    批量模式是显式进入的会话状态：锚点扫一次（LOC+CTN 或出库首件派生），
    物品连扫自动合成完整行进 rows——草稿/锁定/forget 零改动兼容。 */
 function startBatch(kind){
  if(!['receive','issue'].includes(kind))throw Error('不支持的批量类型：'+kind);
  /* F1（草稿污染修复）：进入批量模式丢弃所有未锁定旧行——旧草稿混进批次会让
     计数/锚点/表单全面错乱（用户实测「全不对」的根因）。已锁定行（已提交命令）保留。 */
  session.rows=session.rows.filter(r=>r.locked);
  if(!session.rows.length)add('receive');
  if(session.active>=session.rows.length)session.active=session.rows.length-1;
  session.batch={kind:kind,anchor:null,_loc:null};
  return session.batch;
 }
 function stopBatch(){session.batch=null;}
 /* 2.99.5（数量先行）：写入活会话的批次数量（batchState() 是深拷贝读视图，改它无效——B1 同款坑） */
 function setBatchQty(n){if(!session.batch)throw Error('不在批量模式');const q=parseInt(n,10);if(!q||q<1||q>50)throw Error('数量须为 1~50');session.batch.targetQty=q;return q;}
 function batchState(){return session.batch?JSON.parse(JSON.stringify(session.batch)):null;}
 function token(){const r=row();return {sessionId:session.sessionId,rowId:r.rowId,step:r.values.length,generation:r.generation};}
 function select(index){if(!session.rows[index])throw Error('行不存在');if(row())row().generation++;session.active=index;row().generation++;}
 function reset(step=0){const r=row();if(r.locked)throw Error('该行已锁定');r.values=r.values.slice(0,step);r.opId=null;r.generation++;}
 function parse(text){const raw=String(text).trim();
  /* 物品二维码短链优先：/i/8位 或裸8位 → 本地解码出物品码（离线可用） */
  if(L){const link=L.parseScanText(raw);if(link)return{type:'ITM',code:link.code};}
  /* P2（C2）：裸 WP 规则随 stepsFor 走——子位 receive 的 ITM 步在第 2 步（无 CTN 步） */
  const m=raw.match(/^(LOC|CTN|ITM)[:|](.+)$/);if(!m){const r=row();if(stepsFor(r)[r.values.length]==='ITM'&&/^WP-[A-Za-z0-9_-]+$/.test(raw)){U.unique(getState(),'items',raw);return {type:'ITM',code:raw};}throw Error('请使用LOC:/CTN:/ITM:类型前缀，裸码仅接受ITM步骤已建档唯一WP码');}return {type:m[1],code:m[2]};}
 function accept(text,captured){const r=row(),now=token();if(captured&&Object.keys(now).some(k=>now[k]!==captured[k]))return {ignored:true};if(r.locked)throw Error('该行已锁定');const p=parse(text),steps=stepsFor(r);
 if(r.values.length&&r.values[r.values.length-1].type===p.type&&r.values[r.values.length-1].code===p.code)return {duplicate:true};
 if(!steps[r.values.length])throw Error('本行已填齐，无需再扫码；请核对后点「确认本行，保存待提交」');
 if(p.type!==steps[r.values.length])throw Error('当前请扫描'+steps[r.values.length]+'码');
 const st=getState(),table={LOC:'locations',CTN:'containers',ITM:'items'}[p.type],entity=U.unique(st,table,p.code);
 if(p.type==='LOC'&&entity.status!=='active')throw Error('库位未启用');
 if(p.type==='CTN'){
  if(entity.status!=='active')throw Error('容器未启用');
  const loc=r.values[r.values.length-1].code;
  if(r.kind==='transfer'){
   /* 2.56.1 Phase3：目标容器===物品当前容器 → 本地拦 NO_CHANGE */
   const it0=U.unique(st,'items',r.values[0].code);
   if(entity.code===it0.container)throw Error('目标容器与当前容器相同，无需换箱');
  }
  /* 3.13.33（A-9）：容器-库位从属门控三分支——
     verifyLegacy：旧契约逐字比对 ctn.loc，行为不变（apply 层 pair 同口径）；
     旧模型容器（ctn.loc 非空）：沿用原「归属不符」逐字比对；
     新模型容器（ctn.loc 为空，A-5 纯启用）：不再拿退役字段比对（否则新容器×任意库位全拦死），
     交 ctnUnboundGate 分类拒绝，由 UI 出「标注子位并继续」确认卡，绝不静默放行/改数据。 */
  if(r.kind==='verifyLegacy'){
   if(entity.loc!==loc)throw Error('容器与库位归属不符');
  }else if(entity.loc){
   if(entity.loc!==loc)throw Error('容器与库位归属不符');
  }else{
   ctnUnboundGate(st,entity,loc);
  }
 }
 if(p.type==='ITM'){
  /* 2.53.1：防重只看未锁定行——锁定行（已提交的命令）由服务端状态机裁决，
     否则自动恢复的已完成行会让同一物品的所有后续操作永远被误拦（实测）。 */
  if(session.rows.some(other=>other!==r&&!other.locked&&other.values.some(v=>v.type==='ITM'&&v.code===p.code)))throw Error('批次已包含此物品');
  if(r.kind==='issue'){
   /* 2.54.2 Phase2（物品驱动）：来源（库位/容器）由物品现状派生，不再要求先扫；
      派生实体的冲突守卫提前到扫码时暴露（UNRESOLVED_ENTITY_CONFLICT 走引导分支）。
      容器库位模型 P1（只读定位扩展）：it.loc 非空 = 物品直存库位（容器子位），
      来源直读 it.loc；it.loc 空 → 旧容器链，行为不变。
      写命令契约（request()/服务端 pair 终审）本阶段不动：真要出子位的物品，
      仍会在确认时被「缺容器归属」拦下——那是 P2/P3 的命令扩展，不在本阶段。 */
   if(entity.status!=='in_stock')throw Error('物品当前不在库，不能出库');
   if(entity.loc){ U.unique(st,'locations',entity.loc); }
   else{
   if(!entity.container)throw Error('物品档案缺少容器归属，请安全重拉核对后再试');
   const srcCtn=U.unique(st,'containers',entity.container);
   U.unique(st,'locations',srcCtn.loc);
   }
  }
  else if(r.kind==='transfer'){
   /* 2.56.1 Phase3（物品驱动换箱）：与出库同款现状校验，来源由物品现状派生。
      P2（A5 对应）：it.loc 非空 = 物品现存子位，来源直读子位（无容器链）；
      it.loc 空 → 旧容器链，行为不变。 */
   if(entity.status!=='in_stock')throw Error('物品当前不在库，不能换箱');
   if(entity.loc){ U.unique(st,'locations',entity.loc); }
   else{
   if(!entity.container)throw Error('物品档案缺少容器归属，请安全重拉核对后再试');
   const srcCtn=U.unique(st,'containers',entity.container);
   U.unique(st,'locations',srcCtn.loc);
   }
  }
  /* 2.58.0 Phase5：unknown 旧档案物品直接入库（旧核实已并入），仅 in_stock/retired 拒绝 */
  if(r.kind==='receive'&&!['pending','out','unknown'].includes(entity.status))throw Error(entity.status==='in_stock'?'物品已在库，不能重复入库':'物品当前状态不允许入库');
  if(r.kind==='verifyLegacy'&&entity.status!=='unknown')throw Error('不是待核实旧物品');
 }
 r.values.push({...p,version:entity.version});return {complete:r.values.length===stepsFor(r).length};}
 /* 2.97.0 Phase 1（锚点批量）：批量模式下的扫码路由。
    入库：锚点未完成时 LOC→CTN 依次锚定（扫码即校验归属）；完成后 ITM 连扫合成完整行。
    出库：首件 ITM 即从 currentPosition 派生锚点，后续件必须同库位。 */
 function acceptBatchCode(p){
  const batch=session.batch;
  if(!batch)throw Error('不在批量模式');
  const st=getState();
  if(batch.kind==='receive'){
   if(!batch.anchor){
    if(p.type==='LOC'&&!batch._loc){
     const loc=U.unique(st,'locations',p.code);
     if(loc.status!=='active')throw Error('库位未启用');
     /* P3（C5）：首扫 LOC 是「容器子位」→ 子位锚点一步到位（无 CTN 步），物品直存该子位；
        校验顺序与单条 receive 同（unique→active→role）。 */
     if(loc.role==='容器子位'){
      batch.anchor={loc:loc.code,ctn:null,sub:true};
      return {stage:'anchor',text:'子位锚点 '+loc.code+' ✓——物品直存该子位，开始连扫物品'};
     }
     batch._loc={code:loc.code};
     return {stage:'anchor',text:'库位锚点 '+loc.code+' ✓，请扫容器'};
    }
    if(p.type==='CTN'&&batch._loc){
     const ctn=U.unique(st,'containers',p.code);
     if(ctn.status!=='active')throw Error('容器未启用');
     if(!ctn.loc){
      /* 3.13.33（A-9）：新模型容器（ctn.loc 退役恒空）的批量锚定门控——
         库位已是本容器的子位（LOC 锚定后才翻转的竞态）→ 子位锚点一步到位并清掉
         _loc（防 CTN 分支重触发）；bound_other / legacy_occupied / unbound 交
         ctnUnboundGate 分类拒绝，由 UI 出「标注子位并继续」确认卡，不静默绑定。 */
      const _locRow=(st.locations||[]).find(l=>l.code===batch._loc.code);
      if(_locRow&&_locRow.role==='容器子位'&&_locRow.parentContainer===ctn.code){
       batch.anchor={loc:batch._loc.code,ctn:null,sub:true};
       batch._loc=null;
       return {stage:'anchor',text:'子位锚点 '+batch.anchor.loc+' ✓——'+ctn.code+' 的子位，物品直存该子位，开始连扫物品'};
      }
      ctnUnboundGate(st,ctn,batch._loc.code);
     }
     if(ctn.loc!==batch._loc.code)throw Error('容器与库位归属不符（'+ctn.code+' 在 '+(ctn.loc||'未定位')+'，不在 '+batch._loc.code+'）');
     batch.anchor={loc:batch._loc.code,ctn:ctn.code,ctnVersion:ctn.version};
     return {stage:'anchor',text:'容器锚点 '+ctn.code+' ✓——锚点已定 '+batch.anchor.loc+' / '+ctn.code+'，开始连扫物品'};
    }
    if(p.type==='LOC'&&batch._loc)throw Error('库位锚点已定 '+batch._loc.code+'；批量中如需换锚点请先「放弃本批」');
    throw Error('锚点阶段请先'+(batch._loc?'扫容器码（CTN:）':'扫库位码（LOC:）'));
   }
   if(p.type!=='ITM')throw Error('锚点已定 '+(batch.anchor.sub?batch.anchor.loc:(batch.anchor.loc+' / '+batch.anchor.ctn))+'；如需换锚点请先「放弃本批」，否则请扫物品码');
   /* 2.99.4（数量先行）：先定数量再连扫，每扫一件填一个表单槽 */
   const _filled=session.rows.filter(r=>!r.locked&&r.values.some(v=>v.type==='ITM')).length;
   if(!batch.targetQty)throw Error('请先输入本批数量并点「生成表单」');
   if(_filled>=batch.targetQty)throw Error('本批 '+batch.targetQty+' 个表单已全部填齐——请点「提交本批」');
   const it=U.unique(st,'items',p.code);
   if(!['pending','out','unknown'].includes(it.status))throw Error(it.status==='in_stock'?'物品已在库，不能重复入库':'物品当前状态不允许入库');
   if(session.rows.some(r=>!r.locked&&r.values.some(v=>v.type==='ITM'&&v.code===p.code)))return {duplicate:true,text:'该件已在本批中，已忽略'};
   if(session.rows.filter(r=>!r.locked&&r.values.some(v=>v.type==='ITM')).length>=50)throw Error('本批已满 50 件（协议上限），请先提交本批再开新批');
   let _vals;
   if(batch.anchor.sub){
    /* P3（C5）：子位锚点行=2 值 ['LOC','ITM']（无容器步骤，与 stepsFor 子位表一致） */
    _vals=[{type:'LOC',code:batch.anchor.loc,version:0},{type:'ITM',code:it.code,version:it.version}];
   }else{
    const ctn=U.unique(st,'containers',batch.anchor.ctn);
    _vals=[{type:'LOC',code:batch.anchor.loc,version:0},{type:'CTN',code:batch.anchor.ctn,version:ctn.version},{type:'ITM',code:it.code,version:it.version}];
   }
   session.rows.push({rowId:id(),kind:'receive',generation:0,values:_vals,locked:false,opId:null});
   session.active=session.rows.length-1;
   const n=session.rows.filter(r=>!r.locked&&r.values.some(v=>v.type==='ITM')).length;
   return {stage:'item',text:'✓ '+it.code+' 已入批（第 '+n+' 件）'};
  }
  if(p.type!=='ITM')throw Error('出库批量按物品现状出库，不需要扫库位/容器；请扫物品码');
  const it=U.unique(st,'items',p.code);
  if(it.status!=='in_stock')throw Error('物品当前不在库，不能出库');
  /* 容器库位模型 P1（只读定位扩展）：it.loc 非空 = 物品直存库位（容器子位），
     首件锚点直读 it.loc；it.loc 空 → 旧容器链，行为不变。
     批量出库本就不做锚点比对（跨库位可继续扫），这里只派生展示锚点。 */
  let loc;
  if(it.loc){ loc=U.unique(st,'locations',it.loc); }
  else{
  if(!it.container)throw Error('物品档案缺少容器归属，请安全重拉核对后再试');
  const ctn=U.unique(st,'containers',it.container);
  /* TASK-06R：容器未定位时给一句人话（原行为是 code('') 抛裸 INVALID_CODE，用户看到天书） */
  if(!ctn.loc)throw Error('物品所在容器 '+ctn.code+' 尚未定位，请先定位该容器');
  loc=U.unique(st,'locations',ctn.loc);
  }
  if(!batch.anchor){
   /* P3：首件派生锚点带 sub 标记（仅展示语义；出库聚合按逐件 item.loc 取形，子位/容器可混批） */
   batch.anchor={loc:loc.code,ctn:null,sub:!!it.loc};
   session.rows.push({rowId:id(),kind:'issue',generation:0,
     values:[{type:'ITM',code:it.code,version:it.version}],
     locked:false,opId:null});
   session.active=session.rows.length-1;
   return {stage:'anchor',text:'✓ '+it.code+' 已入批（第 1 件）——首件库位 '+loc.code+'（出库不限库位，可跨库位继续扫）'};
  }
  if(!batch.targetQty)throw Error('请先输入本批数量并点「生成表单」');
  const _filled2=session.rows.filter(r=>!r.locked&&r.values.some(v=>v.type==='ITM')).length;
  if(_filled2>=batch.targetQty)throw Error('本批 '+batch.targetQty+' 个表单已全部填齐——请点「提交本批」');
    if(session.rows.some(r=>!r.locked&&r.values.some(v=>v.type==='ITM'&&v.code===p.code)))return {duplicate:true,text:'该件已在本批中，已忽略'};
  if(session.rows.filter(r=>!r.locked&&r.values.some(v=>v.type==='ITM')).length>=50)throw Error('本批已满 50 件（协议上限），请先提交本批再开新批');
  session.rows.push({rowId:id(),kind:'issue',generation:0,
    values:[{type:'ITM',code:it.code,version:it.version}],
    locked:false,opId:null});
  session.active=session.rows.length-1;
  const n=session.rows.filter(r=>!r.locked&&r.values.some(v=>v.type==='ITM')).length;
  return {stage:'item',text:'✓ '+it.code+' 已入批（第 '+n+' 件）'};
 }
 /* 2.53.1：命令终态（APPLIED/REJECTED）后从会话移除对应行——
    否则已完成的行永远占着「批次已包含此物品」防重检查，同一物品在本页的
    后续任何操作都被误拦（实测：换箱成功后立即出库同一物品被拒）。 */
 /* 2.58.1 Phase6（清单治理）：删除本行（仅草稿行；锁定行已入队，须到待处理区处理） */
 function removeRow(index){
  const target=session.rows[index];
  if(!target)throw Error('行不存在');
  /* 2.59.2：允许删除任何行（含已锁定）——锁定行的命令生命周期由 outbox/待处理区管理，
     行只是清单视图；被拒命令的行若不可删会变成永久僵尸（用户实测）。
     清空最后一行时自动补同类型空行。 */
  session.rows.splice(index,1);
  if(!session.rows.length)add(target.kind);
  if(session.active>=session.rows.length)session.active=session.rows.length-1;
  return true;
 }
 /* 清空全部未锁定草稿行（保留锁定行——它们对应待处理区命令），自动补一个当前类型空行 */
 function clearUnlocked(){
  session.rows=session.rows.filter(r=>r.locked);
  if(!session.rows.length)add('receive');
  if(session.active>=session.rows.length)session.active=session.rows.length-1;
  return true;
 }
  function forget(opId){
   /* 2.96.1 B2（批量修复）：批量行共享一个 opId——forget 必须删全部匹配行，
      不是只删第一个（否则批次完成后残留 N-1 行） */
   const matches=session.rows.filter(r=>r.opId===opId);
   if(!matches.length)return false;
   const kind=matches[0].kind;
   session.rows=session.rows.filter(r=>r.opId!==opId);
   /* v3.3.1：兜底行必须是 sequences 里真实存在的作业类型——kind 不在 sequences
      （如未来新增的无扫码行命令类型）时退回第一种，绝不能让 add 抛错炸掉调用方
      （实测：forget 抛错被调用方 catch 吞掉后 rows 清空 → render 读 r.kind 崩）。 */
   if(!session.rows.length)add(sequences[kind]?kind:Object.keys(sequences)[0]);
   if(session.active>=session.rows.length)session.active=session.rows.length-1;
   return true;
  }
 /* 2.96.1 B3（批量修复）：rebuild——保留已扫码值，从最新 state 重派版本+新 opId。
    旧 opId 已被服务端终态烧掉不能复用；清掉后下次 lock() 走 request() 用最新
    本地镜像重新派生 expected 版本。 */
 function rebuild(){row().locked=false;row().opId=null;row().generation++;}
 function request(){const r=row(),v=r.values;if(v.length!==stepsFor(r).length)throw Error('步骤尚未填齐');const st=getState();v.forEach(value=>U.unique(st,{LOC:'locations',CTN:'containers',ITM:'items'}[value.type],value.code));if(!r.opId)r.opId=id();
  /* 2.54.2 Phase2（物品驱动出库）：source 从 currentPosition 派生（服务端 pair/SOURCE_MISMATCH 仍终审）。
     P2（C4）：状态与归属校验拆开——子位直存物品 container 为空但**在库**，旧合并条件会把它误判成「不在库」。 */
  if(r.kind==='issue'){
   const it=U.unique(st,'items',v[0].code);
   if(it.status!=='in_stock')throw Error('物品当前不在库，不能出库');
   if(it.loc){
    /* P2（C3）子位出库请求形状：source={loc,container:'',sub:true}（子位无容器版本可派） */
    const loc=U.unique(st,'locations',it.loc);
    return {schemaVersion:1,opId:r.opId,kind:r.kind,itemCode:it.code,source:{loc:loc.code,container:'',sub:true},expected:{itemVersion:it.version}};
   }
   if(!it.container)throw Error('物品档案缺少容器归属，请安全重拉核对后再试');
   const ctn=U.unique(st,'containers',it.container);
   const loc=U.unique(st,'locations',ctn.loc);
   return {schemaVersion:1,opId:r.opId,kind:r.kind,itemCode:it.code,source:{loc:loc.code,container:ctn.code},expected:{itemVersion:it.version,containerVersion:ctn.version}};
  }
  const q={schemaVersion:1,opId:r.opId,kind:r.kind,expected:{containerVersion:v[1].version}};
 if(r.kind==='transfer'){
  /* 2.56.1 Phase3：source 从物品现状派生，target 取扫码目标（服务端 pair/SOURCE_MISMATCH 仍终审）。
     P2（A5/C3/C4）：源/目标各自按子位或容器取形（2×2）；子位侧无容器版本可派；
     目标是否子位由第 2 步 LOC 的 role 判定（与 stepsFor 同判）。 */
  const it=U.unique(st,'items',v[0].code);
  if(it.status!=='in_stock')throw Error('物品当前不在库，不能换箱');
  const tgtLoc=U.unique(st,'locations',v[1].code);
  const expected={itemVersion:it.version};
  let source;
  if(it.loc){
   const srcLoc=U.unique(st,'locations',it.loc);
   source={loc:srcLoc.code,container:'',sub:true};
  }else{
   if(!it.container)throw Error('物品档案缺少容器归属，请安全重拉核对后再试');
   const srcCtn=U.unique(st,'containers',it.container);
   const srcLoc=U.unique(st,'locations',srcCtn.loc);
   source={loc:srcLoc.code,container:srcCtn.code};
   expected.containerVersion=srcCtn.version;
  }
  if(tgtLoc.role==='容器子位'){
   return {schemaVersion:1,opId:r.opId,kind:r.kind,itemCode:it.code,
     source,
     target:{loc:tgtLoc.code,container:'',sub:true},
     expected};
  }
  const tgtCtn=U.unique(st,'containers',v[2].code);
  expected.targetContainerVersion=tgtCtn.version;
  return {schemaVersion:1,opId:r.opId,kind:r.kind,itemCode:it.code,
    source,
    target:{loc:tgtLoc.code,container:tgtCtn.code},
    expected};
 }
 else if(r.kind==='receive'){
  const locRow=(st.locations||[]).find(l=>l.code===v[0].code);
  if(locRow&&locRow.role==='容器子位'){
   /* P2（C3）子位入库请求形状：target={loc,container:'',sub:true}——container 显式空串
      靠 apply 的 hasOwn-preserve 清列；expected 只派 itemVersion（子位无容器版本可派）。
      此时步骤表为 ['LOC','ITM']，v[1] 即物品码，整体替换 :expected 种子（种子里的
      containerVersion 在 2 步子位行会错读物品版本）。 */
   q.itemCode=v[1].code;q.expected={itemVersion:v[1].version};
   q.target={loc:v[0].code,container:'',sub:true};
   return q;
  }
  q.itemCode=v[2].code;q.expected.itemVersion=v[2].version;q.target={loc:v[0].code,container:v[1].code};
 }
 else {q.itemCode=v[2].code;q.expected.itemVersion=v[2].version;q[r.kind==='verifyLegacy'?'target':'source']={loc:v[0].code,container:v[1].code};}
 return q;}
 function lock(){const q=request();row().locked=true;row().generation++;return q;}
 return {add,row,token,select,reset,accept,request,lock,forget,removeRow,clearUnlocked,rebuild,startBatch,stopBatch,batchState,acceptBatchCode,setBatchQty,stepsFor,unlock(){row().locked=false;row().generation++;},snapshot:()=>JSON.parse(JSON.stringify(session)),restore(value){session=JSON.parse(JSON.stringify(value));/* TASK-18（BUG-16）：旧草稿可能缺 rows/存着已废弃的 kind——不设防则 render 的 labels.forEach 与 add 的 sequences 查表都会炸掉整个物品页 */session.rows=(Array.isArray(session.rows)?session.rows:[]).filter(r=>r&&sequences[r.kind]&&Array.isArray(r.values));if(!session.rows.length){session.rows=[{rowId:id(),kind:'receive',generation:0,values:[],locked:false,opId:null}];}if(typeof session.active!=='number'||session.active<0||session.active>=session.rows.length)session.active=session.rows.length-1;session.rows.forEach(r=>r.generation++);}};
}
return {create,sequences};
});
