'use strict';
/* 建档反馈就近（修「点了没反应」）：建档区的所有结果/错误都必须落在建档区自己的
   #itmRegisterResult 里，不能只写到远处的作业状态行 #itmStatus。 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom'),UI=require('../lib/item-ui');

function setup(opts={}){
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const {document}=parseHTML(html);
  let n=0,enq=null;
  const state={locations:[],containers:[],items:[],itemOperations:[]};
  const persistence=opts.persistence||{async enqueue(r){enq=r;opts.enqueued&&opts.enqueued(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
  const page=UI.mount({document,getState:()=>state,getPersistence:()=>persistence,
    getCommands:async()=>opts.commands||(enq?[{id:enq.opId,request:enq}]:[]),id:()=>'fb-'+(++n),
    getClient:opts.client?()=>opts.client:undefined,isOnline:()=>opts.online!==false});
  return {document,state,page};
}
const tick=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
function pick(d,id,val){const sel=d.getElementById(id);for(const o of sel.options){if(o.value===val)o.setAttribute('selected','');else o.removeAttribute('selected');}sel.dispatchEvent(new d.defaultView.Event('change'));}
function fill(d,{cat='TS',name='遥控器'}={}){
  pick(d,'itmRegisterType','registerItem');
  pick(d,'itmRegisterCat',cat);
  d.getElementById('itmRegisterName').value=name;
}

test('建档校验失败（未选分类/未填名称）→ 提示落在建档区结果框，不折腾作业状态行',async()=>{
  const {document:d}=setup();
  const workStatus=d.getElementById('itmStatus').textContent;
  fill(d,{cat:'',name:''});
  d.getElementById('itmRegister').click();await tick();
  const box=d.getElementById('itmRegisterResult').textContent;
  assert.match(box,/请先选择物品分类/,'错误必须出现在建档区结果框');
  assert.equal(d.getElementById('itmStatus').textContent,workStatus,'作业状态行不被建档错误占用');
});

test('建档提交失败（如飞书表重复记录）→ 建档区显示中文可操作指引',async()=>{
  const client={async submit(){throw Error('DUPLICATE_ENTITY:itemOperations');}};
  const {document:d}=setup({client});
  fill(d);
  d.getElementById('itmRegister').click();await tick();
  const box=d.getElementById('itmRegisterResult').textContent;
  assert.match(box,/重复记录/);assert.match(box,/飞书/,'要告诉用户去哪修');
  assert.doesNotMatch(box,/^\s*DUPLICATE_ENTITY/,'不能只晾英文错误码');
});

test('建档进行中再点 → 建档区提示「进行中」而不是静默吞掉',async()=>{
  let release;const gate=new Promise(r=>{release=r;});
  const client={async submit(){await gate;return {phase:'APPLIED',request:{entity:{code:'WP-TS-009'}}};}};
  const {document:d}=setup({client});
  fill(d);
  d.getElementById('itmRegister').click();await tick(2);   // 第一次点击：进入提交
  d.getElementById('itmRegister').click();await tick(2);   // 第二次点击：应看到进行中提示
  assert.match(d.getElementById('itmRegisterResult').textContent,/进行中/);
  release();await tick();
});

test('建档成功 → 结果框含物品码且完成语不覆盖二维码预览',async()=>{
  const client={async submit(){return {phase:'APPLIED',request:{entity:{code:'WP-TS-009'}}};}};
  const {document:d}=setup({client});
  fill(d);
  d.getElementById('itmRegister').click();await tick();
  const box=d.getElementById('itmRegisterResult');
  assert.match(box.textContent,/WP-TS-009/);
  assert.match(box.textContent,/建档完成/,'完成语追加在预览之后');
  assert.ok(box.querySelector('button'),'预览与「去入库」按钮仍在（完成语不得覆盖预览）');
});
