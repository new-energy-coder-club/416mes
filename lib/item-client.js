(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ItemClient=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function create({persistence,fetch:fetcher,timeoutMs=45000}){   // 试运行模式走飞书多次串行写，实测常超15s；超时仅表示结果未知，协议按原opId查询
 async function call(command,method,readOnly=false){
  if(!command||command.op!=='itemOperation')throw Error('不是ITM命令');
  const url='/api/feishu/item-operation'+(method==='GET'?'?opId='+encodeURIComponent(command.id):'');
  const controller=new AbortController();let timer;
  try{
   const operationPromise=(async()=>{const response=await fetcher(url,{signal:controller.signal,method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-416mes-Same-Origin':'1','X-416mes-Token':(function(){try{return localStorage.getItem('mes416_itm_token')||'';}catch(e){return '';}})()},...(method==='POST'?{body:JSON.stringify(command.request)}:{})});return {response,data:await response.json()};})();
   const {response,data}=await Promise.race([operationPromise,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('请求超时，结果未知，请查询原opId'));},timeoutMs);})]);if(!response.ok||!data.ok)throw Error(data.error||'操作接口拒绝');
   const operation=data.operation;
   if(readOnly)return operation;
   if(operation&&['APPLIED','REJECTED'].includes(operation.phase)){
    /* P2a（并发模型定稿）：版本类拒绝=本命令作废（先确认的生效），如实提示并保留重建入口——
       不再谎称「另一台设备正在处理」（单设备版本陈旧也会走到这里），也不再自动排队退避。 */
    const errTxt=String((operation&&operation.error)||'');
    if(operation.phase==='REJECTED'&&/TRIAL_CONCURRENT_OPERATION_DETECTED|VERSION_CONFLICT|TRIAL_PRECONDITION_CHANGED/.test(errTxt)){
      await persistence.markUnknown(command.id,'本命令作废：先确认的命令已生效。请重新扫码，或点「按最新数据重建并重新提交」');
      return {operation:{...operation,retryable:true}};
    }
    await persistence.acknowledge(operation);return operation;
   }
   await persistence.markUnknown(command.id,operation&&operation.error||'结果待确认');return operation;
  }catch(e){if(readOnly)throw e;try{await persistence.markUnknown(command.id,e.message);}catch(storageError){e.message+='；本机未知状态保存失败：'+storageError.message+'，原命令未清除';}throw e;}finally{clearTimeout(timer);}
 }
 /* P2c：管理员人工收口未决命令（settle 先回读核对实体实际状态：一致→APPLIED、不一致→REJECTED） */
 async function settle(opId){
  const url='/api/feishu/item-operation';
  const controller=new AbortController();let timer;
  try{
   const operationPromise=(async()=>{const response=await fetcher(url,{signal:controller.signal,method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-416mes-Same-Origin':'1','X-416mes-Token':(function(){try{return localStorage.getItem('mes416_itm_token')||'';}catch(e){return '';}})()},body:JSON.stringify({action:'settle',opId:String(opId||'')})});return {response,data:await response.json()};})();
   const {response,data}=await Promise.race([operationPromise,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('收口请求超时，请稍后重试'));},timeoutMs);})]);
   if(!response.ok||!data.ok)throw Error(data.error||'收口被拒绝');
   return data.operation;
  }finally{clearTimeout(timer);}
 }
 return {submit:c=>call(c,'POST'),query:c=>call(c,'GET'),inspect:opId=>call({id:opId,op:'itemOperation'},'GET',true),settle};
}
return {create};
});
