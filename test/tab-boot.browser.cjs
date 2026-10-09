'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const { chromium }=require('playwright-core');
const root=path.resolve(__dirname,'..');

test('移动端双标签：加载遮罩退场、只读 IDB 恢复与关闭旧标签自动接管',{timeout:90000},async t=>{
 const server=http.createServer(async(req,res)=>{
   try {
     const u=new URL(req.url,'http://localhost');
     if(u.pathname.startsWith('/api/')) {
       res.writeHead(503,{'Content-Type':'application/json'});
       res.end(JSON.stringify({ok:false,error:'isolated read-only fixture'}));
       return;
     }
     const file=path.resolve(root,'.'+decodeURIComponent(u.pathname));
     if(!file.startsWith(root+path.sep))throw Error('forbidden');
     const bytes=await fs.readFile(file);
     res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');
     res.end(bytes);
   }catch{res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({executablePath:process.env.ITM_TEST_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 t.after(()=>browser.close());
 const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const errs=[];const url='http://127.0.0.1:'+server.address().port+'/index.html';
 const first=await ctx.newPage();
 first.on('pageerror',e=>errs.push('first:'+e.message));
 await first.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
 await first.evaluate(()=>localStoreReady);
 assert.equal(await first.evaluate(()=>itmReadOnlyTab),false);
 await first.evaluate(async()=>{
   await localStore.put('syncMeta',{key:'itmDraft:probe',value:{rows:[{rowId:'keep-draft'}]}});
 });
 const second=await ctx.newPage();
 second.on('pageerror',e=>errs.push('second:'+e.message));
 await second.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
 await second.evaluate(()=>localStoreReady);
 const readonly=await second.evaluate(async()=>({
   readOnly:itmReadOnlyTab,
   localStore:!!localStore,
   drafts:(await itmPersistence.recover({readOnly:true})).drafts.filter(d=>d.key==='itmDraft:probe').length,
   notice:document.getElementById('mesNotice')?.textContent||''
 }));
 assert.equal(readonly.readOnly,true);
 assert.equal(readonly.localStore,true,'只读标签仍必须保持 IDB 连接');
 assert.equal(readonly.drafts,1,'只读标签能读取已有草稿');
 assert.match(readonly.notice,/只读/);
 await second.waitForFunction(()=>!document.getElementById('appLoader'),null,{timeout:8500});
 await first.close();
 await second.waitForEvent('framenavigated',{timeout:18000});
 await second.waitForFunction(()=>typeof localStoreReady!=='undefined',{timeout:15000});
 await second.evaluate(()=>localStoreReady);
 assert.equal(await second.evaluate(()=>itmReadOnlyTab),false,'前一标签关闭后重新加载并接管写锁');
 assert.equal(await second.evaluate(()=>!!localStore),true);
 assert.equal((await second.evaluate(async()=>localStore.get('syncMeta','itmDraft:probe'))).value.rows[0].rowId,'keep-draft','原草稿不能被清除');
 await second.waitForFunction(()=>!document.getElementById('appLoader'),null,{timeout:8500});
 assert.deepEqual(errs,[]);
 console.log(JSON.stringify({readonlyRecovered:true,loaderGone:true,takeover:true,draftPreserved:true,errors:errs}));
});
