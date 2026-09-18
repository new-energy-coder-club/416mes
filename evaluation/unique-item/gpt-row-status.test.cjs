'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../.dev-lines/gpt6');const {parseHTML}=require(require.resolve('linkedom',{paths:[root]}));const UI=require(root+'/lib/item-ui');const fixture=require('./fixture.json');
test('GPT UI: confirmed row shows completion rather than permanent pending',async()=>{
 const {document}=parseHTML(fs.readFileSync(root+'/index.html','utf8'));let n=0;const state=structuredClone(fixture);
 const page=UI.mount({document,getState:()=>state,getPersistence:()=>null,getCommands:async()=>[],id:()=>String(++n)});
 for(const s of ['LOC:L-A','CTN:C-A','ITM:I-P'])await page.accept(s);
 const request=page.scan.lock();state.itemOperations=[{code:request.opId,phase:'APPLIED',kind:'receive',request}];page.render();
 const text=document.getElementById('itmRowTable').textContent;
 assert.match(text,/完成|已确认|APPLIED|已入库/);assert.doesNotMatch(text,/待提交\/待确认/);
});
