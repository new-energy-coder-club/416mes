'use strict';
/* Phase A 批次4（v3.13.32）验收测试：
   · N3 显式锁定：无子键的旧式请求在冻结体迁移期的真实行为（先探针后断言）——
     ① 接收 target={loc,container}（带容器）→ pair 校验放行（迁移期保留，CLM-6.5 同源）；
     ② 不带容器也不带子键（role/parentContainer）→ 拒绝 INVALID_CODE（与 CLM-6.3 同族：
       容器码校验在前），target 缺失 → MISSING_RELATION；
   · A-8 缺列降级矩阵：飞书「库位」表缺「库位角色/所属容器码」列（列中途被删）时——
     全量路径 ItemSync.merge → incomplete-controlled-group 冲突（fail-closed，行不采用，
     本地子位数据不被静默覆写/开门）；增量三方路径 planMerge → 缺键字段不遍历（无写入
     无冲突，本地值静默保留）；客户端向导入口 itmLocSublocMissingColumns 闸门拦截新写入
     （提示需管理员补列，禁止半写），读取类判定（已标注跳过）不受影响。 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom'),UI=require('../lib/item-ui'),U=require('../lib/unique-items');
const ItemSync=require('../lib/item-sync'),ThreeWay=require('../lib/three-way-merge');

const actor={id:'u',roles:['operator']};

/* ================= N3：无子键的旧式请求（冻结体迁移期兼容锁） ================= */

test('N3-① 冻结体迁移期兼容锁：接收 target={loc,container} 无子键 → pair 校验放行（迁移期保留，Phase D 删容器链时改写）',()=>{
  const st={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',status:'active',loc:'L-A',version:2}],items:[{code:'I-P',status:'pending',version:0}]};
  U.migrate(st);
  const p=U.plan(st,{schemaVersion:1,opId:'n3-1',kind:'receive',itemCode:'I-P',
    target:{loc:'L-A',container:'C-A'},expected:{itemVersion:0,containerVersion:2}},actor);
  assert.deepEqual(p.after.items[0],{code:'I-P',container:'C-A',loc:'',status:'in_stock',version:1,lastOpId:'n3-1'},
    '放行路径：pair 校验通过后按旧模型入库（container 归属，loc 清空）');
  /* pair 语义仍在：容器不在目标库位 → CONTAINER_LOCATION_MISMATCH（CLM-6.5 同源闸门） */
  const st2={locations:[{code:'L-A',status:'active'},{code:'L-B',status:'active'}],
    containers:[{code:'C-A',status:'active',loc:'L-B',version:2}],items:[{code:'I-P',status:'pending',version:0}]};
  U.migrate(st2);
  assert.throws(()=>U.plan(st2,{schemaVersion:1,opId:'n3-1b',kind:'receive',itemCode:'I-P',
    target:{loc:'L-A',container:'C-A'},expected:{itemVersion:0,containerVersion:2}},actor),
    e=>assert.equal(e.code,'CONTAINER_LOCATION_MISMATCH')||true);
});

test('N3-② 冻结体迁移期兼容锁：接收不带容器也不带子键 → 拒绝 INVALID_CODE（与 CLM-6.3 同族）；target 缺失 → MISSING_RELATION',()=>{
  const st={locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',status:'active',loc:'L-A',version:2}],items:[{code:'I-P',status:'pending',version:0}]};
  U.migrate(st);
  /* 实际行为探针（2026 证据）：target={loc} 无容器 → unique('containers',undefined) → INVALID_CODE。
     合同核对：CLM-6.3 自己锁定「空容器声明 → INVALID_CODE（容器码校验在前端）」，同族一致，
     不属于行为与合同不符。 */
  assert.throws(()=>U.plan(st,{schemaVersion:1,opId:'n3-2',kind:'receive',itemCode:'I-P',
    target:{loc:'L-A'},expected:{itemVersion:0}},actor),
    e=>assert.equal(e.code,'INVALID_CODE')||true);
  assert.throws(()=>U.plan(st,{schemaVersion:1,opId:'n3-3',kind:'receive',itemCode:'I-P',
    target:null,expected:{itemVersion:0}},actor),
    e=>assert.equal(e.code,'MISSING_RELATION')||true);
});

/* ================= A-8 矩阵：子位数据已存在 + role/parentContainer 列中途被删 ================= */

/* 全量路径：fsMerge → ItemSync.merge。列被删后 mapDown 产出的 raw 行缺 role/parentContainer
   键 → 受控组不完整 → fail-closed 挂 incomplete-controlled-group，行不被采用。 */
test('A-8 全量路径：子位数据已存在 + 列中途被删 → incomplete-controlled-group 冲突，本地子位数据不被静默覆写/开门',()=>{
  const state={
    locations:[{code:'SUB-1',status:'active',role:'容器子位',parentContainer:'C-A',kind:'货架',desc:'',grants:''}],
    containers:[{code:'C-A',loc:'SUB-1',status:'active',version:1,lastOpId:''}],
    items:[],itemOperations:[]
  };
  /* 列被删后的远端行：只有尚存的列（status 列还在，role/parentContainer 两列没了） */
  const remote={locations:[{code:'SUB-1',status:'active',kind:'货架',desc:''}],
    containers:[{code:'C-A',loc:'SUB-1',status:'active',version:1,lastOpId:''}],items:[]};
  const {conflicts,ordinary}=ItemSync.merge(state,remote);
  assert.ok(conflicts.some(c=>c.table==='locations'&&c.key==='SUB-1'&&c.reason==='incomplete-controlled-group'),
    '缺列 ≠ 显式改值：受控组不完整必须挂 incomplete-controlled-group（不得静默采用）');
  assert.equal(state.locations[0].role,'容器子位','本地子位标注不被静默覆写');
  assert.equal(state.locations[0].parentContainer,'C-A','本地子位归属不被静默覆写');
  assert.equal(state.locations[0].status,'active','受控组整体不落地：本地受控值原样保留');
  assert.ok(state.__itmConflicts['locations:SUB-1'],'冲突登记粘滞：后续合并前不得放行');
  /* ordinary 输出口径：普通合并拿到的仍是本地受控值（展示不丢子位事实），不是空子位 */
  const out=ordinary.locations.find(r=>r.code==='SUB-1');
  assert.equal(out.role,'容器子位');
  assert.equal(out.parentContainer,'C-A');
  /* 对照组：远端显式带完整受控组但无凭据 → 语义不同，挂 unverified-controlled-change（:82 缺列≠清值的区分） */
  const state2={
    locations:[{code:'SUB-1',status:'active',role:'容器子位',parentContainer:'C-A',kind:'货架',desc:'',grants:''}],
    containers:[{code:'C-A',loc:'SUB-1',status:'active',version:1,lastOpId:''}],
    items:[],itemOperations:[]
  };
  const remote2={locations:[{code:'SUB-1',status:'active',role:'自由位',parentContainer:'',kind:'货架',desc:''}],
    containers:[{code:'C-A',loc:'SUB-1',status:'active',version:1,lastOpId:''}],items:[]};
  const {conflicts:c2}=ItemSync.merge(state2,remote2);
  assert.ok(c2.some(c=>c.table==='locations'&&c.key==='SUB-1'&&c.reason==='unverified-controlled-change'),
    '显式改值（列在、无凭据）走 unverified 而非 incomplete：两种拒绝码语义不混用');
  assert.equal(state2.locations[0].role,'容器子位','无凭据改值同样不落地');
});

/* 增量路径：fsIncrementalSync → fsThreeWayApply(planMerge)。远端行缺键 → 字段不遍历 →
   无写入无冲突，本地子位数据静默保留（known gap：增量路径不更新 __itmSchemaColumns，
   全量/refreshConflicts 路径补感知——见交付报告设计说明）。 */
test('A-8 增量路径：列被删后远端行缺 role/parentContainer 键 → planMerge 无写入无冲突，本地子位数据保留',()=>{
  const base={locations:[{code:'SUB-1',status:'active',role:'容器子位',parentContainer:'C-A'}]};
  const local={locations:[{code:'SUB-1',status:'active',role:'容器子位',parentContainer:'C-A'}]};
  const remote={locations:[{code:'SUB-1',status:'active'}]};   /* 列被删：行缺两个子位键 */
  const plan=ThreeWay.planMerge(base,local,remote);
  assert.equal(plan.writes.length,0,'缺键字段不进字段遍历：不得产生覆盖本地子位数据的写入');
  assert.equal(plan.conflicts.length,0,'静默保留（迁移期兼容行为），不制造人工裁决噪声');
  assert.deepEqual(local.locations[0],{code:'SUB-1',status:'active',role:'容器子位',parentContainer:'C-A'},
    '本地子位数据原样保留');
  /* 对照：远端显式清值（列在）→ 本地没动时采纳远端（既有「含远端清空」语义，非缺列场景） */
  const remote2={locations:[{code:'SUB-1',status:'active',role:'',parentContainer:''}]};
  const plan2=ThreeWay.planMerge(base,structuredClone(local),remote2);
  assert.equal(plan2.writes.length,1,'显式清值走远端快进（列未删，管理员语义）');
  assert.equal(plan2.writes[0].fields.role,'');
});

/* ================= A-8 客户端入口：向导缺列闸门（linkedom UI） ================= */

/* 与 register-feedback.test.js / phase-a-batch3.test.js 同款挂载：linkedom 解析 index.html
   + mock persistence/client。queue = 运行期入队命令（向导/激活路径落点）。 */
function setup(){
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const {document}=parseHTML(html);
  let n=0;
  const state={locations:[],containers:[],items:[],itemOperations:[]};
  const queue=[];
  const persistence={
    async enqueue(r){queue.push(r);},
    async saveDraft(){},
    async recover(){return {drafts:[],commands:[]}}
  };
  const getCommands=async()=>queue.map(r=>({id:r.opId,request:r,status:'pending'}));
  const client={async submit(){return {phase:'APPLIED',request:{}}}};
  const page=UI.mount({document,getState:()=>state,getPersistence:()=>persistence,getCommands,
    id:()=>'p4-'+(++n),getClient:()=>client,isOnline:()=>true});
  return {document,state,page,queue};
}
const tick=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
function openWizard(d){
  d.getElementById('itmPlacementWizardBtn').click();
  const box=d.getElementById('itmRegisterResult');
  const inputs=box.querySelectorAll('input.field');
  return {box,ctn:inputs[0],loc:inputs[1],
    btn:()=>[...box.querySelectorAll('button')].find(b=>b.textContent==='标注此格')};
}
function seed(state){
  state.locations.push({code:'B-1',status:'active',kind:'货架',role:'',parentContainer:'',desc:''});
  state.containers.push({code:'C-1',type:'开放式收纳格',spec:'',loc:'',status:'active',version:1,lastOpId:'x'});
}
const COLS_FULL=['库位码','类型','说明','授权人员','库位角色','所属容器码','状态'];
const COLS_NO_SUBLOC=['库位码','类型','说明','授权人员','状态'];

test('A-8 入口闸门：已知缺列 → 拦截并提示需管理员补列，未入队任何命令（禁止半写）',async()=>{
  const {document:d,state,queue}=setup();
  seed(state);
  state.__itmSchemaColumns={locations:[...COLS_NO_SUBLOC]};   /* 全量同步镜像：两列缺失 */
  const w=openWizard(d);
  w.ctn.value='C-1';w.loc.value='B-1';
  w.btn().click();await tick();
  assert.match(w.box.textContent,/缺少子位标注所需的列/,'人话指出缺的列');
  assert.match(w.box.textContent,/库位角色、所属容器码/,'点名列出缺失列');
  assert.match(w.box.textContent,/需管理员/,'给出管理员补列的可操作指引');
  assert.equal(queue.length,0,'未入队任何命令（也不入队容器启用命令，禁止半写链）');
});

test('A-8 入口闸门读取类判定不受影响：缺列时已标注格子照常报「已是本容器的容器子位」（展示口径）',async()=>{
  const {document:d,state,queue}=setup();
  seed(state);
  state.locations[0].role='容器子位';state.locations[0].parentContainer='C-1';
  state.__itmSchemaColumns={locations:[...COLS_NO_SUBLOC]};
  const w=openWizard(d);
  w.ctn.value='C-1';w.loc.value='B-1';
  w.btn().click();await tick();
  assert.match(w.box.textContent,/已是本容器的「容器子位」/,
    '本地已有的子位标注数据照常识别展示，只有新写入被拦');
  assert.equal(queue.length,0);
});

test('A-8 负向对照：列齐全 → 闸门放行照常入队（不误伤）；列清单未知（从未全量同步）→ fail-open 放行',async()=>{
  const full=setup(),unknown=setup();
  seed(full.state);seed(unknown.state);
  full.state.__itmSchemaColumns={locations:[...COLS_FULL]};
  /* 列齐全：放行（回归——闸门不得拦住正常路径） */
  const w1=openWizard(full.document);
  w1.ctn.value='C-1';w1.loc.value='B-1';
  w1.btn().click();await tick();
  const sub=full.queue.find(r=>r.kind==='activateLocation');
  assert.ok(sub,'列齐全时正常入队子位标注');
  assert.equal(sub.role,'容器子位');
  assert.equal(sub.parentContainer,'C-1');
  /* 列清单未知：fail-open 放行入队，由服务端 upsert 白名单兜底 */
  const w2=openWizard(unknown.document);
  w2.ctn.value='C-1';w2.loc.value='B-1';
  w2.btn().click();await tick();
  assert.ok(unknown.queue.find(r=>r.kind==='activateLocation'),
    '未知列清单不拦（不知道 ≠ 假装知道），放行入队');
});
