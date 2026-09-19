'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Scan=require('../lib/item-scan');
function setup(){let n=0;const state={locations:[{code:'L-A',status:'active'},{code:'L-B',status:'active'}],containers:[{code:'C-A',status:'active',loc:'L-A',version:2},{code:'C-B',status:'active',loc:'L-B',version:5}],items:[{code:'I-P',status:'pending',version:0},{code:'I-A',status:'in_stock',container:'C-A',version:3}]};return {state,scan:Scan.create({getState:()=>state,id:()=>String(++n)})};}
test('strict LOC CTN ITM order, wrong relation, repeat frames and qty=1',()=>{const {scan}=setup();scan.add('receive');assert.throws(()=>scan.accept('ITM:I-P'),/LOC/);assert.throws(()=>scan.accept('L-A'),/前缀/);scan.accept('LOC:L-A');assert.deepEqual(scan.accept('LOC:L-A'),{duplicate:true});assert.throws(()=>scan.accept('CTN:C-B'),/归属/);scan.accept('CTN:C-A');scan.accept('ITM:I-P');assert.equal(scan.request().itemCode,'I-P');assert.equal(scan.request().qty,undefined);assert.equal(scan.request().opId,scan.lock().opId);assert.throws(()=>scan.accept('ITM:I-A'),/锁定/);});
test('late camera token cannot fill switched row or reset generation',()=>{const {scan}=setup();scan.add('receive');const token=scan.token();scan.add('issue');assert.equal(scan.accept('LOC:L-A',token).ignored,true);assert.equal(scan.row().values.length,0);const token2=scan.token();scan.reset();assert.equal(scan.accept('LOC:L-A',token2).ignored,true);});
test('batch duplicate is rejected and upstream reset clears descendants',()=>{const {scan}=setup();scan.add('receive');['LOC:L-A','CTN:C-A','ITM:I-P'].forEach(x=>scan.accept(x));scan.add('receive');scan.accept('LOC:L-A');scan.accept('CTN:C-A');assert.throws(()=>scan.accept('ITM:I-P'),/批次/);scan.reset(0);assert.equal(scan.row().values.length,0);});
test('failed unpersisted intention can retry same ID but rescan allocates new ID',()=>{const {scan}=setup();scan.add('receive');['LOC:L-A','CTN:C-A','ITM:I-P'].forEach(x=>scan.accept(x));const original=scan.lock();scan.unlock();assert.equal(scan.request().opId,original.opId);scan.reset();['LOC:L-B','CTN:C-B','ITM:I-P'].forEach(x=>scan.accept(x));assert.notEqual(scan.lock().opId,original.opId);assert.throws(()=>scan.reset(),/锁定/);});
test('bare WP item barcode accepted only at ITM step, EAN never inferred',()=>{const {scan,state}=setup();state.items.push({code:'WP-001',status:'pending',version:0});scan.add('receive');assert.throws(()=>scan.accept('WP-001'),/前缀/);scan.accept('LOC:L-A');scan.accept('CTN:C-A');assert.throws(()=>scan.accept('6901234567890'),/前缀/);scan.accept('WP-001');assert.equal(scan.request().itemCode,'WP-001');});
test('conflict arriving after scans blocks confirmation for every related entity',()=>{for(const key of ['locations:L-A','containers:C-A','items:I-P']){const {scan,state}=setup();scan.add('receive');['LOC:L-A','CTN:C-A','ITM:I-P'].forEach(x=>scan.accept(x));state.__itmConflicts={[key]:{reason:'external-edit'}};assert.throws(()=>scan.lock(),e=>e.code==='UNRESOLVED_ENTITY_CONFLICT');assert.equal(scan.row().locked,false);}});
test('issue validates source and new receive rejects already in stock',()=>{const {scan}=setup();scan.add('issue');scan.accept('LOC:L-B');scan.accept('CTN:C-B');assert.throws(()=>scan.accept('ITM:I-A'),/来源/);scan.add('receive');scan.accept('LOC:L-A');scan.accept('CTN:C-A');assert.throws(()=>scan.accept('ITM:I-A'),/重复入库/);});
test('scan: 短链二维码在ITM步骤解析为物品码（离线本地解码）',()=>{
 const L=require('../lib/item-link');
 const s=Scan.create({getState:()=>({locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'WP-001',status:'pending',version:1}]}),id:()=> 't'+Math.random()});
 s.add('receive');s.accept('LOC:L-A');s.accept('CTN:C-A');
 const link=L.linkFor('WP-001');
 const r=s.accept(link);
 assert.equal(r.complete,true);
 assert.equal(s.row().values[2].code,'WP-001');
});
test('scan: 短链错步骤仍被拒（库位步骤扫物品短链）',()=>{
 const L=require('../lib/item-link');
 const s=Scan.create({getState:()=>({locations:[],containers:[],items:[]}),id:()=> 't'});
 s.add('receive');
 assert.throws(()=>s.accept(L.linkFor('WP-001')),/当前请扫描/);
});
