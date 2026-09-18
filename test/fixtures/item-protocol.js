'use strict';
// Isolated protocol fixture ONLY. Not exported or configured by production handlers.
function coordinatorFixture(durable={commands:new Map(),owner:null}){
 return {contract:'durable-global-barrier-v1',verified:true,
 async claim(c){const existing=durable.commands.get(c.opId);if(existing)return {existing:true,conflict:existing.requestHash!==c.requestHash};if(durable.owner)return {acquired:false};durable.owner=c.opId;durable.commands.set(c.opId,structuredClone(c));return {acquired:true};},
 async get(id){const x=durable.commands.get(id);return x&&structuredClone(x);},
 async prepare(id,operation){durable.commands.get(id).operation=structuredClone(operation);},
 async progress(id,p){durable.commands.get(id).progress=p;},
 async uncertain(id,error){durable.commands.get(id).error=error;durable.commands.get(id).recovering=false;},
 async claimRecovery(id){const x=durable.commands.get(id);if(durable.owner!==id||x.recovering)return false;x.recovering=true;return true;},
 async finish(id,result){durable.commands.get(id).result=structuredClone(result);durable.owner=null;}
 };
}
function repositoryFixture(){const state={locations:[{code:'L',status:'active'}],containers:[{code:'C',loc:'L',status:'active',version:2}],items:[{code:'I',status:'in_stock',container:'C',version:3,lastOpId:'prior'}]},logs=[];let writes=0;const faults={};return {state,logs,faults,get writes(){return writes;},async validateSchema(){if(faults.schema)throw Error('missing-column');},async operations(id){return logs.filter(o=>o.code===id);},async snapshot(){return structuredClone(state);},async prepare(o){if(faults.prepare)throw Error('log timeout');logs.push({...structuredClone(o),recordId:'rec-1'});return 'rec-1';},async apply(after){writes++;if(faults.apply)throw Error('write timeout');for(const [t,rows]of Object.entries(after))for(const r of rows)Object.assign(state[t].find(x=>x.code===r.code),r);},async readAfter(after){return Object.fromEntries(Object.entries(after).map(([t,rows])=>[t,rows.map(r=>Object.fromEntries(Object.keys(r).map(k=>[k,state[t].find(x=>x.code===r.code)[k]])))]));},async finish(id,o){if(faults.finish)throw Error('finish timeout');Object.assign(logs.find(l=>l.recordId===id),o);}};}
module.exports={coordinatorFixture,repositoryFixture};
