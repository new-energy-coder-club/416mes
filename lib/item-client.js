(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ItemClient=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function create({persistence,fetch:fetcher,timeoutMs=15000}){
 async function call(command,method){
  if(!command||command.op!=='itemOperation')throw Error('不是ITM命令');
  const url='/api/feishu/item-operation'+(method==='GET'?'?opId='+encodeURIComponent(command.id):'');
  const controller=new AbortController();let timer;
  try{
   const operationPromise=(async()=>{const response=await fetcher(url,{signal:controller.signal,method,credentials:'same-origin',headers:{'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(command.request)}:{})});return {response,data:await response.json()};})();
   const {response,data}=await Promise.race([operationPromise,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('请求超时，结果未知，请查询原opId'));},timeoutMs);})]);if(!response.ok||!data.ok)throw Error(data.error||'操作接口拒绝');
   const operation=data.operation;
   if(operation&&['APPLIED','REJECTED'].includes(operation.phase)){await persistence.acknowledge(operation);return operation;}
   await persistence.markUnknown(command.id,operation&&operation.error||'结果待确认');return operation;
  }catch(e){try{await persistence.markUnknown(command.id,e.message);}catch(storageError){e.message+='；本机未知状态保存失败：'+storageError.message+'，原命令未清除';}throw e;}finally{clearTimeout(timer);}
 }
 return {submit:c=>call(c,'POST'),query:c=>call(c,'GET')};
}
return {create};
});
