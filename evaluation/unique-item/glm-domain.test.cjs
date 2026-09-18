'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fixture=require('./fixture.json');
const domain=require('../../.dev-lines/glm53/lib/item-ops.js');
test('GLM domain: duplicate ITM must not silently return first record',()=>{
 const s=structuredClone(fixture);s.items.push({...s.items[1],container:'C-B'});
 let r;try{r=domain.resolveItem(s,'I-A');}catch{return;}
 assert.ok(!r.found || r.conflict || r.duplicate || r.error,'ambiguous item resolved as normal');
});
test('GLM domain: out item with stale container cannot appear currently located',()=>{
 const s=structuredClone(fixture);s.items.find(x=>x.code==='I-O').container='C-A';
 const r=domain.resolveItem(s,'I-O');
 assert.ok(!r.derivedLoc || r.relation!=='normal','out item has normal current location');
});
test('GLM domain: duplicate container must not resolve as unambiguous normal',()=>{
 const s=structuredClone(fixture);s.containers.push({...s.containers[0],loc:'L-B'});
 let r;try{r=domain.resolveItem(s,'I-A');}catch{return;}
 assert.ok(!r.found || r.conflict || r.duplicate || r.error || r.relation!=='normal','ambiguous container resolved as normal');
});
