'use strict';
// Capture candidate identity before/after isolated targeted tests; no shell interpolation.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const workspace=path.resolve(__dirname,'../..');
const presets={
 gpt:{root:'.dev-lines/gpt6', files:['lib/unique-items.js','lib/item-schema.js','lib/item-persistence.js'], tests:['gpt-domain.test.cjs','gpt-schema.test.cjs','gpt-persistence.test.cjs']},
 glm:{root:'.dev-lines/glm53',files:['lib/item-ops.js'],tests:['glm-domain.test.cjs']},
 kimi:{root:'.dev-lines/kimik3',files:['lib/itm-core.js'],tests:['kimi-domain.test.cjs']}
};
const key=process.argv[2],preset=presets[key];
if(!preset){console.error('Usage: node run-probes.cjs glm|kimi|gpt');process.exit(2);}
const root=path.join(workspace,preset.root);
function snapshot(){return{head:cp.execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),files:Object.fromEntries(preset.files.map(f=>{const p=path.join(root,f);return[f,fs.existsSync(p)?crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null];}))};}
const before=snapshot();
const result=cp.spawnSync(process.execPath,['--test',...preset.tests.map(f=>path.join(__dirname,f))],{cwd:workspace,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
const after=snapshot();
const stable=JSON.stringify(before)===JSON.stringify(after);
const report={candidate:key,observedAt:new Date().toISOString(),scope:'targeted-domain-schema-persistence-not-full-acceptance',before,after,stable,exitCode:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr};
console.log(JSON.stringify(report,null,2));
if(!stable){console.error('Candidate changed during test: do not attribute this result to one revision.');process.exitCode=3;}
else process.exitCode=result.status===0?0:1;
