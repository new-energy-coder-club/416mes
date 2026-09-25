(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ItemClient=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function create({persistence,fetch:fetcher,timeoutMs=45000,pollTries=20,pollGapMs=6000}){   // 试运行模式走飞书多次串行写，实测常超15s；超时仅表示结果未知
 /* v3.12.0 操作人身份（用户拍板：每成员一身份、右上角直接切换、不做身份验证）：
    把当前操作人用 **header** 声明给服务端，让它写进操作日志的 operator。
    此前试运行模式一律记 'trial-unverified'，右上角选的人根本进不了日志。

    ⚠️ 为什么走 header 而不是塞进 request：
      request 会被整体 hash 成 requestHash 用于 opId 幂等重放检测（item-operation.js:106），
      塞进去会让「超时后同 opId 重提」因 payload 变化被判 OP_ID_PAYLOAD_CONFLICT。
      header 不参与该 hash，幂等重试不受影响。

    ⚠️ 这是**声明式**身份（业务留痕，非访问控制）；同源标记仍是唯一网关。
    服务端另有 ITM_OPERATOR_TOKENS 做真实分权（配置后本 header 不再影响 operator）。 */
 /* ⚠️ HTTP header 只能是 ByteString（每个字符码点 ≤ 255）。
    中文姓名（如「卢王淳」）直接写进 header 会让整个 fetch 抛：
      "Failed to read the 'headers' property from 'RequestInit':
       String contains non ISO-8859-1 code point"
    —— 而这个 header 是每条命令都带的，等于**中文名操作人一步都走不下去**。
    故转成 percent-encoding（纯 ASCII）后再发，服务端 decodeURIComponent 还原。 */
 const operatorHeader=()=>{try{
   const st=(typeof state!=='undefined')?state:null;
   const nm=(st&&st.operator)||'';
   /* 先剔除 CR/LF 等会注入日志的控制字符，再编码 */
   const safe=String(nm).replace(/[\r\n\t]/g,'').trim();
   if(!safe) return '';
   return encodeURIComponent(safe);
 }catch(e){return '';}};
 const headers=()=>({'Content-Type':'application/json','X-416mes-Same-Origin':'1','X-416mes-Token':(function(){try{return localStorage.getItem('mes416_itm_token')||'';}catch(e){return '';}})(),'X-416mes-Operator':operatorHeader()});
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
