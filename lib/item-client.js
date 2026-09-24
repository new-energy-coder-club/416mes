(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ItemClient=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function create({persistence,fetch:fetcher,timeoutMs=45000,pollTries=20,pollGapMs=6000}){   // 试运行模式走飞书多次串行写，实测常超15s；超时仅表示结果未知
 const headers=()=>({'Content-Type':'application/json','X-416mes-Same-Origin':'1','X-416mes-Token':(function(){try{return localStorage.getItem('mes416_itm_token')||'';}catch(e){return '';}})()});
 async function rawCall(method,payload){
  const url='/api/feishu/item-operation'+(method==='GET'?'?opId='+encodeURIComponent(payload.opId):'');
  const controller=new AbortController();let timer;
  try{
   const operationPromise=(async()=>{const response=await fetcher(url,{signal:controller.signal,method,credentials:'same-origin',headers:headers(),...(method==='POST'?{body:JSON.stringify(payload)}:{})});return {response,data:await response.json()};})();
   const {response,data}=await Promise.race([operationPromise,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('请求超时，结果未知，请查询原opId'));},timeoutMs);})]);
   if(!response.ok||!data.ok)throw Error(data.error||'操作接口拒绝');
   return data;
  }finally{clearTimeout(timer);}
 }
 /* F1（v3.2.4）：终态处理唯一出口——版本类拒绝保留原始错误码落卡（重建按钮靠它匹配）、
    直接返回 operation（不包壳）；其余终态 acknowledge 清卡。 */
 async function finishTerminal(command,operation){
  const errTxt=String((operation&&operation.error)||'');
  if(operation.phase==='REJECTED'&&/TRIAL_CONCURRENT_OPERATION_DETECTED|VERSION_CONFLICT|TRIAL_PRECONDITION_CHANGED/.test(errTxt)){
   await persistence.markUnknown(command.id,errTxt+'｜本命令已放弃：与早前未完成的命令冲突（可能是你上一步超时的命令，并非其他设备）。可点「重试（按最新数据）」，或重新扫码');
   return {...operation,retryable:true};
  }
  await persistence.acknowledge(operation);return operation;
 }
 /* S5（v3.3.0）：提交超时 ≠ 失败——serverless 函数在客户端断开后仍会继续执行并落终态。
    自动按原 opId 查询直至终态（默认 20 次×6s ≈ 2 分钟）：
    APPLIED → 照常入账继续流程；REJECTED → 如实呈现（版本类自动给重建出口）；
    超界仍非终态 → 才落「需人工核验」卡。用户全程无感，不再被推进待处理区死等。 */
 async function pollUntilTerminal(command){
  for(let i=0;i<pollTries;i++){
   if(i)await new Promise(r=>setTimeout(r,pollGapMs));
   try{const data=await rawCall('GET',{opId:command.id});const op=data&&data.operation;
    if(op&&['APPLIED','REJECTED'].includes(op.phase))return op;
   }catch(_){/* 网络抖动继续轮询 */}
  }
  return null;
 }
 async function call(command,method,readOnly=false){
  if(!command||command.op!=='itemOperation')throw Error('不是ITM命令');
  try{
   const data=await rawCall(method,method==='POST'?command.request:{opId:command.id});
   const operation=data.operation;
   if(readOnly)return operation;
   if(operation&&['APPLIED','REJECTED'].includes(operation.phase))return await finishTerminal(command,operation);   // return await：拒绝必须进 catch 落 unknown（裸 return promise 会绕过 try/catch）
   await persistence.markUnknown(command.id,operation&&operation.error||'结果待确认');return operation;
  }catch(e){
   if(readOnly)throw e;
   if(method==='POST'&&/请求超时/.test(String(e.message||''))){
    const polled=await pollUntilTerminal(command);
    if(polled)return await finishTerminal(command,polled);
    const msg='提交超时且自动查询未获终态：云端仍在处理，请稍后在待处理区「查询并确认原命令」（勿重复提交）';
    try{await persistence.markUnknown(command.id,msg);}catch(storageError){e.message+='；本机未知状态保存失败：'+storageError.message+'，原命令未清除';throw e;}
    throw Error(msg);
   }
   try{await persistence.markUnknown(command.id,e.message);}catch(storageError){e.message+='；本机未知状态保存失败：'+storageError.message+'，原命令未清除';throw e;}
   throw e;
  }
 }
 /* P2c：管理员人工收口未决命令（settle 先回读核对实体实际状态：一致→APPLIED、不一致→REJECTED） */
 async function settle(opId){
  try{
   const data=await rawCall('POST',{action:'settle',opId:String(opId||'')});
   return data.operation;
  }catch(e){if(/请求超时/.test(String(e.message||'')))throw Error('收口请求超时，请稍后重试');throw e;}
 }
 return {submit:c=>call(c,'POST'),query:c=>call(c,'GET'),inspect:opId=>call({id:opId,op:'itemOperation'},'GET',true),settle};
}
return {create};
});
