'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../.dev-lines/gpt6');
const {parseHTML}=require(require.resolve('linkedom',{paths:[root]}));const UI=require(root+'/lib/item-ui');
const fixture=require('./fixture.json');
test('GPT UI: rejected video.play releases acquired camera stream',async()=>{
 const {document}=parseHTML(fs.readFileSync(root+'/index.html','utf8'));let stopped=0,n=0;
 const stream={getTracks:()=>[{stop(){stopped++;}}]};
 const page=UI.mount({document,getState:()=>structuredClone(fixture),getPersistence:()=>null,getCommands:async()=>[],id:()=>String(++n),mediaDevices:{async getUserMedia(){return stream;}}});
 document.getElementById('itmVideo').play=async()=>{throw Error('injected video playback rejection');};
 try{document.getElementById('itmCamera').click();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.equal(stopped,1,'camera track remained active after video.play rejected');}
 finally{page.stopCamera();}
});
