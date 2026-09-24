'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../lib/item-operation');
const {coordinatorFixture,repositoryFixture}=require('./fixtures/item-protocol');
const request=()=>({schemaVersion:1,opId:'op-1',kind:'issue',itemCode:'I',source:{loc:'L',container:'C'},expected:{itemVersion:3,containerVersion:2}});
function setup(){const durable={commands:new Map(),owner:null},repository=repositoryFixture();const service=()=>create({repository,coordinator:coordinatorFixture(durable),enabled:true,authenticate:async()=>({id:'server-user',roles:['operator','service']})});return {durable,repository,service};}
test('two handler instances share claim; duplicate opId produces one effect and query has none',async()=>{const f=setup(),a=f.service(),b=f.service();await Promise.all([a.post({},request()),b.post({},request())]);assert.equal(f.repository.writes,1);assert.equal((await b.get({},'op-1')).phase,'APPLIED');assert.equal(f.repository.state.items[0].container,'');assert.equal(f.repository.logs[0].operator,'server-user');await assert.rejects(b.post({},{...request(),reason:'changed'}),/PAYLOAD_CONFLICT/);});
test('different concurrent operations on same item allow one business effect',async()=>{const f=setup();await Promise.allSettled([f.service().post({},request()),f.service().post({},{...request(),opId:'op-2'})]);assert.equal(f.repository.writes,1);});
test('log creation timeout leaves persistent barrier across fresh instances',async()=>{const f=setup();f.repository.faults.prepare=true;const r=await f.service().post({},request());assert.equal(r.phase,'REPAIR_REQUIRED');assert.equal(f.repository.writes,0);await assert.rejects(f.service().post({},{...request(),opId:'other'}),/BARRIER/);assert.equal((await f.service().get({},'op-1')).phase,'REPAIR_REQUIRED');});
test('entity before after timeout is not proof original write ended; no retry apply',async()=>{const f=setup();f.repository.faults.apply=true;await f.service().post({},request());f.repository.faults.apply=false;const result=await f.service().recover({},'op-1');assert.equal(result.phase,'REPAIR_REQUIRED');assert.equal(f.repository.writes,1);assert.equal(f.durable.owner,'op-1');});
test('entity succeeded log finish failed: fresh recovery only finalizes log',async()=>{const f=setup();f.repository.faults.finish=true;await f.service().post({},request());f.repository.faults.finish=false;assert.equal((await f.service().recover({},'op-1')).phase,'APPLIED');assert.equal(f.repository.writes,1);assert.equal(f.durable.owner,null);});
test('missing coordination or auth fail before repository side effects',async()=>{const repository=repositoryFixture();const a=create({repository,enabled:true,authenticate:async()=>({id:'user',roles:['operator']})});await assert.rejects(a.post({},request()),/COORDINATION/);const b=create({repository,enabled:false,authenticate:async()=>null});await assert.rejects(b.post({},request()),/UNAUTHENTICATED/);assert.equal(repository.writes,0);});
test('operation visibility is owner/admin/service only and missing roles gets 403',async()=>{const f=setup();await f.service().post({},request());const as=actor=>create({repository:f.repository,coordinator:coordinatorFixture(f.durable),enabled:true,authenticate:async()=>actor});for(const actor of [{id:'stranger',roles:['operator']},{id:'server-user',roles:[]},{id:'server-user'}]){await assert.rejects(as(actor).get({},'op-1'),e=>e.status===403);}await assert.rejects(as({id:'stranger',roles:['operator']}).post({},request()),e=>e.status===403);await assert.rejects(as({id:'server-user'}).recover({},'op-1'),e=>e.status===403);assert.equal((await as({id:'admin',roles:['admin']}).get({},'op-1')).phase,'APPLIED');});
test('schema failure rejects without effect, unknown GET does not claim never executed',async()=>{const f=setup();f.repository.faults.schema=true;assert.equal((await f.service().post({},request())).phase,'REJECTED');assert.equal(f.repository.writes,0);assert.equal((await f.service().get({},'missing')).phase,'UNKNOWN');});

/* ================= A 阶段：服务端发号（定稿 §三） ================= */

function adminSetup(){
  const durable={commands:new Map(),owner:null},repository=repositoryFixture();
  const service=()=>create({repository,coordinator:coordinatorFixture(durable),enabled:true,authenticate:async()=>({id:'admin',roles:['admin']})});
  return {durable,repository,service};
}
const autoReq=(opId,entity)=>({schemaVersion:1,opId,kind:'registerItem',entity});

test('registerItem 不带码：服务端发号全链（分类→max+1→回填→APPLIED→短码可解）',async()=>{
  const f=adminSetup();
  const L=require('../lib/item-link');
  const r=await f.service().post({},autoReq('reg-1',{category:'TS',name:'示波器',spec:'100MHz'}));
  assert.equal(r.phase,'APPLIED',r.error);
  assert.equal(r.request.entity.code,'WP-TS-001','回填码进冻结请求');
  assert.equal(r.after.items[0].code,'WP-TS-001');
  assert.equal(r.after.items[0].name,'示波器');
  assert.equal(r.after.items[0].category,undefined,'category 不落物品表行（ordinaryFields 丢弃）');
  assert.equal(f.repository.state.items.some(i=>i.code==='WP-TS-001'),true);
  assert.equal(L.toItemCode(L.decode(L.fromItemCode('WP-TS-001'))),'WP-TS-001','发号即可短链往返');
  // 存量污染不影响序列：塞入 WP-uuid / WP-DEMO-001 / 小写码后取下一号
  f.repository.state.items.push({code:'WP-9f8d7c6b-aaaa-4bbb-8ccc-0123456789ab',status:'unknown',container:'',version:0,lastOpId:''});
  f.repository.state.items.push({code:'WP-DEMO-001',status:'unknown',container:'',version:0,lastOpId:''});
  f.repository.state.items.push({code:'wp-ts-007',status:'unknown',container:'',version:0,lastOpId:''});
  const r2=await f.service().post({},autoReq('reg-2',{category:'ts',name:'小写分类归一'}));
  assert.equal(r2.request.entity.code,'WP-TS-008','小写存码计入 TS 序列，uuid/DEMO 不计入');
  const r3=await f.service().post({},autoReq('reg-3',{category:'JG',name:'另一分类'}));
  assert.equal(r3.request.entity.code,'WP-JG-001','分类序列独立');
});

test('同 opId 重试不重发号（coordinator.get 幂等短路）',async()=>{
  const f=adminSetup(),s=f.service();
  const first=await s.post({},autoReq('reg-retry',{category:'TS',name:'x'}));
  assert.equal(first.phase,'APPLIED');
  const again=await f.service().post({},autoReq('reg-retry',{category:'TS',name:'x'}));
  assert.equal(again.phase,'APPLIED');
  assert.equal(again.request.entity.code,'WP-TS-001','重试返回原受理结果');
  assert.equal(f.repository.writes,1,'不重新发号不重复写入');
  assert.equal(f.repository.state.items.filter(i=>i.code==='WP-TS-001').length,1);
});

test('两 opId 并发撞号：陈旧快照取到同号，plan 查重拒 CODE_ALREADY_REGISTERED',async()=>{
  const f=adminSetup(),s=f.service();
  const stale=await f.repository.snapshot(); // 设备 B 在设备 A 落库前的快照
  await s.post({},autoReq('reg-a',{category:'TS',name:'先到者'})); // WP-TS-001 落库
  const orig=f.repository.snapshot.bind(f.repository);
  let calls=0;
  f.repository.snapshot=async()=>(++calls===1?structuredClone(stale):orig()); // 仅发号用旧快照，plan 用新快照
  const second=await f.service().post({},autoReq('reg-b',{category:'TS',name:'后到者'}));
  assert.equal(second.phase,'REJECTED');
  assert.match(second.error,/CODE_ALREADY_REGISTERED/);
  assert.equal(second.request.entity.code,'WP-TS-001','后到者确实撞了同一个号');
  assert.equal(f.repository.state.items.filter(i=>i.code==='WP-TS-001').length,1,'无重复写入');
  // 重新提交即取下一号
  const retry=await f.service().post({},autoReq('reg-b2',{category:'TS',name:'后到者'}));
  assert.equal(retry.phase,'APPLIED');
  assert.equal(retry.request.entity.code,'WP-TS-002');
});

test('发号前置校验：BAD_CATEGORY / NON_CANONICAL_ITEM_CODE / DUPLICATE_SHORTLINK_IDENTITY',async()=>{
  const f=adminSetup(),s=f.service();
  await assert.rejects(s.post({},autoReq('reg-bad1',{name:'无分类'})),e=>e.status===400&&/BAD_CATEGORY/.test(e.message));
  await assert.rejects(s.post({},autoReq('reg-bad2',{category:'XX',name:'假分类'})),e=>e.status===400&&/BAD_CATEGORY/.test(e.message));
  await assert.rejects(s.post({},autoReq('reg-bad3',{category:0,name:'未分类不开放'})),/BAD_CATEGORY/);
  await assert.rejects(s.post({},{schemaVersion:1,opId:'reg-bad4',kind:'registerItem'}),e=>e.status===400&&/INVALID_REQUEST/.test(e.message));
  // 手动码：非规范形拒收（WP-TS-7 与 WP-TS-007 短码相同但身份不同，P3）
  await assert.rejects(s.post({},autoReq('reg-m1',{code:'WP-TS-7',name:'非规范'})),e=>e.status===400&&/NON_CANONICAL_ITEM_CODE/.test(e.message));
  await assert.rejects(s.post({},autoReq('reg-m2',{code:'wp-ts-007',name:'小写非规范'})),/NON_CANONICAL_ITEM_CODE/);
  // 快照已有异写法同 (cat,serial)：规范形也拒 DUPLICATE_SHORTLINK_IDENTITY
  f.repository.state.items.push({code:'WP-TS-9',status:'unknown',container:'',version:0,lastOpId:''});
  await assert.rejects(s.post({},autoReq('reg-m3',{code:'WP-TS-009',name:'撞车'})),e=>e.status===409&&/DUPLICATE_SHORTLINK_IDENTITY/.test(e.message));
  // 规范形手动码正常建档；旧自由格式（无短链）放行
  const manual=await s.post({},autoReq('reg-m4',{code:'WP-TS-100',name:'沿用实物码'}));
  assert.equal(manual.phase,'APPLIED',manual.error);
  const legacy=await s.post({},autoReq('reg-m5',{code:'WP-legacy-bolt',name:'旧码'}));
  assert.equal(legacy.phase,'APPLIED',legacy.error);
  assert.equal(f.repository.writes,2,'校验失败的请求无任何写入');
});

test('发号发生在 claim 之前：SERIAL_EXHAUSTED 与校验失败不占 claim、不留日志',async()=>{
  const f=adminSetup(),s=f.service();
  f.repository.state.items.push({code:'WP-QT-2097151',status:'unknown',container:'',version:0,lastOpId:''});
  await assert.rejects(s.post({},autoReq('reg-full',{category:'QT',name:'满'})),e=>e.status===409&&/SERIAL_EXHAUSTED/.test(e.message));
  assert.equal((await f.repository.operations('reg-full')).length,0);
  assert.equal((await s.get({},'reg-full')).phase,'UNKNOWN','未 claim，重试可用同 opId');
});

/* ================= 2.49.5：trial 前置失败 → 终态 REJECTED，不再留未决行死锁队列（审计 Bug2） ================= */
test('trial concurrent-precheck: REPAIR_REQUIRED 屏障下同实体命令被拒或等待', async () => {
  const f = setup();
  const trial = { contract: 'feishu-trial-best-effort-v1', claim: async () => ({ acquired: true }), prepare: async () => {}, progress: async () => {}, finish: async () => {}, uncertain: async () => {}, get: async () => null };
  const service = () => create({ repository: f.repository, coordinator: trial, enabled: true, mode: 'feishu-trial', authenticate: async () => ({ id: 'u', roles: ['admin', 'operator'] }) });
  f.repository.faults.apply = true;
  const r1 = await service().post({}, request());
  f.repository.faults.apply = false;
  /* 2.66.0（实体分桶）：REPAIR_REQUIRED 是全局屏障 → 后续命令被拒或等待（不再静默 APPLIED） */
  const outcomes = [];
  for (let i = 0; i < 2; i++) {
    try { const r = await service().post({}, { ...request(), opId: 'op-r' + i }); outcomes.push(r.phase); }
    catch (e) { outcomes.push(e.message.slice(0, 40)); }
  }
  assert.ok(outcomes.some(p => p !== 'APPLIED'), 'REPAIR_REQUIRED 屏障下不应全部静默成功');
});

/* ================= v3.5.0：同 opId 重放遇超时未决行先自动收口（死锁根治） ================= */
test('v3.5.0：同 opId 重放遇超时 PREPARED 行先 sweep 收口再返回真实终态',async()=>{
  const f=setup();
  /* 真实制造一条未决行：写入超时 → prepare 已落日志（PREPARED）→ 实体未写入 */
  f.repository.faults.apply=true;
  const first=await f.service().post({},request());
  assert.equal(first.phase,'REPAIR_REQUIRED');
  f.repository.faults.apply=false;
  assert.equal(f.repository.logs[0].phase,'PREPARED');
  /* 把行龄拨到 11 分钟前（超过 STALE_PREPARED_MS） */
  f.repository.logs[0].requestedAt=new Date(Date.now()-11*60*1000).toISOString();
  /* 重放同 opId 同内容 → claim.existing → sweep → lookup 返回真实终态（旧实现恒 REPAIR_REQUIRED 死循环） */
  const r=await f.service().post({},request());
  assert.equal(f.repository.logs[0].phase,'REJECTED','超时未决行已被 sweep 收口（实体未写入 → 按作废处理）');
  assert.equal(r.phase,'REJECTED','重放拿到真实终态，不再是「原命令未决」');
});

/* ================= 3.7.0 C3（单端直提）：trial apply 异常同请求内回读定性，不再留 REPAIR_REQUIRED 给 sweep ================= */
const trialCoordinator=require('../lib/item-trial-coordinator');
function trialService(f,overrides={}){
  const trial={contract:'feishu-trial-best-effort-v1',claim:async()=>({acquired:true}),prepare:async()=>{},progress:async()=>{},finish:async()=>{},uncertain:async()=>{},get:async()=>null,...overrides};
  return create({repository:f.repository,coordinator:trial,enabled:true,mode:'feishu-trial',authenticate:async()=>({id:'u',roles:['admin','operator']})});
}
test('C3-① apply 抛错但写已落地（回读 after 匹配）→ APPLIED，行收终态',async()=>{
  const f=setup();
  /* 模拟「apply 实际已写、随后抛错（如 finish 前断连）」：先劫持 apply 让它写完再抛 */
  const realApply=f.repository.apply.bind(f.repository);
  f.repository.apply=async(after,operation)=>{await realApply(after,operation);throw Error('connection reset after write');};
  const r=await trialService(f).post({},request());
  assert.equal(r.phase,'APPLIED','写已落，回读定性为成功');
  assert.equal(f.repository.logs[0].phase,'APPLIED','日志行同步收终态，不留未决');
});
test('C3-② apply 抛错且写未落地（回读 before 匹配）→ REJECTED「未生效」，可直接重试',async()=>{
  const f=setup();
  f.repository.faults.apply=true;
  const r=await trialService(f).post({},request());
  assert.equal(r.phase,'REJECTED','未检出实际写入 → 未生效');
  assert.match(String(r.error||''),/未生效/,'用户文案：可重试而非天书');
  assert.equal(f.repository.logs[0].phase,'REJECTED','日志行同步收终态');
  assert.equal(f.repository.state.items[0].container,'C','实体未被写入（issue 未执行）');
});
test('C3-③ 回读失败/都不匹配 → REPAIR_REQUIRED（真未知兜底，语义与旧版一致）',async()=>{
  const f=setup();
  f.repository.faults.apply=true;
  const origRead=f.repository.readAfter.bind(f.repository);
  f.repository.readAfter=async after=>{await origRead(after);throw Error('readback down');};
  const r=await trialService(f).post({},request());
  assert.equal(r.phase,'REPAIR_REQUIRED','回读不可用 → 如实未知');
  assert.equal(f.repository.logs[0].phase,'REPAIR_REQUIRED');
});
test('C4 trial 模式三种 claim 返回形状（acquired/existing/conflict）均不触发 UNRESOLVED_OPERATION_BARRIER',async()=>{
  const f=setup();
  const coord=trialCoordinator.create(f.repository);   /* 真实 trial 协调器：claim 按 opId 查仓储 */
  const svc=()=>create({repository:f.repository,coordinator:coord,enabled:true,mode:'feishu-trial',authenticate:async()=>({id:'u',roles:['admin','operator']})});
  /* 新命令 → acquired；同 opId 重放 → existing（sweep+lookup）；同 opId 异载荷 → conflict（OP_ID_PAYLOAD_CONFLICT） */
  f.repository.faults.apply=true;
  const r1=await svc().post({},request());
  assert.equal(r1.phase,'REJECTED','acquired 形状：C3 回读定性，非屏障');
  f.repository.faults.apply=false;
  const r2=await svc().post({},request());
  assert.equal(r2.phase,'REJECTED','existing 重放拿到真实终态（C3 已收终态，sweep/lookup 直达）');
  await assert.rejects(svc().post({},{...request(),expected:{itemVersion:3,containerVersion:2,drifted:true}}),e=>/PAYLOAD_CONFLICT/.test(e.message),'异载荷走 OP_ID_PAYLOAD_CONFLICT');
  assert.ok(!String(r1.error||'').includes('BARRIER')&&!String(r2.error||'').includes('BARRIER'),'trial 全链路无一处触发 BARRIER');
});
