'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Client=require('../lib/item-client');
const command={id:'same-op',op:'itemOperation',request:{opId:'same-op',kind:'issue'}};
test('client timeout aborts and durably marks same command unknown, never rotates ID',async()=>{let marked,signal;const c=Client.create({timeoutMs:5,pollTries:2,pollGapMs:1,persistence:{async markUnknown(id){marked=id;}},fetch:async(url,o)=>{signal=o.signal;if(String(url).includes('GET')||o.method==='GET')return new Promise(()=>{});return new Promise(()=>{});}});await assert.rejects(c.submit(command),/超时/);assert.equal(marked,'same-op');assert.equal(signal.aborted,true);assert.equal(command.request.opId,'same-op');});
test('ACK IDB failure plus unknown-marker failure reports both and never success',async()=>{const c=Client.create({persistence:{async acknowledge(){throw Error('ACK disk failure');},async markUnknown(){throw Error('unknown disk failure');}},fetch:async()=>({ok:true,json:async()=>({ok:true,operation:{phase:'APPLIED'}})})});await assert.rejects(c.submit(command),/ACK disk failure.*unknown disk failure/);});
test('body parsing timeout is bounded even if injected response ignores abort',async()=>{let marked;const c=Client.create({timeoutMs:5,pollTries:2,pollGapMs:1,persistence:{async markUnknown(id){marked=id;}},fetch:async()=>({ok:true,json:()=>new Promise(()=>{})})});await assert.rejects(c.submit(command),/超时/);assert.equal(marked,'same-op');});
test('client query uses original ID and acknowledges only terminal response',async()=>{let url,ack;const c=Client.create({persistence:{async acknowledge(o){ack=o;}},fetch:async u=>{url=u;return {ok:true,json:async()=>({ok:true,operation:{code:'same-op',phase:'APPLIED'}})};}});await c.query(command);assert.match(url,/opId=same-op/);assert.equal(ack.code,'same-op');});

/* ================= F1（v3.2.4）：版本类拒绝拆壳 + 保留错误码（用户实测死循环根因） ================= */
test('F1 版本类拒绝：直接返回 operation（不包壳）+ lastError 保留原始错误码供重建按钮匹配',async()=>{
 let marked;const c=Client.create({persistence:{async acknowledge(){throw Error('版本类拒绝不得走 acknowledge 清卡');},async markUnknown(id,msg){marked=msg;}},
  fetch:async()=>({ok:true,json:async()=>({ok:true,operation:{code:'op-1',phase:'REJECTED',error:'TRIAL_CONCURRENT_OPERATION_DETECTED',retryPolicy:{newOpIdRequired:true}}})})});
 const r=await c.submit(command);
 assert.equal(r.phase,'REJECTED','拆壳：调用方拿得到 result.phase（旧壳 {operation:…} 让 phase 判空 → 伪装成「结果待确认」）');
 assert.equal(r.retryable,true);
 assert.match(String(marked),/TRIAL_CONCURRENT_OPERATION_DETECTED/,'原始错误码必须保留（待处理卡重建按钮靠 lastError 正则触发）');
 assert.doesNotMatch(String(marked),/另一台设备|先确认的命令已生效/,'不得编造并发叙事');
});
test('F1 非版本类拒绝照旧 acknowledge 清卡并原样返回',async()=>{
 let ack,marked=null;const c=Client.create({persistence:{async acknowledge(o){ack=o;},async markUnknown(id,msg){marked=msg;}},
  fetch:async()=>({ok:true,json:async()=>({ok:true,operation:{code:'op-2',phase:'REJECTED',error:'STATE_CONFLICT'}})})});
 const r=await c.submit({id:'op-2',op:'itemOperation',request:{opId:'op-2',kind:'issue'}});
 assert.equal(r.phase,'REJECTED');assert.equal(ack.code,'op-2');assert.equal(marked,null,'非版本类拒绝卡自动清除');
});

/* ================= S5（v3.3.0）：提交超时自动查询直至终态 ================= */
test('S5 提交超时后轮询原 opId 拿到 APPLIED → 照常入账，不落需人工核验卡',async()=>{
 let ack=null,marked=null,posts=0,gets=0;
 const c=Client.create({timeoutMs:5,pollTries:5,pollGapMs:1,
  persistence:{async acknowledge(o){ack=o;},async markUnknown(id,msg){marked=msg;}},
  fetch:async(url,o)=>{
   if(o.method==='POST'){posts++;return new Promise(()=>{});}          // 提交永远不返回（模拟 45s 超时）
   gets++;return {ok:true,json:async()=>({ok:true,operation:{code:'same-op',phase:'APPLIED',kind:'issue'}})};  // 轮询立刻拿到终态
  }});
 const r=await c.submit(command);
 assert.equal(r.phase,'APPLIED');assert.equal(posts,1,'只提交一次，绝不重复提交');
 assert.ok(gets>=1,'超时后自动查询了原 opId');
 assert.equal(ack&&ack.code,'same-op','终态照常入账');
 assert.equal(marked,null,'不落需人工核验卡');
});
test('S5 轮询超界仍非终态 → 如实落卡（含指引），绝不重复提交',async()=>{
 let marked=null,posts=0,gets=0;
 const c=Client.create({timeoutMs:5,pollTries:3,pollGapMs:1,
  persistence:{async markUnknown(id,msg){marked=msg;}},
  fetch:async(url,o)=>{
   if(o.method==='POST'){posts++;return new Promise(()=>{});}
   gets++;return {ok:true,json:async()=>({ok:true,operation:{code:'same-op',phase:'REPAIR_REQUIRED',error:'原命令未决，不能自动重发'}})};
  }});
 await assert.rejects(c.submit(command),/超时/);
 assert.equal(posts,1,'全程只有一次 POST');
 assert.ok(gets>=3,'轮询了原 opId');
 assert.match(String(marked),/查询并确认原命令/);
});
test('S5 轮询拿到版本类 REJECTED → 保留错误码落卡并返回可重建 operation',async()=>{
 let marked=null;
 const c=Client.create({timeoutMs:5,pollTries:3,pollGapMs:1,
  persistence:{async acknowledge(){throw Error('版本类拒绝不得清卡');},async markUnknown(id,msg){marked=msg;}},
  fetch:async(url,o)=>{
   if(o.method==='POST')return new Promise(()=>{});
   return {ok:true,json:async()=>({ok:true,operation:{code:'same-op',phase:'REJECTED',error:'TRIAL_PRECONDITION_CHANGED: 版本过期'}})};
  }});
 const r=await c.submit(command);
 assert.equal(r.phase,'REJECTED');assert.equal(r.retryable,true);
 assert.match(String(marked),/TRIAL_PRECONDITION_CHANGED/);
});
