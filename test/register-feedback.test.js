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


/* ================= 阶段B-补：容器建档「类型下拉 + 规格填空」 =================
   回归两个真实缺陷：
   ① TDZ：spec/ctnType 的 const 声明原先在函数体后段，而容器/库位分支会提前 return，
      一点「申请容器建档」就抛 "Cannot access 'ctnType' before initialization"，
      建档完全无法提交（用户实测）。这里必须真的走到 enqueue 才算修好。
   ② 字段归属：type 必须来自下拉（飞书 SELECT 列只收固定值），spec 才是自由填空。
      此前只有一个「规格/说明」框，用户把类型名填进规格 → 飞书 type 列永远为空。 */
function fillContainer(d, { type = '开放式收纳格', spec = '32×25×6cm', code = 'KF-005' } = {}) {
  pick(d, 'itmRegisterType', 'registerContainer');
  if (type) pick(d, 'itmRegisterCtnType', type);
  d.getElementById('itmRegisterSpec').value = spec;
  d.getElementById('itmRegisterCode').value = code;
}

test('容器建档：填类型+规格+编码可正常入队（TDZ 回归）', async () => {
  let queued = null;
  const { document: d } = setup({ enqueued: r => { queued = r; } });
  fillContainer(d);
  d.getElementById('itmRegister').click(); await tick();
  assert.ok(queued, '容器建档必须成功入队（此前 TDZ 直接抛错，根本提交不了）');
  assert.equal(queued.kind, 'registerContainer');
  assert.equal(queued.entity.code, 'KF-005');
  assert.equal(queued.entity.type, '开放式收纳格', 'type 必须来自容器类型下拉（飞书 SELECT 列只收固定值）');
  assert.equal(queued.entity.spec, '32×25×6cm', 'spec 是自由填空');
  assert.ok(!('desc' in queued.entity), '容器不走 desc（那是库位字段）');
  assert.ok(!('name' in queued.entity), '容器没有 name 字段，不该塞进去');
  assert.doesNotMatch(d.getElementById('itmRegisterResult').textContent, /before initialization|查询失败/);
});

test('容器建档：未选容器类型必须被拦住并说清原因', async () => {
  let queued = null;
  const { document: d } = setup({ enqueued: r => { queued = r; } });
  fillContainer(d, { type: '' });
  d.getElementById('itmRegister').click(); await tick();
  assert.equal(queued, null, '没选类型不许入队');
  assert.match(d.getElementById('itmRegisterResult').textContent, /请选择容器类型/, '要说明是容器类型没选');
  assert.match(d.getElementById('itmRegisterResult').textContent, /容器类型.*列|飞书/, '要说明对应飞书「容器类型」列');
});

test('容器建档：类型下拉的 6 个值必须与容器码批量生成同一套', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const opts = ['A4四抽收纳盒', '三连格文件盒', '斜口零件盒', '6040周转箱', '四层四格牛皮纸收纳盒', '开放式收纳格'];
  opts.forEach(v => assert.ok(html.includes('value="' + v + '"'), '容器类型下拉缺少「' + v + '」'));
  const gen = html.slice(html.indexOf('id="gCtnType"'), html.indexOf('id="gCtnFrom"'));
  opts.forEach(v => assert.ok(gen.includes(v), '批量生成的类型表缺少「' + v + '」——两处会漂移'));
});

test('库位建档仍走 desc，不受容器改造影响', async () => {
  let queued = null;
  const { document: d } = setup({ enqueued: r => { queued = r; } });
  pick(d, 'itmRegisterType', 'registerLocation');
  d.getElementById('itmRegisterName').value = 'B区角钢货架';
  d.getElementById('itmRegisterCode').value = 'L-A';
  d.getElementById('itmRegister').click(); await tick();
  assert.ok(queued, '库位建档必须成功入队');
  assert.equal(queued.kind, 'registerLocation');
  assert.equal(queued.entity.desc, 'B区角钢货架', '库位走 desc');
  assert.ok(!('type' in queued.entity) && !('spec' in queued.entity), '库位不该带容器字段');
});
