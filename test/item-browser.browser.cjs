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
 await page.reload({waitUntil:'domcontentloaded'});await page.evaluate(()=>localStoreReady);await page.evaluate(()=>goTab('item-work'));await page.locator('#itmDraftRestore').click();await page.waitForFunction(()=>document.getElementById('itmStep').textContent.includes('CTN:C-A'));
 await page.locator('#itmCode').fill('WP-001');await page.locator('#itmScanBtn').click();await page.locator('#itmConfirm').click();await page.waitForFunction(()=>document.getElementById('itmStatus').textContent.includes('本机已保存'));
 await page.getByRole('button',{name:'提交原命令',exact:true}).click();await page.waitForFunction(()=>document.getElementById('itmStatus').textContent.includes('disabled'));
 const actual=await page.evaluate(async()=>({commands:await localStore.getAll('outbox'),mat:state.materials.find(m=>m.code==='M-KEEP').qty,item:state.items.find(i=>i.code==='WP-001')}));assert.equal(actual.mat,7);assert.equal(actual.item.status,'pending');assert.equal(actual.commands.filter(c=>c.op==='itemOperation').length,1);assert.equal(actual.commands.find(c=>c.op==='itemOperation').status,'needs_attention');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({blockedExternalOrigins:[...new Set(denied)],viewport:390,commands:1,pageErrors:errors}));
});
