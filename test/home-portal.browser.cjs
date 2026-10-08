'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '..');
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
async function serve() {
  const server = http.createServer(async (req,res)=>{
    let p;
    try {
      const u=new URL(req.url,'http://localhost');
      if(u.pathname==='/'){res.writeHead(307,{Location:'/home.html'});res.end();return;}
      p=path.resolve(ROOT,'.'+u.pathname);
      if(!p.startsWith(ROOT+path.sep))throw Error('Forbidden');
      const buf=await fs.readFile(p);
      res.setHeader('Content-Type',MIME[path.extname(p)]||'application/octet-stream');
      res.end(buf);
    } catch (_) {res.writeHead(404);res.end('Not found');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {server,origin:'http://127.0.0.1:'+server.address().port};
}
async function launch() {
  return chromium.launch({headless:true,executablePath:process.env.ITM_TEST_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
}
async function withSite(fn) {
  const s=await serve();const b=await launch();
  try {return await fn(s.origin,b);}
  finally {await b.close();await new Promise(r=>s.server.close(r));}
}
test('H1 根域名直达门户；手机版首屏可进入扫码，桌面/平板布局不爆版',async()=>{
 await withSite(async(origin,browser)=>{
  for(const width of [390,768,1280]){
   const ctx=await browser.newContext({viewport:{width,height:900}});
   const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
   const response=await p.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:30000});
   assert.equal(response.status(),200);
   assert.ok(p.url().endsWith('/home.html'),'根路由应到门户，而不是主 app');
   await p.waitForFunction(()=>document.getElementById('networkLabel').textContent!=='正在检测网络');
   const result=await p.evaluate(()=>{
    const cards=[...document.querySelectorAll('.action-card')].map(e=>({name:e.querySelector('.action-name').textContent,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}));
    const bad=[...document.querySelectorAll('a,button,input')].filter(e=>{
      const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&(r.left<-2||r.right>innerWidth+2);
    }).map(x=>x.outerHTML.slice(0,100));
    return {scroll:document.documentElement.scrollWidth,inner:innerWidth,cards,bad,loader:!!document.getElementById('appLoader'),links:document.querySelectorAll('.action-card').length};
   });
   assert.equal(result.scroll,result.inner,'无页面级横向滚动：'+width);
   assert.deepEqual(result.bad,[],'控件不能掉出屏幕：'+width);
   assert.equal(result.loader,false);
   assert.equal(result.links,3);
   assert.equal(result.cards[0].name,'扫码作业');
   if(width===390)assert.ok(result.cards[0].bottom<=900,'手机首屏必须看见扫码作业');
   assert.deepEqual(errors,[],'首页不得抛浏览器脚本异常');
   await ctx.close();
  }
 });
});
test('H2 没有快照/备份时不得显示虚假 0 或 99 天，网络可用≠云端已同步',async()=>{
 await withSite(async(origin,browser)=>{
  const p=await browser.newPage({viewport:{width:390,height:844}});
  await p.goto(origin+'/home.html',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.getElementById('networkLabel').textContent!=='正在检测网络');
  assert.equal(await p.locator('#statItems').textContent(),'—');
  assert.equal(await p.locator('#statInStock').textContent(),'—');
  assert.match(await p.locator('#backupStatus').textContent(),/未发现备份记录/);
  assert.doesNotMatch(await p.locator('body').innerText(),/99 天/);
  assert.match(await p.locator('#cloudStatus').textContent(),/未验证/);
  await p.close();
 });
});
test('H3 本机快照和既有 IndexedDB 出队列只读计数；离线状态如实提示',async()=>{
 await withSite(async(origin,browser)=>{
  const ctx=await browser.newContext({viewport:{width:390,height:844}});
  const p=await ctx.newPage();
  await p.goto(origin+'/home.html',{waitUntil:'domcontentloaded'});
  await p.evaluate(async()=>{
    localStorage.setItem('mes416_state_v1',JSON.stringify({items:[
      {code:'I1',status:'in_stock'},{code:'I2',status:'out'},{code:'I3',status:'in_stock'}
    ],workorders:[{status:'待执行'},{status:'已执行'},{status:'部分执行'}]}));
    localStorage.setItem('mes416_last_backup',String(Date.now()-2*86400000));
    await new Promise((resolve,reject)=>{
      const req=indexedDB.open('mes416-store',1);
      req.onupgradeneeded=()=>req.result.createObjectStore('outbox',{keyPath:'id'});
      req.onerror=()=>reject(req.error);
      req.onsuccess=()=>{const db=req.result,tx=db.transaction('outbox','readwrite');tx.objectStore('outbox').put({id:'p1',status:'pending'});tx.objectStore('outbox').put({id:'p2',status:'needs_attention'});tx.objectStore('outbox').put({id:'p3',status:'applied'});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)};
    });
  });
  await p.reload({waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.getElementById('statPending').textContent==='2');
  assert.equal(await p.locator('#statItems').textContent(),'3');
  assert.equal(await p.locator('#statInStock').textContent(),'2');
  assert.equal(await p.locator('#statWip').textContent(),'2');
  assert.match(await p.locator('#backupStatus').textContent(),/2 天前/);
  assert.match(await p.locator('#cloudStatus').textContent(),/未验证/);
  await ctx.setOffline(true);
  await p.evaluate(()=>window.dispatchEvent(new Event('offline')));
  assert.match(await p.locator('#networkLabel').textContent(),/离线/);
  assert.match(await p.locator('#cloudStatus').textContent(),/离线/);
  const rows=await p.evaluate(async()=>new Promise((resolve,reject)=>{
    const q=indexedDB.open('mes416-store');q.onsuccess=()=>{const db=q.result,tx=db.transaction('outbox','readonly'),r=tx.objectStore('outbox').getAll();r.onsuccess=()=>{db.close();resolve(r.result)}};q.onerror=()=>reject(q.error);
  }));
  assert.equal(rows.length,3,'门户只读统计不应修改原队列');
  await ctx.close();
 });
});
test('H4 首页搜索跨页只读深链：填写词条、进入主应用并保留查询',async()=>{
 await withSite(async(origin,browser)=>{
  const p=await browser.newPage();
  await p.goto(origin+'/home.html',{waitUntil:'domcontentloaded'});
  await p.locator('#homeSearch').fill('内六角 M3');
  await p.locator('#homeSearchForm button').click();
  await p.waitForURL(/index\.html#items\?q=/,{timeout:20000});
  assert.equal(decodeURIComponent(new URL(p.url()).hash),'#items?q=内六角 M3');
  await p.waitForFunction(()=>document.getElementById('itmSearch')?.value==='内六角 M3',{timeout:30000});
  await p.waitForFunction(()=>document.getElementById('itmSearchStatus')?.textContent?.includes('内六角 M3'),{timeout:30000});
  assert.equal(await p.locator('#itmSearch').inputValue(),'内六角 M3');
  await p.reload({waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.getElementById('itmSearchStatus')?.textContent?.includes('内六角 M3'),{timeout:30000});
  assert.equal(decodeURIComponent(new URL(p.url()).hash),'#items?q=内六角 M3','刷新仍保留搜索深链');
  await p.close();
 });
});
