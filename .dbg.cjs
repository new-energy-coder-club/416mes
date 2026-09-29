const fs=require('fs');
const {parseHTML}=require('linkedom');
const UI=require('/srv/416mes/lib/item-ui.js');
const html=fs.readFileSync('/srv/416mes/index.html','utf8');
const {document}=parseHTML(html);
const state={locations:[{code:'B-01-01-01',status:'active',kind:'货架库位',desc:'x'}],containers:[],items:[],itemOperations:[]};
const queue=[];const submitted=[];let n=0;
const persistence={async enqueue(r){queue.push(r);},async saveDraft(){},async recover(){return{drafts:[],commands:[]}}};
const client={async submit(cmd){submitted.push(cmd.request.kind);return {phase:'APPLIED',request:cmd.request};}};
const page=UI.mount({document,getState:()=>state,getPersistence:()=>persistence,
  getCommands:async()=>queue.map(r=>({id:r.opId,request:r})),id:()=>'fb-'+(++n),
  getClient:()=>client,isOnline:()=>true});
const d=document;
const pick=(id,val)=>{const sel=d.getElementById(id);for(const o of sel.options){if(o.value===val)o.setAttribute('selected','');else o.removeAttribute('selected');}sel.dispatchEvent(new d.defaultView.Event('change',{bubbles:true}));};
pick('itmRegisterType','registerContainer');
pick('itmRegisterCtnType','开放式收纳格');
d.getElementById('itmRegisterCode').value='KF-777';
d.getElementById('itmRegisterCtnLoc').value='B-01-01-01';
d.getElementById('itmRegister').click();
(async()=>{for(let i=0;i<24;i++)await new Promise(r=>setImmediate(r));
console.log('SUBMITTED:',JSON.stringify(submitted));
console.log('QUEUE:',JSON.stringify(queue.map(r=>r.kind)));
console.log('RESULT:',d.getElementById('itmRegisterResult').textContent.slice(0,220));
})();
