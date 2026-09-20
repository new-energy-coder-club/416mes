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
    /* 2.62.0 Phase C（并发短期）：屏障类拒绝（另一台设备在处理）不终结命令——
       opId 已随日志行烧掉，acknowledge 会删卡让用户失去重试入口。
       标记 needs_attention + retryable，由作业页提供「排队重试」（换新 opId 重建）。 */
    const errTxt=String((operation&&operation.error)||'');
    if(operation.phase==='REJECTED'&&/TRIAL_CONCURRENT_OPERATION_DETECTED|UNRESOLVED_OPERATION_BARRIER/.test(errTxt)){
      await persistence.markUnknown(command.id,'另一台设备正在处理，本命令已自动排队（点重试换新号提交）');
      return {operation:{...operation,retryable:true}};
    }
    await persistence.acknowledge(operation);return operation;
   }
   await persistence.markUnknown(command.id,operation&&operation.error||'结果待确认');return operation;
  }catch(e){if(readOnly)throw e;try{await persistence.markUnknown(command.id,e.message);}catch(storageError){e.message+='；本机未知状态保存失败：'+storageError.message+'，原命令未清除';}throw e;}finally{clearTimeout(timer);}
 }
 return {submit:c=>call(c,'POST'),query:c=>call(c,'GET'),inspect:opId=>call({id:opId,op:'itemOperation'},'GET',true)};
}
return {create};
});
