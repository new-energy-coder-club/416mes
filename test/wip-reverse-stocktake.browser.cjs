'use strict';
/* 阶段B 第二批 —— 真机（Chromium + 真 IDB）验证。
   ① outbox.put 存在且可把 needs_attention 改回 pending（自动重试不再空转）
   ② 已执行物品化工单出现「冲销」入口；未执行/旧物料单不出现
   ③ 盘点结束报告给差异处理出口（导出 CSV / 跳转退役 / 跳转查询）
   ④ 「账本修数」死文案已从用户可见界面移除 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');

const SEED={
  locations:[{code:'L-A',kind:'货架库位',desc:'A区角钢货架',status:'active'}],
  containers:[{code:'C-A',type:'收纳盒',spec:'32cm',loc:'L-A',status:'active',version:2}],
  items:[
    {code:'WP-TS-001',name:'内六角扳手',spec:'M3',loc:'',container:'C-A',status:'in_stock',version:2,lastOpId:''},
    {code:'WP-GJ-001',name:'螺丝刀',spec:'PH2',loc:'',container:'',status:'pending',version:1,lastOpId:''}],
  workorders:[],
  materials:[],transactions:[],members:[],manuals:[],necOrders:[]
};

test('阶段B第二批：冲销入口 / outbox.put / 盘点差异出口 / 死文案清除',{timeout:180000},async t=>{
  const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+path.sep))throw Error('path');const bytes=await fs.readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(bytes);}catch(e){res.statusCode=404;res.end('nf');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({executablePath:process.env.ITM_TEST_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(()=>browser.close());
  const ctx=await browser.newContext({viewport:{width:1280,height:900}});
  const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.dismiss());

  await page.addInitScript(seed=>{
    localStorage.clear();
    localStorage.setItem('mes416_state_v1',JSON.stringify(seed));
    localStorage.removeItem('mes416_idb_behind_v1');
  },SEED);

  await page.goto(origin+'/index.html#items',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>typeof localStoreReady!=='undefined');
  await page.evaluate(()=>localStoreReady);

  /* ① outbox.put 必须真的存在（此前缺失 → 自动重试整段是死代码） */
  const api = await page.evaluate(async () => {
    const ob = await fsOutboxAsync();
    return { hasPut: typeof ob.put === 'function', hasLegacyPut: typeof fsOutbox().put === 'function' };
  });
  assert.equal(api.hasPut, true, '异步 outbox 必须导出 put');
  assert.equal(api.hasLegacyPut, true, '同步 outbox 必须导出 put');

  /* ①b 功能验证：把一条 needs_attention 改回 pending 并重读 */
  const roundtrip = await page.evaluate(async () => {
    const ob = await fsOutboxAsync();
    await ob.append({ op: 'stock', matCode: 'TEST-1', qty: 1, delta: -1 });
    const id = (await ob.list()).find(x => x.matCode === 'TEST-1').id;
    for (let i = 0; i < 6; i++) await ob.markAttempt(id, '503 Service Unavailable');
    const mid = (await ob.list()).find(x => x.id === id);
    await ob.put({ id, status: 'pending', _autoRetries: 1 });
    const after = (await ob.list()).find(x => x.id === id);
    await ob.removeById(id);
    return { midStatus: mid.status, afterStatus: after.status, tries: after.tries, auto: after._autoRetries };
  });
  assert.equal(roundtrip.midStatus, 'needs_attention', '连败到上限要转需人工');
  assert.equal(roundtrip.afterStatus, 'pending', 'put 必须能把 needs_attention 改回 pending（自动重试落地的前提）');
  assert.equal(roundtrip.auto, 1, '重试计数要落盘');
  assert.equal(roundtrip.tries, 6, 'put 不得递增 tries（仍是 markAttempt 计到的 6 次）');

  /* ② 造一张已执行的物品化工单，检查冲销入口出现 */
  const reverseBtn = await page.evaluate(async () => {
    // 直接构造：一张已执行 1 件的领料工单，execBatches 带位置留痕
    state.workorders = state.workorders || [];
    state.workorders.push({
      code: 'LL-TEST-001', type: 'LL', date: new Date().toISOString().slice(0, 10),
      items: [{ itemCodes: ['WP-TS-001'] }], status: '已执行', itemized: true,
      execItems: ['WP-TS-001'],
      execBatches: [{ opId: 'LL-TEST-001#WP-TS-001', ops: [{ opId: 'X-1', itemCode: 'WP-TS-001', fromLoc: 'L-A', fromContainer: 'C-A' }] }],
      createdAt: new Date().toISOString()
    });
    save();
    showWipDetail('LL-TEST-001');
    const btn = document.getElementById('btnWipReverse');
    return { exists: !!btn, text: btn ? btn.textContent : null,
      deleteBtn: !!document.getElementById('btnWipDelete'),
      cancelBtn: !!document.getElementById('btnWipCancel') };
  });
  assert.equal(reverseBtn.exists, true, '已执行物品化工单必须提供冲销入口');
  assert.match(reverseBtn.text, /冲销/, '按钮文案要说明是冲销');
  assert.equal(reverseBtn.cancelBtn, false, '已执行工单不能再「取消」（必须冲销）');

  /* ②b 未执行工单不出现冲销（应给取消） */
  const noReverse = await page.evaluate(async () => {
    state.workorders.push({
      code: 'LL-TEST-002', type: 'LL', date: new Date().toISOString().slice(0, 10),
      items: [{ itemCodes: ['WP-GJ-001'] }], status: '待执行', itemized: true,
      execItems: [], execBatches: [], createdAt: new Date().toISOString()
    });
    save(); showWipDetail('LL-TEST-002');
    return { reverse: !!document.getElementById('btnWipReverse'), cancel: !!document.getElementById('btnWipCancel') };
  });
  assert.equal(noReverse.reverse, false, '未执行工单不该出现冲销');
  assert.equal(noReverse.cancel, true, '未执行工单应可直接取消');

  /* ③ 盘点结束报告要给差异处理出口 */
  const stocktake = await page.evaluate(async () => {
    state.stocktake = { startedAt: new Date().toISOString(), operator: state.operator || '', scanned: [], baseline: ['WP-TS-001', 'WP-GJ-001'] };
    save();
    stocktakeEnd(document.getElementById('scanResult'));
    const box = document.getElementById('scanResult');
    return {
      hasExport: !!document.getElementById('btnStocktakeExportDiff'),
      hasGotoRetire: !!document.getElementById('btnStocktakeGotoRetire'),
      text: box.innerText.slice(0, 400),
      mentionsRetire: /退役/.test(box.innerText),
      mentionsMove: /移库|换箱/.test(box.innerText)
    };
  });
  assert.equal(stocktake.hasExport, true, '盘点报告必须提供差异导出');
  assert.equal(stocktake.hasGotoRetire, true, '盘点报告必须提供去处理的跳转');
  assert.equal(stocktake.mentionsRetire, true, '差异清单要说明退役路径');
  assert.equal(stocktake.mentionsMove, true, '差异清单要说明改位置的路径（比退役更准确）');

  /* ④ 「账本修数」死文案不得再出现在用户可见界面 */
  const deadCopy = await page.evaluate(async () => {
    const tabs = ['items','item-work','register','scan','wip','ledger','txn','res','label','sync'];
    let found = [];
    for (const t of tabs) {
      goTab(t);
      const sec = document.getElementById('tab-' + t);
      if (sec && /账本修数/.test(sec.innerText)) found.push(t);
    }
    return found;
  });
  assert.deepEqual(deadCopy, [], '用户可见界面不得再指引到已移除的「账本修数」入口');

  await page.screenshot({path:path.join(root,'.verify-batch2-playwright.png'),fullPage:false});
  assert.deepEqual(errors.filter(e => !/pgToc/.test(e)), [], '页面不得有 JS 错误');
  console.log(JSON.stringify({outboxPut:api,roundtrip,reverseBtn,stocktake:{hasExport:stocktake.hasExport,hasGotoRetire:stocktake.hasGotoRetire},ok:true}));
});
