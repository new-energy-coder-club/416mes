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
    /* P2a+F1（v3.2.4，用户实测「单设备被谎称先确认的命令已生效」）：版本类拒绝如实落卡——
       ① 保留原始错误码（待处理卡「按最新数据重建并重新提交」按钮靠它匹配触发）；
       ② 直接返回 operation（不再包 {operation:…} 壳——壳曾让 guidedActivate/executeCommand
          的 result.phase 判空，把拒绝误报成「结果待确认」并绕过所有终态处理）；
       ③ 文案不再编造「先确认的命令已生效」——服务端定序拒绝时可能什么都没生效，
          对手往往只是本机上一条超时/未决命令。 */
    const errTxt=String((operation&&operation.error)||'');
    if(operation.phase==='REJECTED'&&/TRIAL_CONCURRENT_OPERATION_DETECTED|VERSION_CONFLICT|TRIAL_PRECONDITION_CHANGED/.test(errTxt)){
      await persistence.markUnknown(command.id,errTxt+'｜本命令已放弃：与早前未完成的命令冲突（可能是你上一步超时的命令，并非其他设备）。可点「按最新数据重建并重新提交」，或重新扫码');
      return {...operation,retryable:true};
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
