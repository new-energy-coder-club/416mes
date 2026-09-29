'use strict';
/* Phase A 批次3（v3.13.31）验收测试：
   · A-4  moveContainer/placeContainer 扫码入口删除 + 重建白名单人话兜底（正向对照 receive 可重建）；
   · A-5  activateContainer 纯启用（plan 无 locations 写面；离线入队不带 target）；
   · A-6  容器落位向导（命令链 activateContainer→activateLocation、幂等跳过、离线可续、三类拦截）；
   · CONTROLLED 写面形状锁定（plan before/after 快照键集精确断言）；
   · 辅助任务结论：entityKeysOf 不锁 containers:parentContainer —— 键集证据固化为本测试。 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom'),UI=require('../lib/item-ui'),U=require('../lib/unique-items');

/* 与 register-feedback.test.js 同款挂载：linkedom 解析 index.html + mock persistence/client。
   queue = 运行期入队命令（向导/激活路径落点）；fixed = 直接注入的待处理卡（重试按钮用例）。 */
function setup(opts={}){
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const {document}=parseHTML(html);
  let n=0,submitCalls=0;
  const state={locations:[],containers:[],items:[],itemOperations:[]};
  const queue=[],fixed=(opts.commands||[]);
  const persistence={
    async enqueue(r){queue.push(r);},
    async saveDraft(){},
    async recover(){return {drafts:[],commands:[]}},
    async abandonCommand(id){
      const i=fixed.findIndex(c=>c.id===id);if(i>=0)fixed.splice(i,1);
      const j=queue.findIndex(r=>r.opId===id);if(j>=0)queue.splice(j,1);
    }
  };
  const getCommands=async()=>[...fixed,...queue.map(r=>({id:r.opId,request:r,status:'pending'}))];
  const client=opts.client||{async submit(){submitCalls++;return {phase:'APPLIED',request:{}}}};
  const page=UI.mount({document,getState:()=>state,getPersistence:()=>persistence,getCommands,
    id:()=>'p3-'+(++n),getClient:()=>client,isOnline:opts.isOnline||(()=>true)});
  return {document,state,page,queue,fixed,client,submitCalls:()=>submitCalls};
}
const tick=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
function openWizard(d){
  d.getElementById('itmPlacementWizardBtn').click();
  const box=d.getElementById('itmRegisterResult');
  const inputs=box.querySelectorAll('input.field');
  return {box,ctn:inputs[0],loc:inputs[1],
    btn:()=>[...box.querySelectorAll('button')].find(b=>b.textContent==='标注此格')};
}
function seedCtn(state,code,status){state.containers.push({code,type:'开放式收纳格',spec:'',loc:'',status,version:1,lastOpId:'x'});}
function seedLoc(state,code,extra){
  state.locations.push(Object.assign({code,status:'active',kind:'货架库位',role:'',parentContainer:'',desc:''},extra||{}));
}

/* ================= A-4：moveContainer/placeContainer 扫码入口已删 ================= */

test('A-4：scan.add 对 moveContainer/placeContainer/未知类型一律抛「不支持的扫码动作」，且抛错不污染步骤序列',()=>{
  const {page}=setup();
  assert.throws(()=>page.scan.add('moveContainer'),/不支持的扫码动作：moveContainer（请重新选择作业类型）/);
  assert.throws(()=>page.scan.add('placeContainer'),/不支持的扫码动作：placeContainer（请重新选择作业类型）/);
  assert.throws(()=>page.scan.add('unknownKind'),/不支持的扫码动作：unknownKind/);
  /* 抛错后四种作业类型仍可正常建行（mount 初始会话自带一行 receive 草稿，追加即计入）；
     sequences 查表未被异常路径污染：不存在任何 move/place 行 */
  page.scan.add('issue');page.scan.add('transfer');page.scan.add('verifyLegacy');
  const rows=page.scan.snapshot().rows;
  assert.deepEqual(rows.map(r=>r.kind),['receive','issue','transfer','verifyLegacy'],
    '仅剩四种扫码作业类型（A-4：move/place 入口删除后序列完好）');
});

test('A-4：待处理卡里的 moveContainer/placeContainer 点「重试（按最新数据）」→ 人话兜底，不入队新命令',async()=>{
  const {document:d,page,queue,fixed}=setup({commands:[
    {id:'old-m1',status:'needs_attention',request:{schemaVersion:1,opId:'old-m1',kind:'moveContainer',
      containerCode:'C-1',source:{loc:'B-1'},target:{loc:'B-2'},expected:{containerVersion:1}}},
    {id:'old-p1',status:'needs_attention',request:{schemaVersion:1,opId:'old-p1',kind:'placeContainer',
      containerCode:'C-2',target:{loc:'B-3'},expected:{containerVersion:1}}}
  ]});
  await page.pending();   // 显式渲染待处理区（与 item-ui.test.js 同款口径）
  const clickRetry=async(idx)=>{
    const btns=[...d.querySelectorAll('#itmPending button')].filter(b=>b.textContent==='重试（按最新数据）');
    assert.equal(btns.length,2,'两张未决卡都应给出「重试（按最新数据）」主键');
    btns[idx].click();await tick();
  };
  await clickRetry(0);
  assert.match(d.getElementById('itmStatus').textContent,/这条命令无法自动重试/);
  assert.match(d.getElementById('itmStatus').textContent,/命令类型 moveContainer 不支持自动重建/,
    'A-4：moveContainer 不在重建白名单，给可操作的人话兜底');
  await clickRetry(1);
  assert.match(d.getElementById('itmStatus').textContent,/命令类型 placeContainer 不支持自动重建/);
  assert.equal(queue.length,0,'被拦下的卡不得悄悄生成新命令');
  assert.equal(fixed.length,2,'原卡保留（用户可删记录或重新扫码）');
});

test('A-4 正向对照：receive 卡同入口 → 从请求快照重建（新 opId、最新版本）→ 提交成功',async()=>{
  const {document:d,page,queue,fixed,state}=setup({commands:[
    {id:'old-r1',status:'needs_attention',request:{schemaVersion:1,opId:'old-r1',kind:'receive',
      itemCode:'WP-1',target:{loc:'B-1',container:'C-1'},expected:{itemVersion:2,containerVersion:3}}}
  ]});
  state.items.push({code:'WP-1',container:'',loc:'',status:'out',version:2});
  seedCtn(state,'C-1','active');state.containers[0].version=3;state.containers[0].loc='B-1';
  seedLoc(state,'B-1');
  await page.pending();   // 显式渲染待处理区
  const btn=[...d.querySelectorAll('#itmPending button')].find(b=>b.textContent==='重试（按最新数据）');
  btn.click();await tick();
  assert.match(d.getElementById('itmStatus').textContent,/重试成功：远端已确认/);
  assert.equal(queue.length,1,'重建命令已入队');
  const req=queue[0];
  assert.equal(req.kind,'receive');
  assert.notEqual(req.opId,'old-r1','重建必须换新 opId（绕开同编号重放死循环）');
  assert.deepEqual(req.expected,{itemVersion:2,containerVersion:3},'版本取自最新本地镜像');
  assert.equal(fixed.length,0,'旧卡已被收编（abandonCommand）');
});

/* ================= A-5：activateContainer 纯启用 ================= */

test('A-5：plan 层 activateContainer 纯启用——只写 containers（active+loc 清空），旧客户端混入 target 也不产生 locations 写面',()=>{
  const st={locations:[{code:'B-1',status:'active',role:'',parentContainer:''}],
    containers:[{code:'C-1',loc:'',status:'unknown',version:1}],items:[]};
  /* 故意带上旧形状 target（A-5 前的请求会带 target/targetLoc）——plan 必须完全忽略它 */
  const plan=U.plan(st,{schemaVersion:1,opId:'op-a5',kind:'activateContainer',containerCode:'C-1',
    target:{loc:'B-1',container:'C-1'},expected:{containerVersion:1}},{id:'u1',roles:['admin']});
  assert.deepEqual(plan.after.containers,
    [{code:'C-1',loc:'',status:'active',version:2,lastOpId:'op-a5'}],
    'after：active + loc 显式清空（绝不保留旧值）');
  assert.equal(plan.before.locations,undefined,'纯启用无 locations 写面（before）');
  assert.equal(plan.after.locations,undefined,'纯启用无 locations 写面（after）——target 被彻底忽略');
});

test('A-5：建档管理页离线「核实启用容器」→ 入队 {kind,expected:{containerVersion}} 且不带 target',async()=>{
  const {document:d,queue,state}=setup({isOnline:()=>false});
  seedCtn(state,'C-9','unknown');
  d.getElementById('itmAdminContainer').value='C-9';
  d.getElementById('itmActivateContainer').click();await tick();
  assert.equal(queue.length,1);
  const req=queue[0];
  assert.equal(req.kind,'activateContainer');
  assert.equal(req.containerCode,'C-9');
  assert.deepEqual(req.expected,{containerVersion:1},'离线路径版本前置照常携带');
  assert.equal(false,Object.hasOwn(req,'target'),'A-5：离线入队的 activateContainer 不带 target');
  assert.match(d.getElementById('itmRegisterResult').textContent,/当前离线：核实启用命令已保存本机/);
});

/* ================= A-6：容器落位向导 ================= */

test('A-6：向导标注 → 命令链固定 activateContainer 先于 activateLocation；标注带 role/parentContainer；启用不带 target',async()=>{
  const {document:d,queue,state,submitCalls}=setup();
  seedCtn(state,'C-1','unknown');
  seedLoc(state,'B-1');
  const w=openWizard(d);
  w.ctn.value='C-1';w.loc.value='B-1';w.btn().click();await tick();
  assert.deepEqual(queue.map(r=>r.kind),['activateContainer','activateLocation'],
    '先启用容器，再标注子位（服务端 active(parent) 预检查 + 离线 outbox 按序重放）');
  const act=queue[0];
  assert.equal(act.containerCode,'C-1');
  assert.equal(act.expected.containerVersion,1);
  assert.equal(act.target,undefined,'A-5：链路里的启用是纯启用');
  const mark=queue[1];
  assert.equal(mark.locationCode,'B-1');
  assert.equal(mark.role,'容器子位','向导标注走「容器子位」角色');
  assert.equal(mark.parentContainer,'C-1','从属容器=向导里填的容器');
  assert.equal(mark.expected.locationStatus,'active');
  assert.equal(submitCalls(),2,'在线时两条命令入队即自动提交');
  assert.match(w.box.textContent,/已标注为本容器的「容器子位」/);
});

test('A-6 幂等①：已是本容器的子位 → 跳过（零入队、零提交），重扫无副作用',async()=>{
  const {document:d,queue,state,submitCalls}=setup();
  seedCtn(state,'C-1','active');
  seedLoc(state,'B-1',{role:'容器子位',parentContainer:'C-1'});
  const w=openWizard(d);
  w.ctn.value='C-1';w.loc.value='B-1';w.btn().click();await tick();
  assert.match(w.box.textContent,/已是本容器的「容器子位」，无需重复标注（跳过）/);
  assert.equal(queue.length,0,'幂等跳过不入队任何命令');
  assert.equal(submitCalls(),0);
});

test('A-6 幂等②：同格同父的标注命令已在待提交队列 → 跳过，不重复入队',async()=>{
  const {document:d,queue,state,submitCalls}=setup({commands:[
    {id:'pend-1',status:'pending',request:{schemaVersion:1,opId:'pend-1',kind:'activateLocation',
      locationCode:'B-1',role:'容器子位',parentContainer:'C-1',expected:{}}}
  ]});
  seedCtn(state,'C-1','active');
  seedLoc(state,'B-1');
  const w=openWizard(d);
  w.ctn.value='C-1';w.loc.value='B-1';w.btn().click();await tick();
  assert.match(w.box.textContent,/已有一条待提交的子位标注（联网提交后生效），不重复入队/);
  assert.equal(queue.length,0);
  assert.equal(submitCalls(),0);
});

test('A-6 离线可续：两条命令按序存本机（先启用、后标注），不发起任何提交',async()=>{
  const {document:d,queue,state,submitCalls,client}=setup({isOnline:()=>false});
  let submitted=0;client.submit=async()=>{submitted++;return {phase:'APPLIED'};};
  seedCtn(state,'C-1','unknown');
  seedLoc(state,'B-1');
  const w=openWizard(d);
  w.ctn.value='C-1';w.loc.value='B-1';w.btn().click();await tick();
  assert.match(w.box.textContent,/✓ B-1 子位标注已存本机（当前离线，联网后按序自动提交：先启用容器、再标注）/);
  assert.deepEqual(queue.map(r=>r.kind),['activateContainer','activateLocation'],'离线 outbox 按序重放的前提：入队顺序固定');
  assert.equal(queue[0].target,undefined,'离线存的启用命令同样是 A-5 纯启用');
  assert.equal(queue[1].role,'容器子位');
  assert.equal(submitted,0,'离线绝不联网提交');
  assert.equal(submitCalls(),0);
});

test('A-6 拦截：他父容器 / 旧模型 containers.loc 占位 / 库位未建档 → 全部拦下并说明原因，不改数据',async()=>{
  const {document:d,queue,state,submitCalls}=setup();
  seedCtn(state,'C-1','active');
  seedLoc(state,'B-PA',{role:'容器子位',parentContainer:'KF-OTHER'});   // 拦截①：该格已从属别的容器
  seedLoc(state,'B-BOUND');
  state.containers.push({code:'C-OLD',type:'开放式收纳格',spec:'',loc:'B-BOUND',status:'active',version:1,lastOpId:'x'}); // 拦截②：旧模型占位
  const w=openWizard(d);
  w.ctn.value='C-1';
  w.loc.value='B-PA';w.btn().click();await tick();
  assert.match(w.box.textContent,/B-PA 已从属容器 KF-OTHER：一格只属一个容器/,'他父容器拦截');
  w.loc.value='B-BOUND';w.btn().click();await tick();
  assert.match(w.box.textContent,/B-BOUND 已被容器 C-OLD 绑定（旧模型占位）/,'旧模型占位拦截');
  w.loc.value='B-MISSING';w.btn().click();await tick();
  assert.match(w.box.textContent,/未找到库位档案 B-MISSING：库位须先建档/,'NOT_FOUND 拦截');
  assert.equal(queue.length,0,'三类拦截都不入队、不改数据');
  assert.equal(submitCalls(),0);
  /* 完成落位小结如实分类：0 新标注 / 0 跳过 / 3 拦截 */
  [...w.box.querySelectorAll('button')].find(b=>b.textContent==='完成落位').click();
  assert.match(w.box.textContent,/拦截 3 格/);
});

/* ================= CONTROLLED 写面形状锁定 ================= */

test('CONTROLLED 形状锁定：receive/activateContainer/子位化 activateLocation 三个 plan 的 before/after 行键集精确匹配冻结字段集',()=>{
  /* 声明面：三张表的 CONTROLLED 字段集是硬约束（plan 的 controlled() 逐字段克隆） */
  assert.deepEqual(U.CONTROLLED,{items:['container','loc','status','version','lastOpId'],
    containers:['loc','status','version','lastOpId'],locations:['status','role','parentContainer']});
  const keySet=rows=>[...new Set((rows||[]).flatMap(r=>Object.keys(r)))].sort();
  const actor={id:'u1',roles:['admin']};
  /* ① receive：只写 items 行 */
  const stR={locations:[{code:'B-1',status:'active',role:'',parentContainer:''}],
    containers:[{code:'C-1',loc:'B-1',status:'active',version:3}],
    items:[{code:'WP-1',container:'',loc:'',status:'out',version:2}]};
  const pR=U.plan(stR,{schemaVersion:1,opId:'op-r',kind:'receive',itemCode:'WP-1',
    target:{loc:'B-1',container:'C-1'},expected:{itemVersion:2,containerVersion:3}},actor);
  assert.deepEqual(keySet(pR.before.items),['code','container','lastOpId','loc','status','version']);
  assert.deepEqual(keySet(pR.after.items),['code','container','lastOpId','loc','status','version'],
    'items 行 = code + CONTROLLED.items（多一个键都是形状破坏）');
  /* ② activateContainer：只写 containers 行（A-5 纯启用） */
  const stC={locations:[],containers:[{code:'C-1',loc:'',status:'unknown',version:1}],items:[]};
  const pC=U.plan(stC,{schemaVersion:1,opId:'op-c',kind:'activateContainer',containerCode:'C-1',
    expected:{containerVersion:1}},actor);
  assert.deepEqual(keySet(pC.before.containers),['code','lastOpId','loc','status','version']);
  assert.deepEqual(keySet(pC.after.containers),['code','lastOpId','loc','status','version']);
  /* ③ 子位化 activateLocation（迁移期残留：父容器自身仍以 loc 绑着此格）——
     一条命令同时写 locations 行 + containers 清绑行，键集都不越界 */
  const stL={locations:[{code:'B-1',status:'unknown',role:'',parentContainer:''}],
    containers:[{code:'C-1',loc:'B-1',status:'active',version:1}],items:[]};
  const pL=U.plan(stL,{schemaVersion:1,opId:'op-l',kind:'activateLocation',locationCode:'B-1',
    role:'容器子位',parentContainer:'C-1',expected:{locationStatus:'unknown'}},actor);
  assert.deepEqual(keySet(pL.before.locations),['code','parentContainer','role','status']);
  assert.deepEqual(keySet(pL.after.locations),['code','parentContainer','role','status'],
    'locations 行 = code + CONTROLLED.locations（含 role/parentContainer，无多余键）');
  assert.deepEqual(pL.after.locations,[{code:'B-1',status:'active',role:'容器子位',parentContainer:'C-1'}]);
  assert.deepEqual(keySet(pL.before.containers),['code','lastOpId','loc','status','version']);
  assert.deepEqual(keySet(pL.after.containers),['code','lastOpId','loc','status','version']);
  assert.equal(pL.after.containers[0].loc,'','旧模型残留清绑：loc 显式置空');
});

/* ================= 辅助任务结论：entityKeysOf 不锁 containers:parentContainer =================
   证据链（本轮核实，唯一结论：无需代码更改，此测试固化证据）：
   ① 键集原则是「写哪行锁哪行」——activateLocation 的 locations 写已由 add('locations',req.locationCode)
     （unique-items.js:92）覆盖；该命令对 containers 的唯一写路径是「父容器自身旧模型残留清绑」
     （unique-items.js:211 if (bound) change('containers',…,{loc:''})），此时 bound.code===req.parentContainer，
     而父容器行仍受 req.containerCode/source/target 的 containers 键保护吗？——不：activateLocation 请求
     根本没有这些字段。但该写受两道独立安全网保护：
     ② 写前重计划（item-operation.js:265-269）：apply 前用 frozen 快照重新 plan 并逐字段比对 before/after，
       parentContainer/loc/version 任一变化都会撞 TRIAL_PRECONDITION_CHANGED——它独立于键集存在；
     ③ 服务端 plan/回读仍是最终安全网。
   ③ 反向论证：若补 'containers:'+req.parentContainer 键，「同一容器给多个格子标注子位」会被不必要
     串行化；而向导已保证 activateContainer→activateLocation 在同一 outbox 按入队顺序重放，
     无需靠键集互斥来保序。 */
test('辅助任务：activateLocation 子位标注的键集只含 locations:<code>，不含 containers:<parentContainer>',()=>{
  const keys=U.entityKeysOf({schemaVersion:1,opId:'op-k',kind:'activateLocation',locationCode:'L-1',
    role:'容器子位',parentContainer:'KF-777',expected:{locationStatus:'unknown'}});
  assert.ok(keys.has('locations:L-1'),'标注行的 locations 键必须在（覆盖该命令的 locations 写）');
  assert.equal(keys.has('containers:KF-777'),false,
    '不锁 containers:parentContainer——写前重计划（TRIAL_PRECONDITION_CHANGED）已兜底，补键只会制造串行墙');
});
