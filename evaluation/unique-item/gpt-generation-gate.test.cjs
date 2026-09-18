'use strict';const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../../.dev-lines/gpt6/index.html','utf8');const start=html.indexOf('function blockLegacyUniqueLabels()');const src=html.slice(start,html.indexOf('/* ================= ③',start));
function run(state){let alerts=0;const c=vm.createContext({state,alert:()=>alerts++,goTab:()=>{}});vm.runInContext(src,c);return{blocked:c.blockLegacyUniqueLabels(),alerts};}
test('S5.1 legacy mode stays available without actual controlled schema',()=>{assert.equal(run({items:[{code:'old',status:'unknown',version:0}],locations:[],containers:[]}).blocked,false);});
test('S5.1 actual controlled columns block legacy generation even with empty tables',()=>{const r=run({__itmSchemaColumns:{items:['物品码','状态']},items:[],locations:[],containers:[]});assert.equal(r.blocked,true);assert.equal(r.alerts,1);});
test('S5.1 prior confirmed operations keep generation guarded after config disappears',()=>{assert.equal(run({items:[{code:'I',version:2,lastOpId:'prior'}]}).blocked,true);});
