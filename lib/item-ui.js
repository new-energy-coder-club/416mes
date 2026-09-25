(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./unique-items'),require('./item-scan'));else root.ItemUI=factory(root.UniqueItems,root.ItemScan);})(typeof globalThis!=='undefined'?globalThis:this,function(U,Scan){
'use strict';
function mount({document:doc,getState,getPersistence,getCommands,id,mediaDevices,getClient,refreshConflicts,clearItmConflict,scanCamera,isOnline,qrSvg}){
 const el=n=>doc.getElementById(n),scan=Scan.create({getState,id});scan.add('receive');
 const status=text=>{el('itmStatus').textContent=text;};
 const searchStatus=text=>{el('itmSearchStatus').textContent=text;};
 /* 阶段B：统一扫码浮层。生产从 window.ScanCamera 取（按 document 共享单例）；
    测试注入 scanCamera 假组件验证接线，相机生命周期由 scan-camera 自己负责。 */
 function getScanCamera(){if(scanCamera)return scanCamera;const win=doc.defaultView;if(!win||!win.ScanCamera)return null;return win.ScanCamera.forDocument({document:doc,win,mediaDevices});}
 /* 确认卡摘要：先按码值找命中对象；作业页还要按当前步骤校验类型，不符禁止确定。 */
 function entitySummary(type,code){try{const st=getState(),r=U.unique(st,{LOC:'locations',CTN:'containers',ITM:'items'}[type],code);return types[type]+' '+code+' · '+(r.name||r.desc||r.spec||'');}catch(e){return {LOC:'库位',CTN:'容器',ITM:'物品'}[type]+' '+code+'（未建档）';}}
 function describeHit(hit){const raw=String(hit.text).trim();const win=doc.defaultView,LL=win&&win.ItemLink;const link=LL&&LL.parseScanText(raw);if(link)return entitySummary('ITM',link.code)+'（物品二维码）';const m=raw.match(/^(LOC|CTN|ITM)[:|](.+)$/);if(!m)return {text:'识别为'+hit.format+'，但内容没有类型前缀，查询时请确认编码'};return entitySummary(m[1],m[2]);}
 function describeWorkHit(hit){let raw=String(hit.text).trim();const win=doc.defaultView,LL=win&&win.ItemLink;const link=LL&&LL.parseScanText(raw);if(link)raw='ITM:'+link.code;const m=raw.match(/^(LOC|CTN|ITM)[:|](.+)$/);
 /* 2.99.0（批量相机修复）：批量模式激活时，确认卡按**批量阶段**判定（锚点/连扫），
    不再用单行草稿行的步骤——否则扫完库位锚点后扫容器会被误判「类型不符」 */
 const _bs=scan.batchState();
 if(_bs&&m){
  const expectedType=_bs.kind==='receive'
    ?(!_bs._loc?'LOC':(!_bs.anchor?'CTN':'ITM'))
    :'ITM';
  if(m[1]!==expectedType)return {text:'识别到的是'+types[m[1]]+'码「'+m[2]+'」，当前步骤需要'+types[expectedType]+'码'+(expectedType==='ITM'?'（锚点已定，连扫物品）':''),ok:false};
  return entitySummary(m[1],m[2]);
 }
 const r=scan.row(),expected=Scan.sequences[r.kind][r.values.length];
  /* 2.49.x：行已填齐时 expected 是 undefined，确认卡曾显示「当前步骤需要undefined码」，
     误导用户以为还要继续扫码（用户实测）。实际下一步是「确认本行，保存待提交」，无需再扫。 */
  if(!expected){if(r.locked)return {text:'本行已锁定，请在待处理区执行或查询云端结果，不能再扫码',ok:false};return {text:'本行步骤已填齐（'+r.values.map(v=>v.code).join(' → ')+'），无需再扫码。请关闭相机，核对后点「确认本行，保存待提交」',ok:false,action:'本行已填齐，无需重扫'};}
  if(!m){
   if(expected==='ITM'&&/^WP-[A-Za-z0-9_-]+$/.test(raw)){try{U.unique(getState(),'items',raw);return entitySummary('ITM',raw)+'（条形码）';}catch(e){return {text:'条形码 '+raw+' 未建档，不能确定填入',ok:false};}}
   return {text:'识别到'+hit.format+'内容「'+raw+'」，当前步骤需要'+types[expected]+'码',ok:false};}
  if(m[1]!==expected)return {text:'识别到的是'+types[m[1]]+'码「'+m[2]+'」，当前步骤需要'+types[expected]+'码',ok:false};
  return entitySummary(m[1],m[2]);}
 const types={locations:'库位',containers:'容器',items:'物品',LOC:'库位',CTN:'容器',ITM:'物品'};
 const kinds={receive:'入库',issue:'出库',transfer:'换箱',moveContainer:'容器移库',placeContainer:'容器定位',verifyLegacy:'旧物品核实（历史）',activateLocation:'核实启用库位',activateContainer:'核实启用容器',registerItem:'物品建档',registerLocation:'库位建档',registerContainer:'容器建档',retire:'物品退役',receiveBatch:'批量入库',issueBatch:'批量出库'};
  const states={active:'已启用',disabled:'已停用',inactive:'已停用',pending:'待入库',out:'已出库',in_stock:'在库',unknown:'待核实',retired:'已退役',PREPARED:'已准备，待确认',APPLIED:'已完成',REJECTED:'已拒绝',UNKNOWN:'结果待确认',unknown_commit:'结果待确认',needs_attention:'结果未回',REPAIR_REQUIRED:'需管理员处理'};
 const kindLabel=value=>kinds[value]||'待核实操作';
 const stateLabel=value=>states[value]||'状态待核实';
 const errZh={LEGACY_LOCATION_CONFLICT:'实物位置与档案旧库位不一致',CONTAINER_LOCATION_MISMATCH:'容器与库位归属不符',INVALID_TRANSITION:'当前状态不允许该操作',NOT_FOUND:'未找到对应档案',SOURCE_MISMATCH:'物品实际不在所记录容器（本机数据可能陈旧），请安全重拉后重新扫码',VERSION_CONFLICT:'数据刚被更新过，请刷新后重试',FORBIDDEN:'当前身份无权执行',STATE_CONFLICT:'状态冲突，请刷新后重试',
  /* v3.13.4（发现 K）：服务端 23 个 fail 码里有 10 个从未汉化，
     用户看到的是原始码（如 INACTIVE_ENTITY）。逐条补全。 */
  INACTIVE_ENTITY:'对象尚未核实启用或已停用：请先在建档管理页「核实启用」（或联系管理员）',
  INVALID_CODE:'编码格式不合法（为空、含首尾空格或超过160字符）',
  INVALID_STATE:'该记录的状态值不合法，请刷新后重试',
  MISSING_RELATION:'请求缺少必需的关联字段（如目标库位/容器）',
  INVALID_IN_STOCK_RELATION:'物品标记为在库但没有容器归属，数据不一致；请安全重拉后重试',
  VERSION_EXHAUSTED:'该记录版本号已到上限，请联系管理员处理',
  BATCH_EMPTY:'批量命令没有任何物品',
  BATCH_TOO_LARGE:'本批超过 50 件上限，请分批提交',
  DUPLICATE_IN_BATCH:'同一批量里出现了重复物品码，请去重后再提交',
  OPERATION_TABLE_READ_ONLY:'操作表当前为只读（库存数量账已封存）',CODE_ALREADY_REGISTERED:'编码已存在',ITM_HAS_NO_QTY:'唯一物品没有数量字段',UNSUPPORTED_CONTRACT:'请求格式不受支持',ALREADY_PLACED:'容器已绑定库位，如需移动请用「容器移库」',NO_CHANGE:'位置没有变化',
  /* E1（§三.2）：服务端发号/手动码校验的中文文案 */
  SERIAL_EXHAUSTED:'该分类序号已用尽，请联系管理员扩位',NON_CANONICAL_ITEM_CODE:'物品码写法不规范（应为 WP-分类-三位序号，如 WP-TS-001），不规范码没有短链',DUPLICATE_SHORTLINK_IDENTITY:'该码与已有物品的短链身份冲突（同分类同序号的不同写法），请核对实物后改码',BAD_CATEGORY:'物品分类无效，请选择八类之一',
  /* 快照/日志层（试飞残留数据会触发）：给出可操作的修复指引 */
  DUPLICATE_ENTITY:'飞书表存在重复记录（多为试飞期残留）：请在飞书对应表删除重复行后重试',AMBIGUOUS_RECORD:'飞书里同一编码有多条记录，请到对应表去重后重试',INCOMPLETE_TABLE:'飞书表读取不完整，请稍后重试（仍失败请联系管理员）',
  /* 入库实测（2.48.0）：高频死端错误的中文文案 */
  UNRESOLVED_ENTITY_CONFLICT:'该编码存在未核验的云端变更（本地与飞书不一致），作业已暂停；可现场核实启用，或安全重拉核对',UNRESOLVED_OPERATION_BARRIER:'飞书操作表存在未决命令，全部作业暂停；请先在待处理区查询处理未决命令',TRIAL_CONCURRENT_OPERATION_DETECTED:'与早前未完成的命令冲突（可能是你上一步超时的命令，并非其他设备），本命令已作废；可重建重提或重新扫码',OP_ID_PAYLOAD_CONFLICT:'同编号命令内容不一致，请刷新页面后重试',
  /* 3.7.0 C6：sweep 自动收口的服务端原文保留在云端日志（审计需要），前端映射成人话 */
  '过期未决命令自动收口':'上次提交未完成，本命令未生效，可重试',STALE_PREPARED_AUTO_SETTLED:'上次提交未完成，本命令未生效，可重试'};
 function errText(e){const code=(e&&typeof e==='object'&&e.code)||'';const raw=typeof e==='string'?e:(e&&e.message)||String(e);if(code&&errZh[code])return errZh[code]+'（'+code+'）';for(const k in errZh)if(raw.includes(k))return errZh[k]+'（'+k+'）';
  /* TASK-18（BUG-16）：TypeError 等程序性异常不得裸奔给用户——服务端往往已经成功，
     只是界面渲染/落账收尾时崩了。给一句人话并提示核对路径。 */
  if(/Cannot read propert|is not a function|undefined is not|Cannot convert|null is not an object/i.test(raw))
    return '界面处理出错（'+String(raw).slice(0,60)+'），本次操作可能已成功，请到「待处理区」或「操作记录」核对后再操作';
  return raw;}
 const stepLabels={receive:['目标库位','目标容器','入库物品'],issue:['出库物品（自动带出当前库位/容器）'],transfer:['待换箱物品（自动带出现状）','目标库位','目标容器'],moveContainer:['待移动容器（自动带出当前库位）','目标库位'],placeContainer:['待定位容器（未初始化可直接定位）','目标库位'],verifyLegacy:['核实库位','核实容器','旧物品']};
 function card(parent,title){const section=doc.createElement('article');section.className='itm-result-card';const h=doc.createElement('h3');h.textContent=title;section.appendChild(h);parent.appendChild(section);return section;}
 function meta(parent,text){const p=doc.createElement('p');p.className='itm-meta';p.textContent=text;parent.appendChild(p);}
 function positionSummary(table,r,st){
   try{
    if(table==='items'){
     let pos=null;try{pos=U.currentPosition(st,r.code);}catch(_){pos=null;}
     if(pos&&pos.container)return'当前 '+pos.container.code+' → '+pos.location.code;
     if(pos&&!pos.container)return pos.legacy?'旧定位，容器待核实：'+(pos.historicalLoc||'待核实'):'当前不在库'+(pos.historicalLoc?'；历史线索：'+pos.historicalLoc:'');
     return'档案存在但位置待核验';
    }
    if(table==='containers'){
     if(r.loc)return'当前库位：'+r.loc;
     const n=(st.items||[]).filter(i=>i.status==='in_stock'&&i.container===r.code).length;
     return'未定位'+(n?'（在库单件 '+n+'）':'');
    }
    const cs=(st.containers||[]).filter(c=>c.loc===r.code);
    return'容器 '+cs.length+' 个 · 在库单件 '+(st.items||[]).filter(i=>i.status==='in_stock'&&cs.some(c=>c.code===i.container)).length;
   }catch(_){return'';}
  }
  /* 阶段B-1（用户反馈「只知道名称、找不到东西在哪」）：结果卡直接带位置摘要 ——
     复用 detail() 同源的位置计算，用户不必逐条点「查看详情」才知道东西在哪。 */
  function candidate(parent,table,r,st){const section=card(parent,types[table]+' · '+(r.name||r.desc||r.spec||'未命名'));line(section,r.code);line(section,'状态：'+stateLabel(r.status));const pos=st&&positionSummary(table,r,st);if(pos)line(section,'位置：'+pos);section.appendChild(button('查看'+types[table]+'详情',()=>detail(table,r.code)));}
 function button(text,action){const b=doc.createElement('button');b.type='button';b.className='btn ghost';b.textContent=text;b.addEventListener('click',action);return b;}
 function line(parent,text){const p=doc.createElement('p');p.textContent=text;parent.appendChild(p);}
 function detail(table,code){const results=el('itmResults');results.replaceChildren();searchStatus('查询详情 · 只读，不改变库存');try{
 const st=getState();let r,conflicted=false;
 /* 2.49.2：查询是只读操作，冲突守卫（U.unique）不该拦住它——否则冲突实体连详情都看不了，
    而详情里的冲突提示成了永远执行不到的死代码（用户实测：查询失败空白）。 */
 try{r=U.unique(st,table,code);}catch(e){if((e&&e.code)==='UNRESOLVED_ENTITY_CONFLICT'){conflicted=true;r=(st[table]||[]).find(x=>x.code===code);if(!r)throw e;}else throw e;}
 const box=card(results,types[table]+' · '+(r.name||r.desc||r.spec||'未命名'));line(box,code);line(box,'状态：'+stateLabel(r.status));
 if(table==='items'){let pos=null;try{pos=U.currentPosition(st,code);}catch(_){pos=null;}line(box,'规格：'+(r.spec||'')+'；数量：1；版本：'+r.version);line(box,pos&&pos.container?'当前 '+pos.container.code+' → '+pos.location.code:(pos?(pos.legacy?'旧定位，容器待核实：':'当前不在库；历史线索：')+pos.historicalLoc:'档案存在但位置待核验（存在冲突）'));if(pos&&pos.container)box.appendChild(button('容器 '+pos.container.code,()=>detail('containers',pos.container.code)));
 (st.itemOperations||[]).filter(o=>o.itemCode===code||(o.after&&o.after.items||[]).some(i=>i.code===code)).forEach(o=>{line(box,kindLabel(o.kind)+' · '+stateLabel(o.phase));meta(box,'操作编号：'+o.code);});
 }else if(table==='containers'){line(box,'当前库位：'+(r.loc||'未定位'));if(r.loc)box.appendChild(button('库位 '+r.loc,()=>detail('locations',r.loc)));const items=(st.items||[]).filter(i=>i.status==='in_stock'&&i.container===code);line(box,'在库单件：'+items.length);items.forEach(i=>box.appendChild(button(i.code+' '+(i.name||''),()=>detail('items',i.code))));
 }else{const cs=(st.containers||[]).filter(c=>c.loc===code);line(box,'容器数：'+cs.length+'；在库单件：'+(st.items||[]).filter(i=>i.status==='in_stock'&&cs.some(c=>c.code===i.container)).length);cs.forEach(c=>box.appendChild(button(c.code,()=>detail('containers',c.code))));(st.items||[]).filter(i=>i.status==='unknown'&&i.loc===code).forEach(i=>box.appendChild(button('旧定位未绑定 '+i.code,()=>detail('items',i.code))));}
 if(conflicted||(st.__itmConflicts&&st.__itmConflicts[table+':'+code])){const c=st.__itmConflicts&&st.__itmConflicts[table+':'+code];line(box,'⚠ 该编码存在未核验的云端变更，相关作业已暂停（填入时会给出现场核实入口）');if(c&&c.observed)line(box,'云端观察值：'+JSON.stringify(c.observed));if(c&&c.local)line(box,'本机值：'+JSON.stringify(c.local));}
 meta(box,'同步时间：'+(st.__savedAt||'待同步'));
 }catch(e){searchStatus('查询失败：'+e.message);}}
 function search(){let q=el('itmSearch').value.trim();const box=el('itmResults');box.replaceChildren();
  /* D2（§六待修③）：手输/扫码枪回车也先过 resolveLinkText —— 整条 /i/8位 短链或裸 8 位码
     都归一成物品码再查（相机确认卡走的 queryScan 已有此归一，这里补齐手输入口）。
     归一后回写输入框，让用户看见系统把短链认成了哪个物品码。 */
  const resolved=resolveLinkText(q);if(resolved!==q){q=resolved;el('itmSearch').value=resolved;}
  try{const st=getState();const typed=q.match(/^(LOC|CTN|ITM)[:|]\s*(.+)$/);const tables=typed?[{LOC:'locations',CTN:'containers',ITM:'items'}[typed[1]]]:['locations','containers','items'];const key=typed?typed[2].trim():q;   /* 2.49.5：冒号后带空格（ITM: WP-001）此前误报未找到（审计 bug②） */const exact=tables.flatMap(table=>(st[table]||[]).filter(r=>r.code===key).map(r=>({table,r})));if(exact.length===1){detail(exact[0].table,key);return;}if(exact.length>1){searchStatus('编码有多个候选，请按类型选择；同表重复码禁止作业');line(box,'编码有多个候选，请按类型选择');exact.forEach(({table,r})=>candidate(box,table,r,st));return;}if(typed){searchStatus('该类型未找到编码：'+key);return;}
  /* 阶段B-2（名称/关键词模糊查找，全表字段对齐）：
     ① 每张表按**它自己真实存在的字段**匹配，不再用一组通用字段名遍历三表
        （locations 原只有 code/desc 命中 → 补 kind；containers 漏 loc → 补；
         items 漏 category/status/materialCode → 补；库位类型「货架库位」由此可搜）。
     ② 多关键词 AND：输入「内六角 扳手」拆词后都要命中，缓解词序颠倒/规格混写漏检。
     ③ 空查询守卫：q 为空**不再全表渲染**（扫码枪误触回车/输入法残留会把全库刷成卡片，
        移动端直接卡死）→ 给可操作的空态引导。
     ④ 排序 + 上限：物品优先，其次容器、库位；物品内 name 精确匹配优先；
        上限 RESULT_CAP，超出时明说「另有 N 条」并提示继续输入缩小范围。 */
  const SEARCH_FIELDS={locations:['code','kind','desc','grants'],containers:['code','type','spec','loc'],items:['code','name','spec','category','materialCode']};
  const TABLE_ORDER={items:0,containers:1,locations:2};
  const RESULT_CAP=60;
  if(!q){
   searchStatus('请输入名称、规格、分类或编码（例如「扳手」「M3」「货架库位」）；也可以点「相机查询」对准标签');
   line(box,'按名称查找：输入物品名称的任意一段（如「内六角」），或规格、分类、物料码。不知道码也能查。');
   line(box,'精确查找：输入完整编码；带前缀可指定类型 —— LOC: 库位 · CTN: 容器 · ITM: 物品。');
   return;
  }
  const words=q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits=[];
  for(const table of ['locations','containers','items']){
   const fields=SEARCH_FIELDS[table]||['code'];
   for(const r of st[table]||[]){
    const hay=fields.map(f=>String(r[f]==null?'':r[f]).toLowerCase());
    if(words.every(w=>hay.some(v=>v.includes(w))))hits.push({table,r});
   }
  }
  hits.sort((a,b)=>{
   const oa=TABLE_ORDER[a.table],ob=TABLE_ORDER[b.table];
   if(oa!==ob)return oa-ob;                                  // 物品 → 容器 → 库位
   const an=String(a.r.name||'').toLowerCase(),bn=String(b.r.name||'').toLowerCase();
   if(an&&an===q.toLowerCase())return -1;                    // 名称与输入完全相同 → 最前
   if(bn&&bn===q.toLowerCase())return 1;
   return String(a.r.code||'').localeCompare(String(b.r.code||''));
  });
  const shown=hits.slice(0,RESULT_CAP);
  shown.forEach(({table,r})=>candidate(box,table,r,st));
  if(hits.length>shown.length)line(box,'另有 '+(hits.length-shown.length)+' 条同名/同规格记录未显示 —— 请继续输入名称或规格缩小范围。');
  searchStatus(hits.length
   ?'找到 '+hits.length+' 条记录（显示前 '+shown.length+' 条）· 仅查询，不改变库存'
   :'未找到匹配「'+q+'」的记录，请核对名称或换个关键词。');
 }catch(e){searchStatus('查询失败：'+e.message);}}
 const recoveryResults=new Map();
 function reviewPanels(){
  const st=getState(),box=el('itmRecoveryReview');box.replaceChildren();
  const commands=Array.isArray(st.__itmRecoveryReview?.commands)?st.__itmRecoveryReview.commands:[];
  line(box,'导入含待复核命令 '+commands.length+' 条，未自动重发；查询仅展示，不更新本机实体或队列。');
  commands.forEach(c=>{const opId=c.id||c.request?.opId;const section=doc.createElement('div');meta(section,'原命令编号：'+(opId||'缺失，禁止查询'));const pre=doc.createElement('pre');pre.textContent=JSON.stringify(c,null,2);section.appendChild(pre);if(typeof opId==='string'&&opId&&getClient)section.appendChild(button('只读查询原命令结果',()=>run(async()=>{const result=await getClient().inspect(opId);recoveryResults.set(opId,result);reviewPanels();})));if(recoveryResults.has(opId)){const out=doc.createElement('pre');out.textContent='查询结果（未应用）：'+JSON.stringify(recoveryResults.get(opId),null,2);section.appendChild(out);}box.appendChild(section);});
  const conflicts=el('itmConflictPanel');conflicts.replaceChildren();const entries=Object.entries(st.__itmConflicts||{});line(conflicts,'未解冲突 '+entries.length+' 个；暂停相关作业。重拉仅核验，不能任选本地/远端覆盖。');
  entries.forEach(([key,c])=>{line(conflicts,'对象：'+key+'；原因：'+(c.reason||'待核验'));const pre=doc.createElement('pre');pre.textContent=JSON.stringify({local:c.local,observed:c.observed},null,2);conflicts.appendChild(pre);
   /* 阶段31b（用户反馈「到建档管理也没用」）：冲突没有用户出口 → 给人工核实后的解除按钮。
      解除走 mount 注入的 clearItmConflict（走既有存盘队列，留日志）。 */
   if(typeof clearItmConflict==='function')conflicts.appendChild(button('✓ 我已核实两边一致，解除作业暂停',()=>run(async()=>{
     if(!confirm('解除「'+key+'」的作业暂停？\n\n仅在你已确认本地与飞书数据一致时使用。\n解除后该编码可正常作业，操作会写日志留痕。'))return;
     await clearItmConflict(key);status('已解除：'+key);await reviewPanels();
   })));});
  /* 2.48.0：冲突详情原本只埋在「建档管理」页的折叠 details 里，作业页完全不可见——
     用户看到的是裸错误文案却不知道原因。作业页顶部常驻横幅补齐这块可视化。 */
  const banner=el('itmConflictBanner');
  if(banner){banner.replaceChildren();
   if(entries.length){banner.hidden=false;
    /* 2.50.1：折叠化——默认只占一行，移动端不再被长清单把作业区挤出首屏 */
    const det=doc.createElement('details');
    const sum=doc.createElement('summary');sum.textContent='⚠ 有 '+entries.length+' 个编码存在未核验的云端变更，相关作业已暂停（点开查看清单）';
    det.appendChild(sum);
    const body=doc.createElement('div');
    line(body,'涉及：'+entries.map(([k])=>k).join('、')+'。填入这些编码时会给出「现场核实并启用」入口；或到「建档管理」页核实两边数据一致后解除暂停。');
    det.appendChild(body);
    banner.appendChild(det);
   }else banner.hidden=true;
 }
 }
 el('itmConflictRefresh').addEventListener('click',()=>run(async()=>{if(!refreshConflicts)throw Error('请在同步页只读拉取并检查日志，不要推送覆盖');await refreshConflicts();reviewPanels();status('重拉检查完成；仍未解冲突继续阻断，请核对实物/操作凭据');}));
 /* 2.49.2：草稿自动保存/恢复——此前扫码行只存在内存里，刷新即丢（用户实测：三步填齐后
    刷新，草稿消失，而启用库位/容器的命令早已真实提交，物品还 pending，看似「半程 bug」）。
    启用操作本就是独立真实操作；丢的只是草稿 → 每次渲染持久化会话快照，挂载后自动恢复。 */
 function persistSession(){const p=getPersistence();if(!p||typeof p.saveDraft!=='function')return;try{const snap=scan.snapshot();snap.savedAt=Date.now();const result=p.saveDraft(snap.sessionId,snap);if(result&&typeof result.catch==='function')result.catch(()=>{});}catch(_){/* 草稿持久化失败不打扰，手动「保存草稿」仍可用 */}}
 let draftsDropped=0;
 async function autoRestoreDraft(){
  let p=getPersistence(),tries=0;
  while((!p||typeof p.recover!=='function')&&tries<10){await new Promise(r=>setTimeout(r,200));p=getPersistence();tries++;}   // boot 未就绪时短暂等待
  if(!p||typeof p.recover!=='function')return;
  const recovered=await p.recover();
  const drafts=((recovered&&recovered.drafts)||[]).map(d=>d&&d.value).filter(v=>v&&Array.isArray(v.rows));
  /* 只恢复「有未完成且已填过至少一步」的最近草稿；已锁定行本就显示在待处理区，无需还原 */
  /* 2.58.1：序列升级后旧草稿可能错位——逐行校验长度与类型，不匹配的草稿整份丢弃 */
  const seqs=Scan.sequences;
  /* 2.59.2：锁定行必须有 outbox 命令背书才保留——被拒/已完成的命令已被 acknowledge
     清出队列，其行是永久僵尸（删不掉、恢复又回来），直接丢弃（历史在操作记录里仍有）。 */
  const liveIds=new Set(((recovered&&recovered.commands)||[]).map(c=>c.id||c.opId));
  const candidates=drafts.map(v=>{
    const rows=(v.rows||[]).filter(r=>!r.locked||liveIds.has(r.opId));
    return {value:{...v,rows},kept:rows.length};
  }).filter(v=>v.kept>0&&v.value.rows.every(r=>{
    const seq=seqs[r.kind];if(!seq)return false;
    if(r.values.length>seq.length)return false;
    return r.values.every((val,i)=>val.type===seq[i]);
  })).map(v=>v.value);
  candidates.forEach(v=>{const n=v.rows.length;v.rows=v.rows.filter(r=>!r.locked||(r.values||[]).length>0);void n;});
  const usable=candidates.filter(v=>v.rows.some(r=>!r.locked&&(r.values||[]).length>0));
  if(!usable.length)return;
  draftsDropped=drafts.length-usable.length;
  candidates.length=0;
  candidates.push(...usable);
  candidates.sort((a,b)=>(b.savedAt||0)-(a.savedAt||0));
  scan.restore(candidates[0]);
  render();
  status('已自动恢复上次未完成的扫码行；可继续填入、重扫或确认'+(draftsDropped?'（已丢弃 '+draftsDropped+' 份不兼容旧草稿）':''));
 }
 function render(){
  reviewPanels();const snapshot=scan.snapshot(),r=scan.row(),body=el('itmRowTable');body.replaceChildren();
  persistSession();
  snapshot.rows.forEach((entry,index)=>{const tr=doc.createElement('tr');const operation=(getState().itemOperations||[]).find(o=>o.code===entry.opId);const rowStatus=operation?(operation.phase==='REJECTED'?'已拒绝：'+(operation.error||'请重新建行'):stateLabel(operation.phase)):entry.locked?'待提交/待确认':'草稿';const values=[String(index+1),entry.values.filter(v=>v.type==='LOC').map(v=>v.code).join(' → ')||'—',entry.values.filter(v=>v.type==='CTN').map(v=>v.code).join(' → ')||'—',entry.values.find(v=>v.type==='ITM')?.code||'—',kindLabel(entry.kind),rowStatus];values.forEach((value,i)=>{const td=doc.createElement('td');td.setAttribute('data-th',['行','库位','容器','物品','操作','状态'][i]);td.textContent=value;tr.appendChild(td);});tr.tabIndex=0;tr.setAttribute('aria-selected',String(index===snapshot.active));const select=()=>{stopCamera();scan.select(index);render();};tr.addEventListener('click',select);tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});body.appendChild(tr);});
  el('itmRows').replaceChildren();snapshot.rows.forEach((row,index)=>{const o=doc.createElement('option');o.value=String(index);o.textContent='第 '+(index+1)+' 行 · '+kindLabel(row.kind)+(row.locked?' · 已锁定':' · 草稿');o.selected=index===snapshot.active;el('itmRows').appendChild(o);});
  /* 2.83.0（批量 UI 补全）：行工具区的「合并提交本批」——同类草稿行 ≥2 时显示。
     TASK-06 起出库不限库位（原要求同库位）。
     放在 render 里而非 pending 区：合并发生在「确认」之前，那时还没有任何命令。 */
 (function(){
   const host=el('itmRowClearAll')&&el('itmRowClearAll').parentElement;
   if(!host)return;
   let mb=doc.getElementById('itmMergeBatchBtn');
   const groups={};
   (snapshot.rows||[]).forEach((row,i)=>{
     if(row.locked)return;
     const seq=Scan.sequences[row.kind]||[];
     if(row.values.length!==seq.length)return;
     if(!['receive','issue'].includes(row.kind))return;
     (groups[row.kind]=groups[row.kind]||[]).push(i);
   });
   const found=['receive','issue'].filter(k=>(groups[k]||[]).length>=2).map(k=>({kind:k,n:groups[k].length,idxs:groups[k]}))[0];
   if(!found){if(mb)mb.remove();return;}
   if(!mb){mb=doc.createElement('button');mb.id='itmMergeBatchBtn';mb.className='btn';host.insertBefore(mb,el('itmRowClearAll'));}
   mb.textContent='合并提交本批（'+(found.kind==='receive'?'入库':'出库')+' '+found.n+' 件）';
   mb.onclick=()=>run(async()=>{await mergeSubmitBatch(found.kind,found.idxs);});
 })();
  /* 2.98.0 Phase 2：批量模式激活时，itmStep 区显示批量面板（锚点+计数器+最近件+提交/放弃） */
 const _batch=scan.batchState();
 if(_batch){
   const batchRows=snapshot.rows.filter(row=>!row.locked&&row.values.some(v=>v.type==='ITM'));
   const n=batchRows.length;
   const anchorTxt=_batch.anchor?(_batch.anchor.loc+(_batch.anchor.ctn?' / '+_batch.anchor.ctn:'')):(_batch.kind==='receive'?(_batch._loc?'容器（待扫）':'库位（待扫）'):'（首件自动派生）');
   const step2=el('itmStep');
   step2.replaceChildren();
   const _head=doc.createElement('p');
   const _nC=batchRows.filter(r=>r.confirmed!==false).length;
   /* F3：声明数量时显示 confirmed/targetQty，否则 confirmed/rows */
   const _cntTxt=_batch.targetQty?('已确认 '+_nC+' / 目标 '+_batch.targetQty+' 件'):('本批 '+_nC+'/'+n+' 件已确认');
   _head.innerHTML='📦 批量'+(_batch.kind==='receive'?'入库':'出库')+' · 锚点 '+anchorTxt+' · <b>'+_cntTxt+'</b>';
   step2.appendChild(_head);
   /* 2.99.4（用户准确模型·数量先行）：先定数量 → 生成 N 个表单槽 → 每扫一件填一个槽 */
   /* F2：数量输入框只在「targetQty 未设定」时出现——不依赖易丢失的 _qtyForm 标志
      （targetQty 存在 batch 对象里，草稿恢复后天然正确） */
   if(!_batch.targetQty){
     const _qf=doc.createElement('p');_qf.className='itm-batch-qty';
     _qf.innerHTML='本批共 <input class="field" id="itmBatchQty" type="number" min="1" max="50" style="width:64px" placeholder="N"> 件 <button class="btn" id="itmBatchQtyGo">生成表单</button>';
     step2.appendChild(_qf);
     const go=()=>run(()=>{
       const n=parseInt(el('itmBatchQty').value,10);
       scan.setBatchQty(n);   /* 2.99.5：写活会话（batchState() 是深拷贝，改副本无效） */
       status('已生成 '+n+' 个表单槽——请逐件扫描物品码（每扫一件填一个表单）');
       try{el('itmCode').focus();}catch(_){ }
     });
     step2.querySelector('#itmBatchQtyGo').addEventListener('click',go);
     step2.querySelector('#itmBatchQty').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();go();}});
   }
   const _tq=_batch.targetQty||0;
   batchRows.forEach((row,i)=>{const it=row.values.find(v=>v.type==='ITM');if(it)line(step2,'表单 '+(i+1)+' ✓ '+it.code);});
   for(let i=n;i<_tq;i++)line(step2,'表单 '+(i+1)+' ◌（待扫）');
   el('itmCode').placeholder=_batch.anchor||_batch.kind==='issue'?'连扫物品码（WP-… / ITM:… / 短链），回车入批':'扫锚点（'+( _batch._loc?'容器 CTN:':'库位 LOC:')+'）';
   const _nC2=batchRows.filter(r=>r.confirmed!==false).length;
   el('itmConfirm').disabled=_nC2===0;
   el('itmConfirm').textContent='提交本批（'+_nC2+' 件）';
   const _ab=doc.getElementById('itmBatchAbandon');if(_ab)_ab.style.display='';
   let sticky=doc.getElementById('itmBatchSticky');
   if(!sticky){
     sticky=doc.createElement('div');sticky.id='itmBatchSticky';sticky.className='itm-batch-sticky';
     sticky.innerHTML='<span id="itmBatchStickyN"></span><button class="btn itm-btn-primary" id="itmBatchStickySubmit"></button>';
     doc.body.appendChild(sticky);
     sticky.querySelector('#itmBatchStickySubmit').addEventListener('click',()=>run(async()=>{await submitBatchMode();}));
   }
   sticky.classList.add('batch-on');
   const _nC3=batchRows.filter(r=>r.confirmed!==false).length;
   sticky.querySelector('#itmBatchStickyN').textContent=_batch.targetQty?('已确认 '+_nC3+' / 目标 '+_batch.targetQty+' 件'):('已确认 '+_nC3+'/'+n+' 件');
   const sb=sticky.querySelector('#itmBatchStickySubmit');
   sb.textContent='提交本批';sb.disabled=_nC3===0;
 } else {
  el('itmConfirm').textContent='确认本行，保存待提交';
  const _ab2=doc.getElementById('itmBatchAbandon');if(_ab2)_ab2.style.display='none';
  const _st2=doc.getElementById('itmBatchSticky');if(_st2)_st2.classList.remove('batch-on');
   const step=el('itmStep'),labels=stepLabels[r.kind]||stepLabels.receive,sequence=Scan.sequences[r.kind]||Scan.sequences.receive;step.replaceChildren();line(step,'第 '+(snapshot.active+1)+' 行 · '+kindLabel(r.kind)+' · '+(['moveContainer','placeContainer'].includes(r.kind)?'整容器作业':'物品数量固定1'));
  const list=doc.createElement('ol');labels.forEach((label,index)=>{const li=doc.createElement('li');li.textContent=(r.values[index]?'✓ ':'')+(index+1)+' '+label+(r.values[index]?'：'+r.values[index].code:'');if(index===r.values.length)li.setAttribute('aria-current','step');list.appendChild(li);});step.appendChild(list);
  /* 2.54.0 Phase1：容器移库扫完容器即显示当前库位，用户据此决定目标 */
  if(r.kind==='moveContainer'&&r.values.length>=1){try{const cv=U.unique(getState(),'containers',r.values[0].code);line(step,'容器当前库位：'+(cv.loc||'未定位'));}catch(_){}}
  /* 2.54.2 Phase2：出库扫完物品即展示现状（当前库位/容器），来源由系统派生 */
  /* 2.58.0 Phase5：入库扫到 unknown 旧档案物品 → 提示本次入库同时完成核实 */
  if(r.kind==='receive'&&r.values.length===2){try{const it=U.unique(getState(),'items',r.values[1].code);if(it.status==='unknown')line(step,'ℹ 该物品是旧档案（未核实），本次入库将同时完成核实');}catch(_){}}
  if((r.kind==='issue'||r.kind==='transfer')&&r.values.length===1){try{const pos=U.currentPosition(getState(),r.values[0].code);if(pos.container&&pos.location)line(step,'物品现状：在库 @ '+pos.location.code+' / '+pos.container.code+(r.kind==='issue'?'——确认后即从该位置出库':'——请继续扫描目标库位与容器'));}catch(_){}}
  line(step,r.locked?'本行已锁定，请在待处理区执行或查询云端结果。':r.values.length===sequence.length?'步骤已填齐，请核对后确认；确认仅保存待提交命令。':'当前请填写：'+labels[r.values.length]+'（'+sequence[r.values.length]+':）');
  el('itmCode').placeholder=r.values.length<sequence.length?'扫描或输入 '+sequence[r.values.length]+': 编码':'本行已填齐，请核对后确认';el('itmConfirm').disabled=r.locked||r.values.length!==sequence.length;
 }
  /* E1「去入库」：入库行走到物品步骤且输入框为空时，自动带入刚建档的新码 */
  const _seq=Scan.sequences[r.kind]||[];
  if(prefillItem&&r.kind==='receive'&&!r.locked&&_seq[r.values.length]==='ITM'){const inp=el('itmCode');if(!inp.value)inp.value='ITM:'+prefillItem;}
 }
 async function run(action,sink){try{await action();render();}catch(e){(sink||status)(errText(e));}}
/* BUG-7（v3.13.0）：状态文案原先硬编码「才真正入库」，在**出库**行上也这么提示——
   术语直接矛盾，出/入库方向搞反是库存事故。按行类型取词。
   TASK-18（BUG-13）：原先只分入库/其它，换箱/移库/定位/核实全显示「才真正出库」，
   方向性误导——改为按 kind 映射。 */
const SUBMIT_HINTS={receive:'入库',issue:'出库',transfer:'换箱',moveContainer:'移库',placeContainer:'定位',verifyLegacy:'核实'};
function submitHint(kind){return SUBMIT_HINTS[kind]||'提交';}
 function accept(text,token){return run(()=>{const result=scan.accept(text,token);if(result&&result.ignored){status('页面状态已变化（行已切换或修改），这次填入被忽略，请重新扫码');return;}if(result&&result.duplicate){status('该码与上一步相同，重复扫码已忽略');return;}el('itmCode').value='';if(prefillItem&&scan.row().values.some(v=>v.type==='ITM'&&v.code===prefillItem))prefillItem=null;const done=scan.row(),seq=Scan.sequences[done.kind];status(done.values.length===seq.length?('本行已填齐（草稿未提交，库存还没动）：请点「确认本行，保存待提交」，再到待处理区提交后才真正'+submitHint(done.kind)):'已填写草稿，尚未提交');try{el('itmCode').focus();}catch(_){}});}
 /* 首次核实引导：旧库位/容器状态为 unknown 时，填入会被领域层拦截（正确），
    但用户实测「点了没反应、流程断掉」。这里在错误旁给出一键动作：
    生成 activateLocation/activateContainer 命令 → 提交 → APPLIED 后自动重试填入。 */
 function statusAction(text,btnText,fn){const box=el('itmStatus');box.textContent=text+' ';const b=button(btnText,()=>run(fn));box.appendChild(b);}
 /* 只读查实体状态；查不到（NOT_FOUND/冲突）返回 null，不参与分支判断 */
 function entityStatus(table,code){try{return U.unique(getState(),table,code).status;}catch(_){return null;}}
 /* 3.2.2：解除目标实体上「本操作刚生成凭据」可覆盖的未核验标记。
    只删**本次 activate* 真正覆盖**的 reason 清单（与 acknowledge / merge 的解除
    清单逐字对齐：item-persistence.js:178、item-sync proof、unique-items uniqueForActivation
    注释同款），不碰外部编辑类冲突——那类仍需人工核对两边数据。 */
 function clearStaleActivationConflict(type,code){
  const st2=getState(),mapKey=(type==='LOC'?'locations:':'containers:')+code,cur=st2.__itmConflicts&&st2.__itmConflicts[mapKey];
  if(!cur)return;
  const ackClears=['unverified-controlled-change','incomplete-controlled-group','server-location-unverified','server-snapshot-unverified'];
  if(!ackClears.includes(cur.reason))return;
  delete st2.__itmConflicts[mapKey];
  if(typeof clearItmConflict==='function')Promise.resolve(clearItmConflict(mapKey)).catch(()=>{});
 }
 async function guidedActivate(type,code,retry,opts){
  const p=getPersistence();if(!p)throw Error('IDB不可用，不能核实启用');
  if(!getClient)throw Error('当前不支持在线提交，请稍后联网重试，或到待处理区执行');
  const st=getState();let request;
  const conflict=(st.__itmConflicts||{})[(type==='LOC'?'locations:':'containers:')+code];
  /* 3.2.2（用户实测「点了现场确认启用，反而报未找到该库位档案」）：entityStatus 走
     U.unique——冲突守卫先于 NOT_FOUND 抛出，状态被吞成 null，「明明存在的库位」
     于是被判成查无此档。现场核实的读取必须与域层同款：对目标实体自身临时豁免冲突
     守卫（unique-items.js uniqueForActivation）——凭据本就由这次操作产生，
     不豁免则凭据永远无法生成（unique-items.js:51 同款注释）。 */
  function activationEntity(table,key){
   try{return U.uniqueForActivation(st,table,key);}catch(_){return null;}
  }
  if(type==='LOC'){
   /* expected 优先取本地；本地被冲突堵死/读不到时退回云端观察值——现场核实本就以实物/云端为准 */
   const local=activationEntity('locations',code);
   let expectedStatus=local?local.status:undefined;
   if(expectedStatus==null)expectedStatus=conflict&&conflict.observed?conflict.observed.status:undefined;
   if(!expectedStatus)throw Error('未找到该库位档案：'+code+'（本地与云端视图都没有这条库位；请先到「同步与状态」安全重拉核对，或到「资源档案」确认该库位存在）');
   request={schemaVersion:1,opId:id(),kind:'activateLocation',locationCode:code,expected:{locationStatus:expectedStatus}};
  }
   else{
     /* P1a（用户实测：批量入库扫完库位锚点，容器未启用时引导反而报「请先扫描该容器所在的库位码」）：
        批量模式的库位锚点存在 batch._loc / batch.anchor.loc，**不在当前行 values 里**
        （物品行是锚点定完后才合成的）。LOC 解析链：opts.targetLoc（建档管理「核实启用」面板
        用户手填的目标库位）→ 当前行 → 批量锚点 → 容器现存位置（就地启用），
        都没有才报「请先扫描库位码」。 */
     const _batch=scan.batchState();
     let locValue=(opts&&opts.targetLoc&&{code:opts.targetLoc})
       ||(scan.row().values||[]).find(v=>v.type==='LOC')
      ||(_batch&&((_batch.anchor&&_batch.anchor.loc&&{code:_batch.anchor.loc})||(_batch._loc&&_batch._loc.code&&{code:_batch._loc.code})))
      ||null;
    if(!locValue){
      const _cur=activationEntity('containers',code);
      const _own=(_cur&&_cur.loc)||(conflict&&conflict.observed&&conflict.observed.loc)||'';
      if(!_own)throw Error('请先扫描该容器所在的库位码');
      locValue={code:_own};   // 就地启用：目标即容器档案现存位置；若与实物不符，服务端 LEGACY_LOCATION_CONFLICT 仍有「以现场为准」出口
    }
   const localC=activationEntity('containers',code);
   let version=localC?localC.version:undefined;
   if(version==null)version=conflict&&conflict.observed?conflict.observed.version:null;
   if(version==null)throw Error('未找到该容器档案：'+code+'（本地与云端视图都没有这条容器；请先到「同步与状态」安全重拉核对，或到「资源档案」确认该容器存在）');
   request={schemaVersion:1,opId:id(),kind:'activateContainer',containerCode:code,target:{loc:locValue.code},expected:{containerVersion:version},...(opts&&opts.confirmLegacyLocOverride?{confirmLegacyLocOverride:true}:{})};
  }
   status('已生成核实启用命令，正在提交…');render();
   /* v3.4.0 R2（用户实测「只提交了一个容器启用，待处理区出现两个审核」）：enqueue 只按 opId
      去重（item-persistence.js:107），扫码引导与建档管理「核实启用」可对同一实体各生成一条
      命令并存。启用是幂等的（unique-items.js active→active 重确认放行），入队前自动删掉
      同 kind 同实体的旧未决卡——直接替换，双卡从此不可能。 */
   try{
    const _p2=getPersistence();
    if(_p2&&typeof _p2.abandonCommand==='function'){
     const _field=request.kind==='activateLocation'?'locationCode':'containerCode';
     const _olds=((await getCommands())||[]).filter(c=>c.request&&c.request.kind===request.kind&&c.request[_field]===code&&!['APPLIED','REJECTED'].includes(c.status));
     for(const _o of _olds){try{await _p2.abandonCommand(_o.id);}catch(_){ }}
    }
   }catch(_){ }
   await p.enqueue(request);await pending();
  const cmds=await getCommands();const cmd=(cmds||[]).find(x=>x.id===request.opId);
  if(!cmd)throw Error('命令未保存，请到待处理区检查');
   let result;
   /* v3.5.0（用户拍板「启用彻底不留卡」）：任何失败路径都删除本机命令卡 + 就地给「重试启用」
      ——重试 = 换新 opId 重新走 guidedActivate（云端已生效则幂等 APPLIED；云端未决则新命令
      正常执行、旧行由 sweep 收口）。待处理区从此不出现启用卡。 */
   const abandonActivation=async()=>{try{await p.abandonCommand(request.opId);}catch(_){ }};
   const retryActivation=()=>run(()=>guidedActivate(type,code,retry,{...(opts||{}),_rebuilt:true}));
   try{result=await getClient().submit(cmd);}
   catch(e){
    await abandonActivation();await pending();
    statusAction('启用命令提交失败：'+errText(e)+'；已清理本机记录，可直接重试','重试启用',retryActivation);
    return;
   }
   if(result&&result.phase==='APPLIED'){
   status('已启用 '+code+'，正在继续填入…');await pending();
   /* 3.2.2（用户实测死锁的第二半）：acknowledge 只解除「凭据覆盖到」的冲突，而本机
      可能还留着别的来源给同一实体打的未核验标记（快照类/位置核实类）。不解除，
      自动重试填入仍会被冲突守卫挡死——表现为「点完启用、流程还是断」。 */
   clearStaleActivationConflict(type,code);
   render();
   try{await retry();}catch(e){statusAction('已启用 '+code+'，但自动重填未通过：'+errText(e),'重新填入并继续',()=>run(retry));}
   return;
  }
   if(result&&result.phase==='REJECTED'){
    const errRaw=String(result.error||'');
    /* F2（v3.2.4，用户实测死循环）：版本类拒绝（本机镜像陈旧/早前未决命令挡道）——
       自动安全重拉 → 用最新数据换新 opId 重试一次（激活命令无行绑定，重建零成本）。
       不再把用户推进待处理区死循环（旧壳层 bug 曾把这里伪装成「结果待确认」）。
       3.7.0 C5：STATE_CONFLICT 纳入——C2 删了 LOC expected 比对后残余场景只剩
       本机/云端镜像错位的脏数据（重拉可愈）；retired 类在扫码层已拦，不会走到这。 */
    if(/TRIAL_CONCURRENT|VERSION_CONFLICT|TRIAL_PRECONDITION_CHANGED|STATE_CONFLICT/.test(errRaw)&&!(opts&&opts._rebuilt)){
      status('云端数据有更新（可能来自你上一步操作），正在按最新数据自动重试…');render();
      if(refreshConflicts){try{await refreshConflicts();}catch(_){ }}
      return guidedActivate(type,code,retry,{...(opts||{}),_rebuilt:true});
    }
    if(/LEGACY_LOCATION_CONFLICT/.test(errRaw)&&type==='CTN'){
     const locValue=(scan.row().values||[]).find(v=>v.type==='LOC');
     statusAction('容器旧档案位置（'+((conflict&&conflict.observed&&conflict.observed.loc)||(U.unique(st,'containers',code).loc)||'未知')+'）与扫描的库位不一致','以现场扫描为准，启用到 '+locValue.code,()=>run(()=>guidedActivate(type,code,retry,{confirmLegacyLocOverride:true})));return;
    }
    /* 2.48.0：REJECTED 的卡会被 acknowledge 删除，「请查询原命令」已无可查之物——如实说拒绝并给重扫路径。
       v3.5.0：版本类重建轮仍拒时 item-client 保留了 retryable 卡——发后不管，删掉。 */
    await abandonActivation();await pending();
    statusAction('启用被拒绝：'+errText({message:errRaw})+'；请核对现场状态后重试','重试启用',retryActivation);return;
   }
   await abandonActivation();await pending();
   statusAction('启用结果待确认（'+stateLabel(result&&result.phase)+'）：云端仍在处理，已清理本机记录，稍后会自动核对；若急可直接重试','重试启用',retryActivation);
  }
 function acceptGuided(text,token){return run(async()=>{
  if(!String(text||'').trim()){status('请先用「相机扫码」（识别后在弹出的确认卡里点「确定填入」），或手动输入编码');return;}
  try{
   /* 2.98.0 Phase 2：批量模式激活时，扫描路由到批量通道（锚点/连扫） */
   if(scan.batchState()){
     const _bp=(function(t){
       /* 2.99.2：批量路由也要识别短链/裸码（打印标签就是短链——用户实测「点击填入没效果」） */
       const raw=String(t).trim();
       const win=doc.defaultView,LL=win&&win.ItemLink;
       const link=LL&&LL.parseScanText(raw);
       if(link)return {type:'ITM',code:link.code};
       const m=/^(LOC|CTN|ITM)[:|]?\s*(.+)$/i.exec(raw);
       if(m)return {type:m[1].toUpperCase(),code:String(m[2]).trim()};
       if(/^[A-Z0-9]{8}$/.test(raw)&&LL&&LL.fromShort)return {type:'ITM',code:LL.fromShort(raw)};
       /* BUG-C（实测）：裸码兜底——扫不了码手输完整编码时按台账归属推断类型
          （物品 → 库位 → 容器；物品码恒为 WP- 前缀，与库位/容器码天然不撞），
          与 placeholder「WP-…」承诺一致；查不到台账记录则落入「无法识别」。
          比较统一大写（手输小写也能命中）。 */
       try{const _st=getState(),_up=raw.toUpperCase();
         try{return{type:'ITM',code:U.unique(_st,'items',_up).code};}catch(_){ }
         try{return{type:'LOC',code:U.unique(_st,'locations',_up).code};}catch(_){ }
         try{return{type:'CTN',code:U.unique(_st,'containers',_up).code};}catch(_){ }
       }catch(_){ }
       return null;
     })(text);
     if(!_bp)throw Error('无法识别编码（批量模式收 LOC:/CTN:/ITM: 前缀码、短链或已建档裸码）');
     let br;
     if(_bp.type==='ITM'){
       const _snap3=scan.snapshot();
       const _ri=_snap3.rows.findIndex(r=>!r.locked&&r.confirmed===false&&r.values.some(v=>v.type==='ITM'&&v.code===_bp.code));
       if(_ri>=0){scan.select(_ri);const _lr=scan.row();_lr.confirmed=true;_lr.generation++;
         el('itmCode').value='';
         status('✓ '+_bp.code+' 已确认（扫描匹配）');
         try{el('itmCode').focus();}catch(_){ }
         return;}
     }
     br=scan.acceptBatchCode(_bp);
     el('itmCode').value='';
     status(br.text||'已入批');
     try{el('itmCode').focus();}catch(_){ }
     return;
   }
   const result=scan.accept(text,token);
   if(result&&result.ignored){status('页面状态已变化（行已切换或修改），这次填入被忽略，请重新扫码');return;}
   if(result&&result.duplicate){status('该码与上一步相同，重复扫码已忽略');return;}
   el('itmCode').value='';if(prefillItem&&scan.row().values.some(v=>v.type==='ITM'&&v.code===prefillItem))prefillItem=null;
   const done=scan.row(),seq=Scan.sequences[done.kind];
   status(done.values.length===seq.length
    ?('本行已填齐（草稿未提交，库存还没动）：请点「确认本行，保存待提交」，再到待处理区提交后才真正'+submitHint(done.kind))
    :'已填写草稿，尚未提交');
   try{el('itmCode').focus();}catch(_){}}
  catch(e){
   const msg=(e&&e.message)||String(e);
   /* D2（§六待修④）：建档/核实引导先归一短链 —— 扫整条 /i/8位 短链或裸 8 位码时原文没有
      ITM: 前缀，不归一就匹配不上引导分支、静默抛错（scan.accept 内部已做同款归一，这里只为分支判断）。 */
   const win=doc.defaultView,LL=win&&win.ItemLink;let norm=String(text).trim();const link=LL&&LL.parseScanText(norm);if(link)norm='ITM:'+link.code;
   const m=norm.match(/^(LOC|CTN|ITM)[:|](.+)$/);
   /* 2.48.0：同步冲突先于状态校验抛出（U.unique），曾表现为裸报「locations: 码」且无任何出口。
      这里给出「现场核实并启用」入口：APPLIED 日志即凭据，acknowledge 会随之解除冲突。 */
   if((e&&e.code)==='UNRESOLVED_ENTITY_CONFLICT'){
    const cm=msg.match(/^(locations|containers|items):\s*(.+)$/);
    if(cm&&(cm[1]==='locations'||cm[1]==='containers')&&m){
     statusAction(errText(e),'现场核实并启用 '+cm[2]+' 后继续',()=>guidedActivate(cm[1]==='locations'?'LOC':'CTN',cm[2],()=>acceptGuided(text,token)));
    }else if(refreshConflicts){
     statusAction(errText(e),'安全重新拉取核对',()=>run(async()=>{await refreshConflicts();status('已重拉核对；如仍报冲突，请在「建档管理」页查看冲突详情');}));
    }else status(errText(e));
    return;
   }
   if(m&&m[1]==='LOC'&&/未启用|未核实/.test(msg)){
    if(entityStatus('locations',m[2])==='retired'){status('该库位已退役，不能启用或作业；如属误标请联系管理员');return;}
    /* 3.7.0 C1（单端直提，DSH 拍板）：不再给「现场确认启用」按钮等人点——扫码即意图，
       直接自动核实启用并继续原填入；失败路径由 guidedActivate 内部给出「重试启用」。
       retired 已在上一行拦截（启用退役对象是业务事故，不是核实）。 */
    status(msg+'——正在自动核实启用 '+m[2]+'…');
    return guidedActivate('LOC',m[2],()=>acceptGuided(text,token));
   }
   if(m&&m[1]==='CTN'&&/未启用|未核实/.test(msg)){
    if(scan.row().kind==='placeContainer'){status(errText(e));return;}
    if(entityStatus('containers',m[2])==='retired'){status('该容器已退役，不能启用或作业；如属误标请联系管理员');return;}
    status(msg+'——正在自动核实启用 '+m[2]+'…');
    return guidedActivate('CTN',m[2],()=>acceptGuided(text,token));
   }
   if(m&&m[1]==='ITM'&&(/NOT_FOUND|不存在/.test(msg)||(e&&e.code)==='NOT_FOUND')){statusAction('该物品码未建档：'+m[2],'以该码建档（先注册，确认后按当前作业类型继续：'+submitHint(scan.row().kind)+'）',()=>{const btn=doc.querySelector('button[data-tab="register"]');if(btn)btn.click();const det=el('itmRegister').closest('details');if(det)det.open=true;const t=el('itmRegisterType');chooseOption(t,'registerItem');el('itmRegisterCode').value=m[2];syncRegisterType();const adv=el('itmRegisterAdvanced');if(adv)adv.open=true;status('已带你到『建档管理』页并把 '+m[2]+' 带入建档区（高级·手动编码），确认后请重新按步骤扫码');});return;}
    throw e;
  }
 });}
 el('itmSearchBtn').addEventListener('click',search);el('itmSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();search();}});
  el('itmNewRow').addEventListener('click',()=>run(()=>{stopCamera();prefillItem=null;scan.add(el('itmKind').value);}));
  /* BUG-8（TASK-15）：切「作业类型」下拉即时生效——
     当前行还是空的（一步都没扫、未锁定、不在批量模式）→ 直接把该行切成所选类型，
     用户不用再点「按所选类型新建行」（实测出/入库方向搞反是库存事故）；
     当前行已有已扫数据 → 绝不静默改类型（会丢输入），只提示去点新建行。 */
  el('itmKind').addEventListener('change',()=>{
   const kind=el('itmKind').value,KIND_ZH={receive:'入库',issue:'出库',verifyLegacy:'核实',transfer:'换箱',moveContainer:'容器移库',placeContainer:'容器定位'}[kind]||kind;
   if(scan.batchState&&scan.batchState()){status('已选择「'+KIND_ZH+'」——批量模式中，请先结束当前批量再切换');return;}
   let r=null;try{r=scan.row();}catch(_){/* 无行 */}
   if(r&&!r.locked&&Array.isArray(r.values)&&r.values.length===0){
    r.kind=kind;r.generation++;render();
    status('当前空行已切换为「'+KIND_ZH+'」：请继续按步骤扫码');
   }else{
    status('已选择「'+KIND_ZH+'」——点『按所选类型新建行』生效'+(r&&r.values.length?'（当前行已有数据，未改动）':''));
   }
  });
 /* 2.98.0 Phase 2（锚点批量 UI）：「开始批量入库/出库」——批量是显式进入的模式，默认仍是单行。 */
 (function(){
  const host=el('itmNewRow').parentElement;
  if(!host||doc.getElementById('itmBatchStart'))return;
  const wrap=doc.createElement('span');wrap.className='itm-toolbar';wrap.id='itmBatchStart';
  wrap.innerHTML='<span class="hint">连扫批量：</span>';
  [['receive','开始批量入库'],['issue','开始批量出库']].forEach(([kind,label])=>{
   const b=doc.createElement('button');b.className='btn ghost';b.id='itmBatchStart-'+kind;b.textContent=label;
   b.addEventListener('click',()=>run(()=>{
     stopCamera();prefillItem=null;
     scan.startBatch(kind);
     status(kind==='receive'?'批量入库：请先扫目标库位（LOC:）':'批量出库：请直接扫第一件物品（锚点库位自动派生）');
     try{el('itmCode').focus();}catch(_){ }
   }));
   wrap.appendChild(b);
  });
  host.appendChild(wrap);
  const ab=doc.createElement('button');ab.className='btn ghost';ab.id='itmBatchAbandon';ab.textContent='放弃本批';ab.style.display='none';
  ab.addEventListener('click',()=>run(()=>{abandonBatchMode();}));
  host.appendChild(ab);
 })();
 el('itmRows').addEventListener('change',()=>run(()=>{stopCamera();scan.select(Number(el('itmRows').value));}));
 el('itmReset').addEventListener('click',()=>run(()=>{stopCamera();scan.reset();}));
 /* 2.58.1 Phase6（清单治理）：删除当前草稿行 / 清空全部草稿行与草稿存储 */
 el('itmRowDelete').addEventListener('click',()=>run(()=>{const snap=scan.snapshot();const idx=snap.active;const target=snap.rows[idx];
  if(!target)throw Error('行不存在');
  if(target.locked&&!confirm('该行已提交（命令在待处理区仍有记录）。确认从清单中移除这一行？'))return;
  scan.removeRow(idx);status('已删除第 '+(idx+1)+' 行');}));
 el('itmRowClearAll').addEventListener('click',()=>run(async()=>{
  if(!confirm('清空全部未提交的草稿行？已提交的命令不受影响；草稿清空后不可恢复。'))return;
  scan.clearUnlocked();
  const p2=getPersistence();let n=0;if(p2&&typeof p2.clearDrafts==='function'){try{n=await p2.clearDrafts();}catch(_){ }}
  scan.add(el('itmKind').value);render();await pending();
  status('已清空 '+n+' 份草稿存储，并新建空行');
 }));
 el('itmScanBtn').addEventListener('click',()=>acceptGuided(el('itmCode').value));
 el('itmCode').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();acceptGuided(el('itmCode').value);}});
 el('itmDraftSave').addEventListener('click',()=>run(async()=>{const p=getPersistence();if(!p)throw Error('IDB不可用，草稿仅临时保留');await p.saveDraft(scan.snapshot().sessionId,scan.snapshot());status('草稿已保存本机');}));
 el('itmDraftRestore').addEventListener('click',()=>run(async()=>{const p=getPersistence();if(!p)throw Error('IDB不可用');const recovered=await p.recover();const drafts=recovered.drafts.filter(d=>d.value&&Array.isArray(d.value.rows));if(!drafts.length)throw Error('没有可恢复草稿');scan.restore(drafts[drafts.length-1].value);status('已恢复草稿；锁定命令须查询原opId，不自动重发');}));
  el('itmConfirm').addEventListener('click',()=>run(async()=>{
   if(scan.batchState()){await submitBatchMode();return;}
   if(scan.row().locked)return;const p=getPersistence();if(!p)throw Error('IDB不可用，不能提交');const request=scan.lock();render();try{await p.enqueue(request,scan.snapshot().sessionId,scan.snapshot());}catch(e){scan.unlock();render();throw e;}status('本机已保存，正在提交…');await pending();await autoSubmitCommand(request.opId);}));
 /* 2.98.0 Phase 2（锚点批量）：批量模式的提交——**提交时**从 getState() 重派每件版本
    （扫描时派生在并发下必过期，k3 研究结论）。行锁到批次 opId，APPLIED 后整批移除。 */
 async function submitBatchMode(){
  const batch=scan.batchState();
  if(!batch)throw Error('不在批量模式');
  const snapshot=scan.snapshot();
  const kind=batch.kind;
  const _allRows=snapshot.rows.map((row,i)=>({row,i})).filter(x=>!x.row.locked&&x.row.kind===kind&&x.row.values.some(v=>v.type==='ITM'));
  const batchRows=_allRows.filter(x=>x.row.confirmed!==false);
  const _unconfirmed=_allRows.length-batchRows.length;
  if(!batchRows.length)throw Error(_unconfirmed?('已选 '+_unconfirmed+' 件但还没扫描确认——请逐件扫描它们的物理码后再提交'):'本批为空：请先连扫物品');
  if(_unconfirmed)log('⚠ 本批 '+_unconfirmed+' 件未扫确认，本次提交不包含它们');
  const st=getState();
  const p=getPersistence();if(!p)throw Error('IDB不可用');
  const batchOpId=id();
  let request;
  if(kind==='receive'){
   const anchor=batch.anchor;if(!anchor)throw Error('锚点未完成');
   request={schemaVersion:1,opId:batchOpId,kind:'receiveBatch',target:{loc:anchor.loc},
    items:batchRows.map(x=>{
     const it=x.row.values.find(v=>v.type==='ITM');
     /* 提交时从最新本地镜像重派版本 */
     const item=U.unique(st,'items',it.code);
     const ctn=U.unique(st,'containers',anchor.ctn);
     return {itemCode:it.code,containerCode:anchor.ctn,expectedItemVersion:item.version,expectedContainerVersion:ctn.version};
    })};
  } else {
   const anchor=batch.anchor;if(!anchor)throw Error('锚点未完成');
   request={schemaVersion:1,opId:batchOpId,kind:'issueBatch',source:{loc:anchor.loc},
    items:batchRows.map(x=>{
     const it=x.row.values.find(v=>v.type==='ITM');
     const item=U.unique(st,'items',it.code);
     const pos=U.currentPosition(st,it.code);
     const ctn=U.unique(st,'containers',pos.container.code);
     return {itemCode:it.code,containerCode:pos.container.code,expectedItemVersion:item.version,expectedContainerVersion:ctn.version};
    })};
  }
  const prevActive=snapshot.active;
  batchRows.forEach(x=>{scan.select(x.i);const r=scan.row();if(r){r.locked=true;r.opId=batchOpId;r.generation++;}});
  scan.select(prevActive);
   await p.enqueue(request);
   /* BUG-D（实测）：批次命令入队后退出批量模式——否则旧面板/sticky（旧锚点、旧目标数、
      待扫表单槽）残留并遮挡「新建行」的单行作业界面，用户只能手动点「放弃本批」。
      锁定行保留在清单（对应待处理命令）；下一批从「开始批量入/出库」重新起批。 */
   scan.stopBatch();
   status('已合成本批 '+batchRows.length+' 件为一条「'+(kind==='receive'?'批量入库':'批量出库')+'」命令（一条提交，一次完成），已退出批量模式；请在下方待处理区提交');
   await pending();
   await autoSubmitCommand(batchOpId);   /* P4：在线自动提交；离线/失败时命令留在待处理区 */
   return batchOpId;   /* P1b：屏障重试整批重建需要拿到新 opId */
  }
 /* 放弃本批：清掉批次行（未提交）+ 退出批量模式 */
 function abandonBatchMode(){
  const batch=scan.batchState();
  if(!batch)return;
  const snapshot=scan.snapshot();
  const n=snapshot.rows.filter(r=>!r.locked&&r.values.some(v=>v.type==='ITM')).length;
  if(n>0&&!confirm('放弃本批 '+n+' 件？（未提交，需要重扫）'))return;
  const prevActive=snapshot.active;
  /* 倒序删除（索引不因删除位移——正序删会让后续捕获的索引失效，实测「行不存在」） */
  snapshot.rows.map((row,i)=>i).reverse().forEach(i=>{
    const row=snapshot.rows[i];
    if(!row.locked&&row.kind===batch.kind&&row.values.some(v=>v.type==='ITM')){scan.removeRow(i);}
  });
  if(scan.snapshot().rows.length===0)scan.add('receive');
  scan.select(Math.min(prevActive,scan.snapshot().rows.length-1));
  scan.stopBatch();
  status('已放弃本批'+(n?'（'+n+' 件）':'')+'，回到单行模式');
 }
 /* 2.83.0（批量 UI 补全）：把同类同库位的草稿行合并为一条批量命令。
    约束（与协议一致）：入库=全部行共享目标库位；出库=全部行共享来源库位。
    TASK-06 起出库**不限库位**：不同库位的出库行也可合并（锚点仅作兼容字段）；
    入库仍要求同库位。 */
 async function mergeSubmitBatch(kind,rowIndexes){
  const snap=scan.snapshot();
  const rows=rowIndexes.map(i=>snap.rows[i]).filter(Boolean);
  const collected=[];const locSet=new Set();
  for(let i=0;i<rowIndexes.length;i++){
   scan.select(rowIndexes[i]);
   const q=scan.request();   /* 复用逐行派生逻辑（双版本从本地镜像取） */
   const anchor=(kind==='receive'?(q.target&&q.target.loc):(q.source&&q.source.loc))||'';
   /* TASK-06R 修复：出库不限库位（扫物品码即可出库），故出库分支不要求锚点、
      也不要求各件同库位——锚点仅作兼容字段传给服务端（服务端由 containerCode 反查）。
      入库仍必须有目标库位（东西要放到某个架子上）。 */
   if(kind==='receive'&&!anchor)throw Error('第 '+(rowIndexes[i]+1)+' 行缺库位锚点');
   if(anchor)locSet.add(anchor);
   collected.push({row:rowIndexes[i],q,anchor});
  }
  if(kind==='receive'&&locSet.size>1)throw Error('本批行的库位不一致（'+[...locSet].join('、')+'——只有同库位才能批量；请分开提交');
  const anchorLoc=[...locSet][0];
  const p=getPersistence();if(!p)throw Error('IDB不可用');
  const batchOpId=id();
  const request=kind==='receive'
    ?{schemaVersion:1,opId:batchOpId,kind:'receiveBatch',target:{loc:anchorLoc},
      items:collected.map(c=>({itemCode:c.q.itemCode,containerCode:c.q.target.container,expectedItemVersion:c.q.expected.itemVersion,expectedContainerVersion:c.q.expected.containerVersion}))}
    :{schemaVersion:1,opId:batchOpId,kind:'issueBatch',source:{loc:anchorLoc},
      items:collected.map(c=>({itemCode:c.q.itemCode,containerCode:c.q.source.container,expectedItemVersion:c.q.expected.itemVersion,expectedContainerVersion:c.q.expected.containerVersion}))};
  /* 行锁定并挂到批次 opId——APPLIED 后 execute() 的 scan.forget(opId) 会把整批行一并移除 */
  /* 2.96.1 B1：锁行必须操作活会话（snapshot() 是深拷贝，改副本=行永不锁定、僵尸草稿） */
  const _prevActive=scan.snapshot().active;
  collected.forEach(c=>{scan.select(c.row);const r=scan.row();if(r){r.locked=true;r.opId=batchOpId;r.generation++;}});
  scan.select(_prevActive);
   await p.enqueue(request);
   status('已合并 '+(collected.length)+' 件为一条「'+(kind==='receive'?'批量入库':'批量出库')+'」命令（一条提交，一次完成）；请在下方提交');
   await pending();
   return batchOpId;   /* P1b：屏障重试整批重建需要拿到新 opId */
  }

 /* TASK-19（BUG-14）：未决卡「重试」原实现依赖扫码行（session.rows 只活在内存），
    页面刷新/批量提交清行后必抛「本地找不到对应的扫码行」→ 卡成死局。
    现改为：无扫码行时用卡片自带的 request 快照（kind/itemCode/source/target/items 齐全）
    + 最新本地镜像重派 expected 版本，重建出可提交的新命令。
    返回 {request}（可直接 enqueue）或 {skip:'原因'}（调用方给人话兜底，不抛错）。
    版本派生口径与 scan.request()（item-scan.js）/submitBatchMode() 一致：
    - 单件出库/换箱 source 按物品现状（currentPosition）派生；
    - 入库/定位/移库保留旧快照的目标位置（服务端 pair 终审）；
    - 所有 expected.*Version 一律取最新 state。 */
 function rebuildFromRequestSnapshot(req){
  const st=getState();
  const kind=req&&req.kind;
  const freshItem=code=>{
   try{return U.unique(st,'items',code);}catch(_){return null;}
  };
  const freshContainer=code=>{
   try{return U.unique(st,'containers',code);}catch(_){return null;}
  };
  /* 批量类：items 数组逐件重派——整批仍重建为一条批量命令（服务端原子，拆 N 条会放大冲突面） */
  if(Array.isArray(req.items)){
   if(!['receiveBatch','issueBatch'].includes(kind))return {skip:'批量类型 '+kind+' 不支持自动重建'};
   const items=[];
   for(const x of req.items){
    if(!x||!x.itemCode)return {skip:'批量清单缺 itemCode'};
    const item=freshItem(x.itemCode);if(!item)return {skip:'物品 '+x.itemCode+' 已不在本地档案'};
    if(kind==='issueBatch'){
     /* 出库按物品最新位置（TASK-06 起出库不限库位，锚点仅兼容字段） */
     if(item.status!=='in_stock'||!item.container)return {skip:'物品 '+x.itemCode+' 当前不在库，无法重建出库'};
     const ctn=freshContainer(item.container);if(!ctn)return {skip:'容器 '+item.container+' 已不在本地档案'};
     items.push({itemCode:item.code,containerCode:ctn.code,expectedItemVersion:item.version,expectedContainerVersion:ctn.version});
    }else{
     const ctn=freshContainer(x.containerCode);if(!ctn)return {skip:'容器 '+x.containerCode+' 已不在本地档案'};
     items.push({itemCode:item.code,containerCode:ctn.code,expectedItemVersion:item.version,expectedContainerVersion:ctn.version});
    }
   }
   if(!items.length)return {skip:'批量清单为空'};
   const request={schemaVersion:1,opId:id(),kind,items};
   if(req.target)request.target=req.target;     /* 入库锚点：保留旧目标库位（东西仍要放到那个架上） */
   if(req.source)request.source=req.source;     /* 出库锚点：仅兼容字段，服务端由 containerCode 反查 */
   return {request};
  }
  /* 单件类：六种扫码作业可安全重建；激活/建档类交给既有引导或人话兜底 */
  if(!['receive','issue','transfer','moveContainer','placeContainer','verifyLegacy'].includes(kind))return {skip:'命令类型 '+kind+' 不支持自动重建'};
  if(!req.itemCode)return {skip:'快照缺 itemCode'};
  const item=freshItem(req.itemCode);if(!item)return {skip:'物品 '+req.itemCode+' 已不在本地档案'};
  const request={schemaVersion:1,opId:id(),kind};
  if(kind==='issue'||kind==='transfer'){
   if(item.status!=='in_stock'||!item.container)return {skip:'物品 '+req.itemCode+' 当前不在库，无法重建'+(kind==='issue'?'出库':'换箱')};
   const srcCtn=freshContainer(item.container);if(!srcCtn)return {skip:'容器 '+item.container+' 已不在本地档案'};
   request.itemCode=item.code;
   request.source={loc:srcCtn.loc,container:srcCtn.code};
   request.expected={itemVersion:item.version,containerVersion:srcCtn.version};
   if(kind==='transfer'){
    const tgtCtn=req.target&&freshContainer(req.target.container);
    if(!tgtCtn)return {skip:'目标容器 '+(req.target&&req.target.container)+' 已不在本地档案'};
    request.target={loc:req.target.loc,container:tgtCtn.code};
    request.expected.targetContainerVersion=tgtCtn.version;
   }
   return {request};
  }
  if(kind==='moveContainer'||kind==='placeContainer'){
   const ctn=freshContainer(req.containerCode);if(!ctn)return {skip:'容器 '+req.containerCode+' 已不在本地档案'};
   request.containerCode=ctn.code;
   request.target={loc:req.target&&req.target.loc};
   request.expected={containerVersion:ctn.version};
   if(kind==='moveContainer')request.source={loc:ctn.loc};
   return {request};
  }
  /* receive / verifyLegacy：target 保留旧快照（服务端 pair 终审），版本取最新 */
  const ctn=req.target&&freshContainer(req.target.container);
  if(!ctn)return {skip:'目标容器已不在本地档案'};
  request.itemCode=item.code;
  request.target={loc:req.target.loc,container:ctn.code};
  request.expected={itemVersion:item.version,containerVersion:ctn.version};
  return {request};
 }

 /* P4：命令执行核心（提交/查询 + 回执处理）——原先内联在 pending() 的按钮闭包里，
    「在线自动提交」与待处理区按钮必须共用同一条结果处理路径（forget/批量剔件/冲销关单/补记）。 */
  /* v3.13.13（发现 R）：同一命令的提交/查询做**进程内串行**。
     实测连点「执行」两次 → 4 次 fetch（两次提交各走一遍飞书串行写，单次 10s+），
     且按钮飞行中不禁用。服务端按 opId 幂等不会重复记账，但用户会看到两次
     独立结果、以及无谓的重复长请求。
     做法：以命令 id 为键记 in-flight Promise，重复调用直接复用同一个
     （与 index.html 的 _flushInFlight / fsFullResyncBusy 同一思路）。 */
  const _execInFlight = Object.create(null);
  async function executeCommand(method,c){
    const request=c.request||{};
    const inFlightKey = method + ':' + String((c && c.id) || '');
    if (_execInFlight[inFlightKey]) return _execInFlight[inFlightKey];
    const p = _execCommandInner(method, c, request).finally(() => { delete _execInFlight[inFlightKey]; });
    _execInFlight[inFlightKey] = p;
    return p;
  }
  async function _execCommandInner(method,c,request){
    let result;
    try{result=await getClient()[method](c);}
    catch(e){try{await pending();}catch(_){ }throw e;}   /* v3.3.2 实测：提交/查询失败时 item-client 已 markUnknown 落「需人工核验」卡，
                                                            但异常直接上抛会跳过本函数末尾的 pending() 刷新——界面停在旧 pending 卡（按钮集不符），
                                                            用户以为没生效反复重试。先刷新待处理区再上抛错误文案。 */
    /* 2.53.1：命令终态后从扫码会话移除对应行——同一物品可以立即进行下一笔操作，
      不会再被已完成行的「批次已包含此物品」防重检查误拦。 */
   /* 2.98.0 Phase 3（@件码拒绝）：批量命令被拒且错误带「@ 件码」时——
      失败件自动剔出本批，其余件解锁保留可重发（不重扫）。APPLIED 才 forget。 */
   if(result&&result.phase==='REJECTED'&&Array.isArray((result.request||{}).items)){
    const _errStr=String(result.error||'');
    const _m=/@\s*(\S+)/.exec(_errStr);
    const _snap=scan.snapshot();
    if(_m){
      const _failed=_m[1];
      /* 倒序：解锁其余批次行 + 删失败行 */
      _snap.rows.map((row,i)=>i).reverse().forEach(_i=>{
        const _row=_snap.rows[_i];
        const _it=_row.values.find(v=>v.type==='ITM');
        if(!_it)return;
        if(_it.code===_failed){scan.removeRow(_i);return;}
        if(_row.opId===c.id){scan.select(_i);const _lr=scan.row();_lr.locked=false;_lr.opId=null;_lr.generation++;}
      });
      if(scan.snapshot().rows.length===0)scan.add('receive');
      const _left=scan.snapshot().rows.filter(r=>!r.locked&&r.values.some(v=>v.type==='ITM')).length;
      status('✗ '+_failed+' 被拒（'+errText(_errStr)+'）已剔出本批；其余 '+_left+' 件可重新「提交本批」（版本已重派）');
    } else {
      status('整批被拒：'+errText(_errStr)+'——请查看待处理区');
    }
   }
   else if(result&&['APPLIED','REJECTED'].includes(result.phase)&&c.id){
     /* F1（v3.2.4）：版本类拒绝（retryable）的卡保留在待处理区且带「重建重提」按钮——
        行绑定不能丢（重建要靠 opId 找回扫码行）；其余终态照旧 forget。 */
     if(!(result.phase==='REJECTED'&&result.retryable===true)){try{scan.forget(c.id);}catch(_){}}
   }
   /* 2.80.0 B1（稳定多并发）：批量命令经待处理区确认后展开工单进度——
      此前回执展开只挂在执行卡提交成功分支，经确认路径收口的批量命令
      实际成功但工单进度永不更新（幂等漏洞，k3 实证）。opSeen/execSet 去重保证重复展开安全。 */
   /* 阶段B：反向命令 APPLIED → 尝试关单。
      冲销是「逐件发反向命令」，全部 APPLIED 后工单才置为已取消并写 reverseInfo。
      未全 APPLIED 时 applyItemReverseResult 原样报出 pending，工单保持原状，
      绝不出现「关了单但东西没退回去」。 */
   if(result&&result.phase==='APPLIED'&&request.reverseOf){
    try{
     /* item-ui 是独立模块，CORE/fsPushRecord/renderWip 由宿主页面（index.html）提供；
        用可选链取，避免在无宿主的测试环境里把整条路径打成 TypeError。 */
     const _win=doc.defaultView||{};
     const _C=_win.CORE;
     const _push=typeof _win.fsPushRecord==='function'?_win.fsPushRecord:null;
     const _reRender=typeof _win.renderWip==='function'?_win.renderWip:null;
     if(!_C)return;
     const rw=(state.workorders||[]).find(x=>x.execBatches&&x.execBatches.some(b=>(b.ops||[]).some(o=>String(o.opId||'')===String(request.reverseOf))));
     if(rw&&_C.isItemizedOrder&&_C.isItemizedOrder(rw)&&!rw.reverseInfo&&!_C.isCancelled(rw)){
      /* 累计本机已 APPLIED 的反向命令：全部到齐才关单，缺的会被报成 pending */
      const revs=request._reverseResults=request._reverseResults||[];
      const rec={opId:String(result.opId||c.id),reverseOf:String(request.reverseOf),phase:'APPLIED',itemCode:request.itemCode};
      const ei=revs.findIndex(r=>String(r.opId)===String(rec.opId));
      if(ei>=0)revs[ei]=rec;else revs.push(rec);
      /* TASK-17（BUG-9）：计划生成时被 skip 的件（已处于退回后状态）永远不会有回执，
         关单时按物品现状重算豁免清单，否则这些件会被报成 pending 堵死关单。
         判定与 buildItemReverseCommands 的 skip 分支一致：出库单冲销→物品已回库（in_stock）
         视为已退过；入库单冲销→物品已 out 视为已取出。档案缺失/状态异常不豁免（堵单留给人工核对）。 */
      const _outbound=_C.isOutbound?_C.isOutbound(rw.type):/^(LL|JH)$/.test(String(rw.type||'').toUpperCase());
      const _exempt=[];
      (rw.execBatches||[]).forEach(_b=>(_b&&_b.ops||[]).forEach(_o=>{
        if(!_o||!_o.itemCode)return;
        const _it=(state.items||[]).find(_x=>_x&&_x.code===_o.itemCode);
        if(_it&&(_outbound?_it.status==='in_stock':_it.status==='out'))_exempt.push(String(_o.opId||''));
      }));
      const rr=_C.applyItemReverseResult(state,rw,revs,{operator:state.operator,reason:request.reason,exemptOpIds:_exempt});
      if(rr.ok){
       try{if(_push)_push('workorders',[rw]);}catch(_){ }
       try{if(_reRender)_reRender();}catch(_){ }
       log('冲销完成：工单 '+rw.code+' 已置为已取消（'+rr.applied.length+' 件已退回原位）');
       status('冲销完成：工单 '+rw.code+' 已置为已取消');
      }else{
       log('冲销进行中：工单 '+rw.code+' 尚有 '+(rr.pending?rr.pending.length:0)+' 件未完成反向，工单保持原状态');
       status('本件已退回；工单 '+rw.code+' 尚有 '+(rr.pending?rr.pending.length:'部分')+' 件未冲销，全部完成后才关单');
      }
     }
    }catch(e){log('⚠️ 冲销关单失败：'+(e&&e.message||e));}
   }
   if(result&&result.phase==='APPLIED'&&/Batch$/.test(String(result.kind||''))){
     const bOpId=String(result.code||c.id||'');
     const bw=(state.workorders||[]).find(x=>bOpId.indexOf(x.code+'-')===0);
     if(bw&&CORE.isItemizedOrder&&CORE.isItemizedOrder(bw)){
       const bEntries=(result.request&&result.request.items)||[];
       const bAnchor=(result.request.source||result.request.target||{});
       const bResults=bEntries.map(e=>({opId:bOpId+'#'+e.itemCode,itemCode:e.itemCode,phase:'APPLIED',
         fromLoc:bAnchor.loc||'',fromContainer:e.containerCode||''}));
       if(bResults.length){
         const br=CORE.applyItemExecResult(state,bw,bResults,{operator:state.operator});
         if(br.ok){try{fsPushRecord('workorders',[bw]);save();renderWip();}catch(_){ }
           log('批量命令确认后补记工单 '+bw.code+'：'+bResults.length+' 件');}
       }
     }
   }
   status(result&&result.phase==='APPLIED'?'远端已确认且本机已保存':'结果：'+stateLabel(result&&result.phase));
   await pending();
   return result;
  }
  /* P4（用户拍板 2026-09-23）：在线时确认后自动提交——离线保持原状（命令留在待处理区）。
     复用 executeCommand 的同一条回执处理路径（forget/批量剔件/冲销关单/补记），结果文案与手动提交一致。 */
   async function autoSubmitCommand(opId){
    if(!getClient||!getClient())return undefined;             // 无客户端环境（部分测试）不自动提交
    if(isOnline&&!isOnline()){status('当前离线：命令已保存本机，联网后在待处理区提交');return undefined;}
    const cmds=await getCommands();
    const cmd=(cmds||[]).find(x=>x.id===opId);
    if(!cmd)return undefined;                                 // 入队失败等异常场景：pending() 已展示
    try{return await executeCommand('submit',cmd);}
    catch(e){status('自动提交未完成：'+errText(e)+'；命令已保留在待处理区，可重试');return undefined;}
   }
  async function pending(){const box=el('itmPending');const commands=await getCommands();box.replaceChildren();if(!commands.length){line(box,'暂无待处理命令。完成步骤并确认后，会显示在这里。');return;}
  /* replaceChildren 必须在 await 之后（v3.3.2 实测修复）：两次 pending 并发时
     （activate 收尾 + tab 切换重渲染），先到者 await 期间被后到者清场，
     后到者渲染即最终态；旧写法（await 前清空）会让先到者把卡叠在后到者上——
     同一条命令渲染成两张卡（各带一套提交/取消按钮），用户看到「命令堆积」。 */
 /* 2.50.1：顶部摘要行——命令一多（用户实测堆了 4+ 张卡）先给全局状态再逐张看。
    v3.4.0 R3：零计数的类目不再显示（用户实测「需人工核验 0」是噪音）。 */
 const cnts={pending:0,needs_attention:0,done:0,other:0};
 commands.forEach(c=>{if(c.status==='pending')cnts.pending++;else if(c.status==='needs_attention')cnts.needs_attention++;else if(['APPLIED','REJECTED'].includes(c.status))cnts.done++;else cnts.other++;});
 const psum=doc.createElement('div');psum.className='itm-pending-summary';
 psum.textContent='共 '+commands.length+' 条'+(cnts.pending?'：待提交 '+cnts.pending:'')+((cnts.pending&&cnts.needs_attention)?' · ':'')+(cnts.needs_attention?'结果未回 '+cnts.needs_attention:'')+(cnts.done?' · 已完结 '+cnts.done:'')+(cnts.other?' · 其他 '+cnts.other:'');
 box.appendChild(psum);
 for(const c of commands){const request=c.request||{},section=card(box,kindLabel(request.kind)+' · '+(c.status==='pending'?'待提交':c.status==='unknown'?'结果待确认':stateLabel(c.status)));
  /* P6（§三.2）：无码 registerItem（服务端发号建档）本地没有码可显示，明示「待发号」而非「待核实」 */
  const autoReg=request.kind==='registerItem'&&request.entity&&(request.entity.code==null||request.entity.code==='');
  if(Array.isArray(request.items)){
   const _anchor=(request.target&&request.target.loc)||(request.source&&request.source.loc)||'';
   line(section,'对象：本批 '+request.items.length+' 件'+(_anchor?' · 锚点 '+_anchor:''));
   line(section,'件码：'+request.items.map(x=>x.itemCode).join('、'));
  } else line(section,'对象：'+(autoReg?'物品建档 · '+(request.entity.category||'?')+' · 待发号（提交后分配物品码）':(request.itemCode||request.containerCode||request.locationCode||request.entity?.code||'待核实')));if(request.source)line(section,'来源：'+[request.source.loc,request.source.container].filter(Boolean).join(' → '));if(request.target)line(section,'目标：'+[request.target.loc,request.target.container].filter(Boolean).join(' → '));if(request.error)line(section,'原因：'+errText(request.error));
   /* 2.48.0：失败的真实原因存在 c.lastError（markUnknown 保存），此前从不渲染——核验卡因此「不知道卡在哪」 */
   if(c.lastError)line(section,'上次结果：'+errText(c.lastError));
   line(section,c.status==='pending'
   /* v3.4.0 R3：卡面说明压成一句人话——旧文案把三个按钮名嵌进长句还声称「不影响任何数据」，用户把主键当「审核通过」点 */
   ?'点「执行」后由云端处理这条「'+kindLabel(request.kind)+'」（对象：'+(request.itemCode||request.containerCode||request.locationCode||request.entity?.code||'—')+'），以云端结果为准；成功后这张卡自动消失。'
   :'这条命令的云端结果还没回来：点「查询云端结果」查看（已完成会自动清卡）；点「重试（按最新数据）」换新编号重来，或直接点「删除记录」清除本机记录。');
   meta(section,'原命令编号：'+c.id);if(getClient){const execute=method=>run(async()=>{
     /* v3.13.13（发现 R）：飞行中禁用本卡所有动作按钮，给用户可见反馈，
        并挡住连点产生的重复请求（executeCommand 层还有一道 Promise 复用兜底）。 */
     const own=[...section.querySelectorAll('button')];
     own.forEach(b=>{b.disabled=true;});
     try{ await executeCommand(method,c); }
     finally{ own.forEach(b=>{b.disabled=false;}); if(typeof pending==='function'){try{await pending();}catch(_){ }} }
   });
    /* v3.5.0 P3（用户拍板「按钮基本都没用，砍到能用为止」）：待提交卡主键=「执行」；
       未决卡主键=「重试（按最新数据）」（所有未决卡都给，不再限错误类型）——换新 opId 重建，
       绕开同 opId 重放死循环（云端未决时恒「原命令未决」）。旧「重新执行」（同 opId 重放）
       与「核对云端实际状态（需管理员）」（operator 必 403）删除。 */
    if(c.status==='pending')section.appendChild(button('执行',()=>execute('submit')));
    else section.appendChild(button('重试（按最新数据）',()=>run(async()=>{
     /* F3：激活类命令没有扫码行绑定——重建 = 安全重拉 → guidedActivate 整条链路（新 opId）。 */
     if(['activateLocation','activateContainer'].includes(request.kind)){
       status('安全重拉核对中…');
       if(refreshConflicts)await refreshConflicts();
       try{await getPersistence().abandonCommand(c.id);}catch(_){ }
       await guidedActivate(request.kind==='activateLocation'?'LOC':'CTN',request.locationCode||request.containerCode,()=>{},request.confirmLegacyLocOverride?{confirmLegacyLocOverride:true}:{});
       await pending();render();return;
     }
     status('安全重拉核对中…');
     if(refreshConflicts)await refreshConflicts();
     const rows=scan.snapshot().rows;
     const idxs=rows.map((r,i)=>r.opId===c.id?i:-1).filter(i=>i>=0);
     let newOpId;
     if(idxs.length){
      if(idxs.length>1&&['receive','issue'].includes(rows[idxs[0]].kind)){
        newOpId=await mergeSubmitBatch(rows[idxs[0]].kind,idxs);   /* 整批重建：N 件仍是一条批量命令 */
      }else{
        scan.select(idxs[0]);scan.rebuild();
        const q=scan.lock();            /* 新 opId + 从最新 state 派生版本/来源 */
        await getPersistence().enqueue(q);
        newOpId=q.opId;
      }
     }else{
      /* TASK-19（BUG-14）：扫码行只活在内存——页面刷新/批量提交清行后原实现必抛
         「本地找不到对应的扫码行」死局。改用卡片自带的 request 快照 + 最新本地镜像
         重建（新 opId）；无法重建时给人话兜底，绝不抛裸错误。 */
      const rb=rebuildFromRequestSnapshot(request);
      if(rb.skip){
        status('这条命令无法自动重试（原因：'+rb.skip+'）。请在「物品作业」页重新扫码完成一次同类操作，或点「删除记录」清除本机跟踪（云端未决命令会在下次操作时自动收口）。');
        await pending();render();return;
      }
      await getPersistence().enqueue(rb.request);
      newOpId=rb.request.opId;
     }
     await pending();
     const cmds=await getCommands();const nc=(cmds||[]).find(x=>x.id===newOpId);
     if(!nc)throw Error('重建命令未入队');
     try{await getPersistence().abandonCommand(c.id);}catch(_){ }
     const r2=await getClient().submit(nc);   /* P2a：只提交这一轮——再拒即作废，不自动退避 */
     if(r2&&r2.phase==='APPLIED'){try{scan.forget(newOpId);}catch(_){}}
     status(r2&&r2.phase==='APPLIED'?'重试成功：远端已确认'
       :(r2&&r2.phase==='REJECTED'?'重试仍被拒：'+errText({message:String(r2.error||'')})+'——请重新扫码按最新数据确认'
       :'重试提交结果：'+stateLabel(r2&&r2.phase)+'；请在待处理区查询云端结果'));
     await pending();render();
    })));
    section.appendChild(button('查询云端结果',()=>execute('query')));
     /* 阶段31b（用户反馈「取消不了」）：待提交命令的取消出口 —— abandonCommand 只删
        仅本地的 outbox 条目（2.62.0 Phase C 已有 API，此前无调用者）。persistence 为
        null 的环境（测试）不渲染。
        C3（v3.3.1）：取消后补 scan.forget——否则扫码行仍挂着已删除的 opId，
        「本行已锁定」把用户绕回死锁。
        v3.5.0：confirm 全部移除（用户环境 confirm 被抑制返回 false → 按钮静默无效，
        正是「删除/核对按钮没用」的根因）；删除本机记录零风险（重扫可再生），单击直接删。 */
     var _pp=getPersistence();
     if(_pp&&typeof _pp.abandonCommand==='function'&&!['APPLIED','REJECTED'].includes(c.status))section.appendChild(button('删除记录',()=>run(async()=>{
       await _pp.abandonCommand(c.id);try{scan.forget(c.id);}catch(_){ }
       status('已删除记录：'+kindLabel(request.kind)+'（本机不再跟踪；云端未决命令会在下次操作时自动收口）');await pending();render();
     })));
    if(request.error&&/LEGACY_LOCATION_CONFLICT/.test(String(request.error)))section.appendChild(button('现场确认后以实物为准重发',()=>run(async()=>{const p=getPersistence();if(!p)throw Error('IDB不可用');const next={...request,confirmLegacyLocOverride:true,opId:id()};delete next.error;delete next.phase;delete next.finishedAt;await p.enqueue(next);status('已生成「以实物为准」的新命令，请在下方执行');await pending();})));
    if(request.error&&/SOURCE_MISMATCH/.test(String(request.error))&&refreshConflicts)section.appendChild(button('安全重拉核对后重新扫码',()=>run(async()=>{await refreshConflicts();status('已重拉核对；本机数据已与云端对齐，请重新扫码出库');})));
   }}}
  async function runQuery(action){try{await action();}catch(e){searchStatus('查询失败：'+e.message);}}
 function resolveLinkText(text){const win=doc.defaultView;const L=win&&win.ItemLink;if(!L)return text;const link=L.parseScanText(text);return link?link.code:text;}
 function queryScan(text){el('itmSearch').value=resolveLinkText(text);search();}
 /* 查询页/作业页共用同一个全屏浮层；stop* 保持原 API，实际关闭共享浮层。 */
 /* 尽力关相机：启动深链（applyHash 在浮层 DOM 解析前同步 goTab）等场景下浮层可能未就位，
    attach 抛「页面缺少 scanCam* 浮层结构」——这里静默吞掉，不打断 goTab 后半段的渲染。 */
 function closeSharedCamera(){let c=null;try{c=getScanCamera();}catch(_){return;}if(c)c.close('switch');}
 function stopQueryCamera(){closeSharedCamera();}
 el('itmSearchCameraStop').addEventListener('click',stopQueryCamera);
 el('itmSearchCamera').addEventListener('click',()=>runQuery(async()=>{
  const c=getScanCamera();if(!c)throw Error('查询相机不可用，请扫码枪输入检索框');
  await c.open({hint:'对准库位/容器二维码或物品条形码，识别后确认填入查询框',describe:describeHit,onConfirm:text=>queryScan(text)});
 }));
 doc.defaultView.addEventListener('pagehide',stopQueryCamera);
 let adminBusy=false;
 /* v3.4.0 R1（用户实测「启用就完事了，凭什么去待处理区提交」）：核实启用在线时直接走
    guidedActivate 整条链路（幂等 + 版本拒绝自动重建重试 + LEGACY 现场出口），结果就地显示；
    仅离线时落卡、联网后自动提交。itmStatus（状态行）在物品作业页，建档管理页的用户看不到——
    完成后把最终文案镜像到本页 rstatus（itmRegisterResult）。 */
 async function activate(kind){if(adminBusy)return;adminBusy=true;try{
  const isLoc=kind==='activateLocation';
  const code=el(isLoc?'itmAdminLoc':'itmAdminContainer').value.trim();
  const locInput=el('itmAdminLoc').value.trim();
  if(!code)throw Error(isLoc?'请填写库位编码（现场实际编号）':'请填写容器编码（现场实际编号）');
  if(!isLoc&&!locInput)throw Error('请先填写目标库位编码（容器将启用到该库位）');
  const st=getState();U.unique(st,'locations',locInput);   /* 目标库位必须已建档（与旧实现一致） */
  /* TASK-20（BUG-18）取舍：activate 的同实体去重**分路径**——在线路径由 v3.4.0 R2
     「启用前自动删除同实体旧未决卡」（guidedActivate 内，item-ui.js:374 起，有测试锁）
     以替换语义根治，任何时刻同实体至多一张卡，用户无感；若再在此拦截会把 R2 的自动
     根治改回手动清卡（R2 测试失败实证）。R2 不覆盖的**离线入队分支**在此查重拦截。 */
  const p=getPersistence();if(!p)throw Error('IDB不可用');
  const online=getClient&&(!isOnline||isOnline());
  if(!online){
   /* 离线：保持原入队行为（联网后在待处理区提交）；TASK-20（BUG-18）：R2 只覆盖在线
      guidedActivate 路径，离线入队前查同 code 未决启用命令——有则人话拦截，不入队。 */
   { const cmds=getCommands?await getCommands():[];const dup=(cmds||[]).find(x=>x.request&&x.request.kind===kind&&!['APPLIED','REJECTED'].includes(x.status)&&(isLoc?x.request.locationCode===code:x.request.containerCode===code));
     if(dup){rstatus('该'+(isLoc?'库位':'容器')+'已有一条待提交的启用命令（编号 '+dup.id+'），请在「待处理区」先执行或删除它。');return;} }
   const loc=U.unique(st,'locations',locInput);const request={schemaVersion:1,opId:id(),kind,expected:{}};
   if(isLoc){request.locationCode=loc.code;request.expected.locationStatus=loc.status;}
   else{const c=U.unique(st,'containers',code);request.containerCode=c.code;request.target={loc:loc.code};request.expected.containerVersion=c.version;}
   await p.enqueue(request);rstatus('当前离线：核实启用命令已保存本机，联网后自动提交（或在待处理区提交）');await pending();return;
  }
  rstatus('正在核实启用 '+code+'…');
  try{
   await guidedActivate(isLoc?'LOC':'CTN',code,()=>{},isLoc?{}:{targetLoc:locInput});
  }finally{
   const finalText=el('itmStatus').textContent;
   if(finalText&&finalText!=='正在核实启用 '+code+'…')rstatus(finalText+(finalText.indexOf('已启用')===0?'':'')+'（详细过程见「物品作业」页状态行）');
  }
  await pending();render();
 }finally{adminBusy=false;}}
 /* ================= E1 建档改版（定稿§三.3） =================
    物品建档主流程：分类(必选)+名称(必填) → 在线时提交 registerItem **不带 code**（A 阶段服务端发号）
    → APPLIED 展示物品码 + 8 位短码 + 二维码预览 + 「去入库」；离线时只入队，提示提交后分配物品码。
    手动码降级为高级选项：填了编码就带码入队（§三.2 P3 服务端做规范形校验）。 */
 /* 选中下拉项：走 selected 属性而非 option.selected 属性赋值（linkedom 下后者不生效，浏览器两者等价） */
 function chooseOption(sel,value){for(const o of sel.options){if(o.value===value)o.setAttribute('selected','');else o.removeAttribute('selected');}}
 let prefillItem=null;   // 「去入库」带入的新码：入库行走到物品步骤时预填进 itmCode
 function syncRegisterType(){
  const kind=(el('itmRegisterType').value||'registerItem');
  const isItem=kind==='registerItem';
  const catWrap=el('itmRegisterCatWrap'),specWrap=el('itmRegisterSpecWrap'),adv=el('itmRegisterAdvanced');
  if(catWrap)catWrap.hidden=!isItem;
  if(specWrap)specWrap.hidden=!isItem;
  if(adv&&!isItem)adv.open=true;   // 库位/容器没有发号流程，编码框直接摊开
  /* 阶段31d（加固方案 §4.2）：类型联动文案——按钮/编码占位符/名称标签/底部提示
     与所选建档类型一致（此前对库位/容器仍显示「生成物品码…」等物品文案）。
     纯 JS 同步，DOM 结构/ID 不动（tab-register-structure 锁只看 id/details 数）。 */
  const ui=REG_TYPE_UI[kind]||REG_TYPE_UI.registerItem;
  const btn=el('itmRegister');if(btn)btn.textContent=ui.btn;
  const code=el('itmRegisterCode');if(code)code.placeholder=ui.codePh;
  const nameLbl=el('itmRegisterName')&&el('itmRegisterName').closest('label');
  if(nameLbl&&nameLbl.firstChild&&nameLbl.firstChild.nodeType===3)nameLbl.firstChild.nodeValue=ui.nameLabel;
  const resBox=el('itmRegisterResult');
  const hint=resBox&&resBox.nextElementSibling;
  if(hint&&hint.classList&&hint.classList.contains('hint'))hint.textContent=ui.hint;
 }
 /* 类型联动文案表（编号示例取自本站既有文案 LOC:L-A / CTN:C-A） */
 const REG_TYPE_UI={
  registerItem:{btn:'生成物品码并申请建档',codePh:'留空自动发号；手动码须规范形如 WP-TS-001',nameLabel:'名称（必填）/ 说明',
   hint:'在线提交由服务端按分类发号并生成短码与二维码；离线先存本机。'},
   registerLocation:{btn:'申请库位建档（用现场编号）',codePh:'库位现场实际编号，如 L-A',nameLabel:'说明（选填）',
    hint:'在线时建档立即完成；随后在下方「核实启用」现场转正。离线时保存本机，联网后自动提交。'},
   registerContainer:{btn:'申请容器建档（用现场编号）',codePh:'容器现场实际编号，如 C-A',nameLabel:'规格/说明（选填）',
    hint:'在线时建档立即完成；随后在下方「核实启用」（或作业页「容器定位」）现场转正。离线时保存本机，联网后自动提交。'}
 };
 el('itmRegisterType').addEventListener('change',syncRegisterType);
 /* 阶段31c：软刷新（F5）会恢复 select 的选中值但【不触发 change】——
    上次选了「库位」刷新后，值是库位、表单却还是物品形态（用户实测截图）。
    挂载时先同步一次，保证表单形态永远跟当前值一致。 */
 syncRegisterType();
 function showRegisterResult(code,name,category){
  const box=el('itmRegisterResult');if(!box)return;box.replaceChildren();
  const win=doc.defaultView,LL=win&&win.ItemLink;
  line(box,'已分配物品码：'+code+'（'+category+' · '+(name||'')+'）');
  const short=LL&&LL.fromItemCode(code),link=LL&&LL.linkFor(code);
   if(short&&link){
    line(box,'8 位短码：'+short);
    /* 短链展示与印刷形态一致：**整条大写**是冻结规格
       （test/item-link.test.js:10「冻结印刷版整条大写（定稿 §二/§6.3）」，4 个测试文件锁死）。
       这里的 toUpperCase() 不是冗余变换，而是**保证屏幕上看到的与标签上印的、二维码里编的逐字一致**。
       （decode() 内部会归一到大写，扫码本身大小写不敏感；但展示应与冻结值一致。）
       ⚠️ 不要再去掉这个 toUpperCase：测试与印刷版都以大写为准。 */
    line(box,'短链：'+link.toUpperCase());
    const svg=typeof qrSvg==='function'?qrSvg(link.toUpperCase()):null;
   if(svg){const holder=doc.createElement('div');holder.className='itm-qr';holder.innerHTML=svg;box.appendChild(holder);}
  }else line(box,'该码不是规范结构，无短链二维码（仍可按原码作业）');
  box.appendChild(button('去入库',()=>{
   chooseOption(el('itmKind'),'receive');
   stopCamera();scan.add('receive');prefillItem=code;render();
   status('已新建入库行并带入新码 '+code+'：请按步骤扫库位与容器，物品步骤会自动填入');
   /* 3.2.1（用户实测「去入库点击没效果」）：建档表单在「建档管理」页、入库行在
      「物品作业」页——只建行不跳页，用户在当前页看不到任何变化，误以为按钮坏了。
      与 LOC/CTN 分支的「↗ 去待处理区提交」同款：建完行直接切到物品作业页。 */
   const nb=doc.querySelector('nav.tabs button[data-tab=item-work]');if(nb)nb.click();
  }));
 }
 /* 建档反馈就近落在建档区（itmRegisterResult）——历史上错误只写到远处作业状态行，
    用户点了按钮看不到任何反馈，以为「按钮无效」。 */
 const rstatus=t=>{const b=el('itmRegisterResult');if(!b)return;const p=doc.createElement('p');p.className='itm-meta';p.textContent=t;b.replaceChildren(p);};
 el('itmRegister').addEventListener('click',()=>run(async()=>{if(adminBusy){rstatus('上一条建档/核实提交还在进行中，请等它出结果再点');return;}adminBusy=true;try{
  const kind=el('itmRegisterType').value||'registerItem';
  const name=el('itmRegisterName').value.trim();
  const manualCode=(el('itmRegisterCode')&&el('itmRegisterCode').value.trim())||'';
  const p=getPersistence();if(!p)throw Error('IDB不可用');
  if(kind!=='registerItem'){
   /* 2.62.0（用户反馈）：库位/容器建档必须有编码——不再静默生成 UUID 后缀的废码 */
   if(!manualCode)throw Error('请填写' + ({registerLocation:'库位',registerContainer:'容器'}[kind]) + '编码（现场实际编号）');
   const entity={code:manualCode,...(kind==='registerLocation'?{desc:name}:{spec:name})};
   /* v3.4.0 R4（用户拍板「建档也即时提交」）：建档是幂等低风险操作（重复编码只会被拒，
      不改既有数据）——在线时入队后立即自动提交，结果就地显示；仅离线时留在待处理区。 */
   const regOpId=id();
   await p.enqueue({schemaVersion:1,opId:regOpId,kind,entity});
   const regResult=await autoSubmitCommand(regOpId);
   if(regResult&&regResult.phase==='APPLIED'){
    rstatus('已建档：'+manualCode+'（'+({registerLocation:'库位',registerContainer:'容器'}[kind])+'）；实体为「未核实」状态，在下方「核实启用」现场转正');
    const bxr=el('itmRegisterResult');if(bxr){
     const bAc=doc.createElement('button');bAc.type='button';bAc.className='btn small ghost';bAc.textContent='↓ 预填核实启用';
     bAc.addEventListener('click',()=>{const ai=el(kind==='registerLocation'?'itmActivateLoc':'itmActivateContainer');if(ai)ai.value=manualCode;
       const det=ai&&ai.closest('details');if(det)det.open=true;if(ai)ai.focus();});
     bxr.appendChild(bAc);
    }
    await pending();return;
   }
   if(regResult&&regResult.phase==='REJECTED'){rstatus('建档被拒：'+errText({message:String(regResult.error||'')}));await pending();return;}
   /* 离线/自动提交未完成：保持待处理区引导 */
   rstatus('建档申请已保存：'+manualCode+'；确认前不打印正式标签');
   /* 阶段31c（审计 P1）：LOC/CTN 建档入队后的下一步引导 —— 给出闭环指引+预填。 */
   const bxr=el('itmRegisterResult');if(bxr){bxr.replaceChildren();
    line(bxr,'已保存：'+manualCode+'（'+({registerLocation:'库位',registerContainer:'容器'}[kind])+'）—— 下一步两步走：');
    line(bxr,'① 到「待处理区」执行这条建档命令；② 成功后实体是「未核实」状态，在下方「核实启用」里现场核实转正。');
    const bGo=doc.createElement('button');bGo.type='button';bGo.className='btn small';bGo.textContent='↗ 去待处理区执行';
    bGo.addEventListener('click',()=>{const nb=doc.querySelector('nav.tabs button[data-tab=item-work]');if(nb)nb.click();});
    bxr.appendChild(bGo);
    const bAc=doc.createElement('button');bAc.type='button';bAc.className='btn small ghost';bAc.textContent='↓ 预填核实启用';
    bAc.addEventListener('click',()=>{const ai=el(kind==='registerLocation'?'itmActivateLoc':'itmActivateContainer');if(ai)ai.value=manualCode;
      const det=ai&&ai.closest('details');if(det)det.open=true;if(ai)ai.focus();});
    bxr.appendChild(bAc);
   }
   await pending();return;
  }
  const category=(el('itmRegisterCat')&&el('itmRegisterCat').value)||'';
  if(!manualCode&&!category)throw Error('请先选择物品分类（决定物品码前缀 WP-分类-序号）');
  if(!name)throw Error('请填写物品名称');
  const spec=(el('itmRegisterSpec')&&el('itmRegisterSpec').value.trim())||'';
  /* v3.12.0：关联物料码 —— 让「物品」能挂到「物料台账」下。
     字段早已存在于飞书 items 表（feishu-api.js:252 关联物料码）与
     ordinaryFields 白名单（unique-items.js:285），此前**没有任何 UI 能填它**。
     这里只补入口，不加飞书列、不做数据迁移；留空即不关联。 */
  const materialCode=(el('itmRegisterMaterial')&&el('itmRegisterMaterial').value.trim())||'';
  if(manualCode){
   /* 手动码路径保留：带码入队，待处理区提交。2.49.3：结构化 WP 码先规范形化（大小写/写法），
      否则会入队一张注定被服务端 NON_CANONICAL_ITEM_CODE 拒收的卡；完全非结构化的码仍交服务端裁决。 */
   const win=doc.defaultView,LL=win&&win.ItemLink;let codeOut=manualCode,canonicalized=false;
   if(LL&&typeof LL.parseItemCode==='function'){const parsed=LL.parseItemCode(manualCode);if(parsed&&typeof LL.toItemCode==='function'){const canon=LL.toItemCode(parsed);if(canon&&canon!==manualCode){codeOut=canon;canonicalized=true;el('itmRegisterCode').value=canon;}}}
   const entity={code:codeOut,name};if(spec)entity.spec=spec;if(materialCode)entity.materialCode=materialCode;
   /* v3.4.0 R4：手动码建档在线即时提交（与库位/容器建档同策略） */
   const regOpId=id();
   await p.enqueue({schemaVersion:1,opId:regOpId,kind,entity});
   const regResult=await autoSubmitCommand(regOpId);
   if(regResult&&regResult.phase==='APPLIED'){rstatus('已建档：'+codeOut+'（手动码'+(canonicalized?'，已规范为标准写法':'')+'）；确认前不打印正式标签');await pending();return;}
   if(regResult&&regResult.phase==='REJECTED'){rstatus('建档被拒：'+errText({message:String(regResult.error||'')}));await pending();return;}
   rstatus('建档申请已保存：'+codeOut+'（手动码'+(canonicalized?'，已规范为标准写法':'；结构化码必须用标准写法 WP-分类-序号')+'）；请在待处理区执行，确认前不打印正式标签');await pending();return;
  }
  const entity={category,name};if(spec)entity.spec=spec;if(materialCode)entity.materialCode=materialCode;
  const request={schemaVersion:1,opId:id(),kind,entity};
  await p.enqueue(request);
  const online=getClient&&(!isOnline||isOnline());
  if(!online){rstatus('建档申请已保存本机（当前离线）：提交后由服务端分配物品码，请联网后到待处理区提交');await pending();return;}
  rstatus('已保存本机，正在提交发号…');
  const cmds=await getCommands();const cmd=(cmds||[]).find(x=>x.id===request.opId);
  if(!cmd)throw Error('命令未保存，请到待处理区检查');
  const result=await getClient().submit(cmd);
  await pending();
  if(result&&result.phase==='APPLIED'){
   const code=result.request&&result.request.entity&&result.request.entity.code;
   if(!code)throw Error('服务端未回填物品码，请在待处理区查询云端结果');
   showRegisterResult(code,name,category);
   { const mm=el('itmRegisterMaterial'); if(mm)mm.value=''; }
   const bx=el('itmRegisterResult');if(bx)line(bx,'建档完成：'+code+'；打印以 APPLIED 返回的码与预览二维码为准');
  }else rstatus('建档结果：'+stateLabel(result&&result.phase)+'；请在待处理区核对原命令，勿重复建档');
 }finally{adminBusy=false;}},rstatus));
 el('itmRetire').addEventListener('click',()=>run(async()=>{if(adminBusy)return;adminBusy=true;try{const item=U.unique(getState(),'items',el('itmRetireCode').value.trim());if(!['pending','out'].includes(item.status))throw Error('仅待入库或已出库物品允许退役');   /* S5.1 合约锁：unknown 不得从 UI 退役（服务端 API 留口供恢复用） */const reason=el('itmRetireReason').value.trim();if(!reason)throw Error('请填写退役原因');const p=getPersistence();if(!p)throw Error('IDB不可用');
  /* TASK-20（BUG-18）：同一物品已有一条未决 retire 时不再入队——BUG-17 时代用户看不到
     反馈连点 5 次产生 5 张重复卡。未决=outbox 里未到终态的条目（终态会被 acknowledge 清出）。 */
  { const cmds=getCommands?await getCommands():[];const dup=(cmds||[]).find(x=>x.request&&x.request.kind==='retire'&&x.request.itemCode===item.code);
    if(dup){rstatus('该物品已有一条待提交的退役命令（编号 '+dup.id+'），请在「待处理区」先执行或删除它。');return;} }
  await p.enqueue({schemaVersion:1,opId:id(),kind:'retire',itemCode:item.code,expected:{itemVersion:item.version},reason});
  /* TASK-20（BUG-17）：本 handler 属注册页，itmStatus 在「物品作业」页签——用户在本页看不到
     提示（DSH 实测因看不到反馈连点 5 次退役）。改写本页容器 itmRegisterResult。 */
  rstatus('退役申请已保存，请在待处理区提交并核对结果，不代表已退役');await pending();}finally{adminBusy=false;}}));
 el('itmActivateLoc').addEventListener('click',()=>run(()=>activate('activateLocation')));
 el('itmActivateContainer').addEventListener('click',()=>run(()=>activate('activateContainer')));
 function stopCamera(){closeSharedCamera();}
 el('itmCameraStop').addEventListener('click',stopCamera);
 el('itmCamera').addEventListener('click',()=>run(async()=>{
  const c=getScanCamera();if(!c)throw Error('相机不可用，请使用扫码枪/手输；草稿已保留');
  const r=scan.row(),labels=stepLabels[r.kind]||[];
  await c.open({
   hint:'对准当前步骤的二维码/条形码，识别后需确认才填入输入框',
   describe:describeWorkHit,
   onConfirm:(text)=>{el('itmCode').value=text;try{el('itmCode').focus();}catch(_){}const r=scan.row(),labels=stepLabels[r.kind]||[];const stepName=labels[r.values.length]||'当前步骤';status('已填入输入框，点「填入本步骤」或回车确认到当前步骤（'+stepName+'）');},
   onCancel:(reason,unconfirmed)=>{if(unconfirmed)status('已识别到「'+unconfirmed+'」，但你没点「确定填入」，未写入输入框；重新扫码后请点确认');}
  });
 }));
 render();return {scan,render,search,detail,accept,pending,stopCamera,queryScan,autoRestoreDraft};
}
return {mount};
});
