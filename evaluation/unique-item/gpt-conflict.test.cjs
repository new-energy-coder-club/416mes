'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const U=require('../../.dev-lines/gpt6/lib/unique-items');const fixture=require('./fixture.json');
test('GPT conflict: unresolved entity relation conflict blocks new issue plan',()=>{
 const s=structuredClone(fixture);s.__itmConflicts={'items:I-A':{reason:'external controlled edit',observed:{container:'C-B'}}};
 assert.throws(()=>U.plan(s,{schemaVersion:1,opId:'conflict-probe',kind:'issue',itemCode:'I-A',source:{loc:'L-A',container:'C-A'},expected:{itemVersion:3,containerVersion:2}},{id:'tester',roles:['operator']}));
});
