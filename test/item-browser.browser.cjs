'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
test('entire index boots in Chromium, real IDB draft survives reload, narrow UI and default API denial',{timeout:120000},async t=>{
 const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+path.sep))throw Error('path');const bytes=await fs.readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(bytes);}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.ITM_TEST_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:390,height:844}});const denied=[],errors=[];
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin){denied.push(url.origin);return route.abort();}if(url.pathname.startsWith('/api/'))return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'isolated fixture offline/default write disabled'})});return route.continue();});
 const page=await context.newPage();page.on('dialog',dialog=>dialog.dismiss());page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{if(!localStorage.getItem('itm-test-seeded')){localStorage.setItem('itm-test-seeded','yes');localStorage.setItem('mes416_state_v1',JSON.stringify({materials:[{code:'M-KEEP',name:'MAT',qty:7}],locations:[{code:'L-A',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2,lastOpId:''}],items:[{code:'WP-001',name:'part',status:'pending',container:'',version:0,lastOpId:''}],transactions:[],workorders:[],members:[],manuals:[]}));}});
 await page.goto(origin+'/index.html',{waitUntil:'domcontentloaded',timeout:60000});await page.waitForFunction(()=>typeof localStoreReady!=='undefined');await page.evaluate(()=>localStoreReady);
 await page.evaluate(()=>goTab('items'));await page.locator('#itmSearch').fill('ITM:WP-001');await page.locator('#itmSearchBtn').click();assert.match(await page.locator('#itmResults').innerText(),/数量：1/);
 await page.evaluate(()=>goTab('item-work'));
 for(const code of ['LOC:L-A','CTN:C-A']){await page.locator('#itmCode').fill(code);await page.locator('#itmScanBtn').click();}
 await page.locator('#itmDraftSave').click();await page.waitForFunction(()=>document.getElementById('itmStatus').textContent.includes('已保存本机'));
 await page.reload({waitUntil:'domcontentloaded'});await page.evaluate(()=>localStoreReady);await page.evaluate(()=>goTab('item-work'));await page.locator('#itmDraftRestore').click();await page.waitForFunction(()=>document.getElementById('itmStep').textContent.includes('目标容器：C-A'));
 await page.locator('#itmCode').fill('WP-001');await page.locator('#itmScanBtn').click();await page.locator('#itmConfirm').click();await page.waitForFunction(()=>document.getElementById('itmStatus').textContent.includes('本机已保存'));
 await page.getByRole('button',{name:'提交原命令',exact:true}).click();await page.waitForFunction(()=>document.getElementById('itmStatus').textContent.includes('disabled')||document.getElementById('itmStatus').textContent.includes('拒绝')||document.getElementById('itmStatus').textContent.includes('试运行表结构'));
 const actual=await page.evaluate(async()=>({commands:await localStore.getAll('outbox'),mat:state.materials.find(m=>m.code==='M-KEEP').qty,item:state.items.find(i=>i.code==='WP-001')}));assert.equal(actual.mat,7);assert.equal(actual.item.status,'pending');assert.equal(actual.commands.filter(c=>c.op==='itemOperation').length,1);assert.equal(actual.commands.find(c=>c.op==='itemOperation').status,'needs_attention');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({blockedExternalOrigins:[...new Set(denied)],viewport:390,commands:1,pageErrors:errors}));
});

test('D2: #item/ deep link survives boot timing (IDB recheck) and keeps hash for refresh',{timeout:120000},async t=>{
 const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/fixture'){res.setHeader('Content-Type','text/html');res.end('<html><body>fixture</body></html>');return;}
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+path.sep))throw Error('path');const bytes=await fs.readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(bytes);}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.ITM_TEST_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());const context=await browser.newContext();
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(url.pathname.startsWith('/api/'))return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'offline fixture'})});return route.continue();});
 const page=await context.newPage();page.on('dialog',d=>d.dismiss());const errors=[];page.on('pageerror',e=>errors.push(e.message));
 /* 复现时序误报：localStorage（同步首屏）里没有 WP-777，IndexedDB 里才有 ——
    applyHash 早于 localStoreReady，首查必「未找到」，只有 boot 复检能翻到它。 */
 await page.goto(origin+'/fixture',{waitUntil:'domcontentloaded'});
 await page.evaluate(async()=>{
  localStorage.clear();
  localStorage.setItem('mes416_state_v1',JSON.stringify({materials:[],locations:[{code:'L-A',status:'active'}],containers:[],items:[],transactions:[],workorders:[],members:[],manuals:[]}));
  const full={materials:[],locations:[{code:'L-A',status:'active'}],containers:[],items:[{code:'WP-777',name:'深链物品',status:'pending',container:'',version:0,lastOpId:''}],transactions:[],workorders:[],members:[],manuals:[],itemOperations:[]};
  await new Promise((resolve,reject)=>{const req=indexedDB.open('mes416-state',1);
   req.onupgradeneeded=()=>{const db=req.result;
    if(!db.objectStoreNames.contains('records'))db.createObjectStore('records',{keyPath:['table','key']});
    if(!db.objectStoreNames.contains('transactions')){const tx=db.createObjectStore('transactions',{keyPath:'seq'});tx.createIndex('by_ts','ts',{unique:false});tx.createIndex('by_mat','matCode',{unique:false});}
    if(!db.objectStoreNames.contains('outbox'))db.createObjectStore('outbox',{keyPath:'id'});
    ['baselines','conflicts','syncMeta','deletionJournal'].forEach(n=>{if(!db.objectStoreNames.contains(n))db.createObjectStore(n,{keyPath:'key'});});};
   req.onerror=()=>reject(req.error);
   req.onsuccess=()=>{const db=req.result;const tx=db.transaction('syncMeta','readwrite');tx.objectStore('syncMeta').put({key:'state-v1',value:full});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
 });
 await page.goto(origin+'/index.html#item/WP-777',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>typeof localStoreReady!=='undefined');await page.evaluate(()=>localStoreReady);
 /* 缺口②：hash 保值 —— goTab 改写后必须补回 #item/WP-777 */
 assert.equal(await page.evaluate(()=>location.hash),'#item/WP-777','落地后 hash 必须保留物品码，刷新不失效');
 /* 缺口①：IDB 恢复后的复检必须消除「未找到」误报并定位详情 */
 await page.waitForFunction(()=>document.getElementById('itmResults').textContent.includes('深链物品'),{timeout:15000});
 assert.match(await page.locator('#itmResults').innerText(),/数量：1/);
 assert.doesNotMatch(await page.locator('#itmSearchStatus').innerText(),/未找到/);
 assert.equal(await page.locator('#itmSearch').inputValue(),'ITM:WP-777');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({deepLink:'#item/WP-777',recheck:'ok',pageErrors:errors}));
});
