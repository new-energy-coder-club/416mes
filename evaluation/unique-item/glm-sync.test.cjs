'use strict';const test=require('node:test'),assert=require('node:assert/strict');const D=require('../../.dev-lines/glm53/lib/item-ops');
const base={code:'I-A',status:'in_stock',container:'C-A',version:3,lastOpId:'confirmed'};
test('GLM merge: unchanged local does not permit structurally invalid remote group',()=>{const r=D.mergeControlledGroup('items',base,{...base},{...base,status:'out',container:'C-A'});assert.notEqual(r.action,'take-remote');});
test('GLM merge: unchanged local does not permit same-version external container edit',()=>{const r=D.mergeControlledGroup('items',base,{...base},{...base,container:'C-B'});assert.equal(r.action,'conflict');});
test('GLM merge: absent controlled columns cannot become empty authoritative group',()=>{const r=D.mergeControlledGroup('items',base,{...base},{code:'I-A',name:'rename'});assert.notEqual(r.action,'take-remote');});
