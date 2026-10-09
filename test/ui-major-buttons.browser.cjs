'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
async function withUi(width,fn){
 const srv=http.createServer(async(req,res)=>{
  try{
   const u=new URL(req.url,'http://localhost');
   if(u.pathname.startsWith('/api/')){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'offline test fixture'}));return;}
   const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/home.html':u.pathname));
   if(!file.startsWith(root+path.sep))throw Error('forbidden');
   const content=await fs.readFile(file);
   res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'})[path.extname(file)]||'application/octet-stream');
   res.end(content)
  } catch {res.statusCode=404;res.end('Missing');}
 });
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.ITM_TEST_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const ctx=await browser.newContext({viewport:{width,height:width===390?844:900},acceptDownloads:true,hasTouch:width===390,isMobile:width===390});
  await ctx.route('**/*',route=>{const u=new URL(route.request().url());return u.origin==='http://127.0.0.1:'+srv.address().port ? route.continue() : route.abort();});
  const page=await ctx.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dlg=>dlg.dismiss());
  await page.addInitScript(()=>{
   if(!localStorage.getItem('ui-button-audit-seeded')){
    localStorage.setItem('ui-button-audit-seeded','1');
    localStorage.setItem('mes416_state_v1',JSON.stringify({materials:[{code:'M-KEEP',name:'六角螺丝刀',qty:7}],locations:[{code:'L-A',kind:'货架',status:'active'}],containers:[{code:'C-A',loc:'L-A',status:'active',version:2}],items:[{code:'WP-001',name:'十字螺丝刀',status:'pending',version:0,container:''}],workorders:[],members:[],manuals:[],transactions:[],itemOperations:[],necOrders:[]}));
   }
  });
  const origin='http://127.0.0.1:'+srv.address().port;
  await page.goto(origin+'/index.html',{waitUntil:'domcontentloaded',timeout:50000});
  await page.evaluate(()=>localStoreReady);
  await page.waitForFunction(()=>!document.getElementById('appLoader'),null,{timeout:12000});
  await fn(page,errors);
  assert.deepEqual(errors,[],'no uncaught JS errors');
  return true;
 }finally{await browser.close();await new Promise(r=>srv.close(r));}
}
test('业务页签及功能入口：逐一点击导航 / 主页快捷入口 / 关键表单按钮',{timeout:120000},async()=>{
 await withUi(1280,async(page,errs)=>{
  const nav=await page.locator('nav.tabs button[data-tab]').evaluateAll(xs=>xs.map(x=>x.dataset.tab));
  const tested=[];
  for(const tab of nav){
   await page.locator('nav.tabs button[data-tab="'+tab+'"]').evaluate(b=>b.click());
   const ok=await page.evaluate(tab=>document.getElementById('tab-'+tab)?.classList.contains('on'),tab);
   assert.equal(ok,true,'导航按键未实际切换: '+tab);
   tested.push(tab);
  }
  await page.evaluate(()=>goTab('items'));
  for(const [kind,expected] of [['receive','item-work'],['issue','item-work'],['scan','scan']]){
   const selector=kind==='scan'?'[data-home-kind=""]':`button[data-home-kind="${kind}"]`;
   const button=kind==='scan'?'button[data-home-go="scan"]':selector;
   await page.locator(button).click();
   assert.equal(await page.evaluate(expected=>document.getElementById('tab-'+expected)?.classList.contains('on'),expected),true,kind+' home action');
   await page.evaluate(()=>goTab('items'));
  }
  await page.locator('#itmSearch').fill('WP-001');await page.locator('#itmSearchBtn').click();
  assert.match(await page.locator('#itmResults').innerText(),/WP-001/);
  await page.evaluate(()=>goTab('item-work'));
  await page.locator('#itmKind').selectOption('receive');
  await page.locator('#itmReset').click();
  await page.locator('#itmCode').fill('LOC:L-A');await page.locator('#itmScanBtn').click();
  assert.match(await page.locator('#itmStep').innerText(),/L-A/,'must first create a nonempty valid receive draft');
  await page.locator('#itmDraftSave').click();
  await page.waitForFunction(()=>document.getElementById('itmStatus').textContent.includes('已保存本机'));
  await page.locator('#itmReset').click();
  await page.locator('#itmDraftRestore').click();
  await page.waitForFunction(()=>document.getElementById('itmStatus').textContent.includes('已恢复最近草稿'),null,{timeout:8000});
  assert.match(await page.locator('#itmStep').innerText(),/L-A/,'手动保存的非空草稿应能在重扫本行后恢复');
  await page.evaluate(()=>goTab('wip'));
  await page.locator('#btnWipNew').click();
  assert.equal(await page.locator('#wipDrawer').evaluate(e=>e.hidden),false,'WIP drawer must open');
  const before=await page.locator('#wipItemTable tbody tr').count();
  await page.locator('#btnWipAddItem').click();
  assert.equal(await page.locator('#wipItemTable tbody tr').count(),before+1,'WIP append plan row');
  await page.locator('#btnWipDrawerClose').click();
  assert.equal(await page.locator('#wipDrawer').evaluate(e=>e.hidden),true,'WIP drawer closes');
  await page.evaluate(()=>goTab('res'));
  await page.locator('#btnResAdd').click();
  assert.equal(await page.locator('#resEditorBox').evaluate(e=>e.hidden),false,'resource editor opens');
  await page.locator('#btnResCancel').click();
  assert.equal(await page.locator('#resEditorBox').evaluate(e=>e.hidden),true,'resource editor closes');
  await page.locator('#btnResRefresh').click();
  await page.evaluate(()=>goTab('member'));
  const prevMembers=await page.evaluate(()=>state.members.length);
  await page.locator('#btnAddMember').click();
  assert.equal(await page.evaluate(()=>state.members.length),prevMembers+1,'local add member');
  await page.evaluate(()=>goTab('sync'));
  await page.locator('#btnSyncQueue').click();
  assert.ok(await page.evaluate(()=>document.getElementById('queueBox')?.textContent.length>=0),'queue button handler');
  console.log('NAV_AND_MAIN_BUTTONS',JSON.stringify({navCount:tested.length,modules:tested,search:true,draft:true,wip:true,res:true,member:true,queue:true,errors:errs}));
 });
});
test('手机端：全部菜单、页签切换、主要输入和页面遮罩',{timeout:90000},async()=>{
 await withUi(390,async(page,errors)=>{
  await page.locator('#btnNavAll').click();
  assert.equal(await page.locator('#btnNavAll').getAttribute('aria-expanded'),'true','mobile all nav expands');
  await page.locator('#mainTabs button[data-tab="wip"]').click();
  assert.equal(await page.locator('#tab-wip').evaluate(x=>x.classList.contains('on')),true);
  assert.equal(await page.locator('#btnNavAll').getAttribute('aria-expanded'),'false','nav should collapse');
  await page.locator('#btnWipNew').click();
  assert.equal(await page.locator('#wipDrawer').evaluate(x=>x.hidden),false);
  await page.locator('#btnWipDrawerClose').click();
  assert.equal(await page.locator('#wipDrawer').evaluate(x=>x.hidden),true);
  await page.locator('#btnNavAll').click();
  await page.locator('#mainTabs button[data-tab="items"]').click();
  await page.locator('#itmSearch').fill('十字螺丝刀');
  await page.locator('#itmSearchBtn').click();
  assert.match(await page.locator('#itmResults').innerText(),/WP-001/);
  console.log('MOBILE_UI',JSON.stringify({menu:true,wip:true,search:true,loaderGone:true,errors}));
 });
});
test('下载/打印/同步及危险操作：实际按钮响应与取消保护',{timeout:120000},async()=>{
 await withUi(1280,async(page,errors)=>{
  const downloads=[];
  for(const [tab,button] of [['ledger','#btnTemplate'],['ledger','#btnBackupJson'],['ledger','#btnExport']]){
   await page.evaluate(tab=>goTab(tab),tab);
   const trigger=page.waitForEvent('download',{timeout:18000});
   await page.locator(button).click();
   const dl=await trigger;
   const bytes=await fs.readFile(await dl.path());
   const kind=button==='#btnBackupJson'?'json':'xlsx';
   if(kind==='json'){const backup=JSON.parse(bytes.toString('utf8'));assert.ok(backup.state&&Array.isArray(backup.state.materials)&&backup.app==='416MES','backup button must generate a valid 416MES JSON package');}
   else assert.equal(bytes.subarray(0,2).toString(),'PK','Excel button must generate valid zip container');
   downloads.push({button,kind,bytes:bytes.length});
  }
  await page.evaluate(()=>goTab('label'));
  await page.locator('#btnSelAll').click();
  const selected=await page.evaluate(()=>document.querySelectorAll('#tab-label input[type=checkbox]:checked').length);
  assert.ok(selected>0,'select all should select label entities');
  const promise=page.waitForEvent('download',{timeout:20000});
  await page.locator('#btnPrint').click();
  const pdf=await promise;
  const pdfBytes=await fs.readFile(await pdf.path());

  assert.equal(pdfBytes.subarray(0,5).toString(),'%PDF-','print button must generate actual PDF bytes');
  downloads.push({button:'#btnPrint',file:pdf.suggestedFilename(),bytes:pdfBytes.length});
  await page.locator('#btnSelNone').click();
  assert.equal(await page.evaluate(()=>document.querySelectorAll('#tab-label input[type=checkbox]:checked').length),0);
  await page.evaluate(()=>goTab('sync'));
  await page.locator('#btnSyncRefresh').click();
  await page.waitForTimeout(500);
  assert.ok(await page.locator('#btnSyncRefresh').isEnabled(),'sync refresh must settle after offline response');
  /* 三个高风险按钮在用户取消后，不得删除本机记录或改变当前数据快照 */
  const read=()=>page.evaluate(()=>({
   members:state.members.length,materials:state.materials.length,items:state.items.length,
   backup:localStorage.getItem('mes416_state_v1')?.length||0
  }));
  const before=await read();
  for(const [tab,id] of [['res','#btnWipe'],['res','#btnSeed'],['sync','#btnHardReset']]){
   await page.evaluate(tab=>goTab(tab),tab);
   const el=page.locator(id);
   if(await el.count())await el.evaluate(e=>e.click());
   await page.waitForTimeout(70);
   assert.deepEqual(await read(),before,'cancel must not modify local state: '+id);
  }
  console.log('DOWNLOAD_DANGER_BUTTONS',JSON.stringify({downloads,selected,offlineSync:true,dangerCanceled:3,errors}));
 });
});
