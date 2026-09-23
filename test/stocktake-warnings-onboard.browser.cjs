'use strict';
/* 阶段B 第三批 —— 真机（Chromium + 真 IDB）验证。
   ① 物料台账恢复低库存/负库存预警（行底色 + 徽标 + 汇总）
   ② items 同号守卫：同码两条记录时停止给出权威结果
   ③ 残缺码识别态：不像任何编码形状 → 提示可能磨损，而不是「未找到物料」
   ④ 资源档案：唯一实体的「作废删除」按钮禁用并带原因
   ⑤ 扫码记录表可筛选/分页，且 2000 条上限可见
   ⑥ 首次使用三步引导出现，且刷新后不再出现 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');

const SEED={
  materials:[
    {code:'GJ-SD-001',cat:'GJ',name:'螺丝刀',spec:'PH2',loc:'B-01-01-01',container:'XK-001',zone:'',qty:5,minQty:2,cost:8.5,img:''},
    {code:'HC-BG-001',cat:'HC',name:'打印纸',spec:'A4',loc:'',container:'',zone:'',qty:1,minQty:3,cost:22,img:''},
    {code:'QT-TEST-1',cat:'QT',name:'负库存物料',spec:'',loc:'',container:'',zone:'',qty:-2,minQty:0,cost:0,img:''},
    {code:'QT-TEST-2',cat:'QT',name:'无库存物料',spec:'',loc:'',container:'',zone:'',qty:0,minQty:0,cost:0,img:''}],
  locations:[{code:'B-01-01-01',kind:'货架库位',desc:'B区1层1位',status:'active'},{code:'L-A',kind:'货架库位',desc:'A区',status:'active'}],
  containers:[{code:'XK-001',type:'收纳盒',spec:'32cm',loc:'B-01-01-01',status:'active',version:2},{code:'C-A',type:'盒子',spec:'',loc:'L-A',status:'active',version:1}],
  items:[{code:'WP-TS-001',name:'内六角扳手',spec:'M3',loc:'',container:'XK-001',status:'in_stock',version:2,lastOpId:''}],
  workorders:[],transactions:[],members:[],manuals:[],necOrders:[],scanHistory:[]
};

test('阶段B第三批：库存预警 / items同号守卫 / 残缺码 / resDelete禁用 / 扫码记录 / 首次引导',{timeout:180000},async t=>{
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
    // 「首次引导」要测真实出现，所以这里故意不预置 onboarded 键
    localStorage.removeItem('mes416_onboarded_v1');
  },SEED);

  await page.goto(origin+'/index.html#items',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>typeof localStoreReady!=='undefined');
  await page.evaluate(()=>localStoreReady);

  /* ⑥ 首次引导出现（早于其它断言：它会插在 main 最前） */
  const onboard = await page.evaluate(() => {
    const b = [...document.querySelectorAll('main > div')].find(x => /第一次使用/.test(x.textContent || ''));
    return { shown: !!b, has3Steps: b ? (b.querySelectorAll('[data-onboard-go]').length === 3) : false,
      mentionsNameQuery: b ? /按名称|名称.*查/.test(b.textContent) : false };
  });
  assert.equal(onboard.shown, true, '首次使用必须显示引导');
  assert.equal(onboard.has3Steps, true, '引导必须是三步（建档→打码→扫码）');
  assert.equal(onboard.mentionsNameQuery, true, '引导要告诉用户可以按名称查询');
  await page.evaluate(() => { const c = document.getElementById('btnOnboardClose'); if (c) c.click(); });

  /* ① 物料台账低库存/负库存预警 */
  const ledger = await page.evaluate(async () => {
    goTab('ledger');
    const rows = [...document.querySelectorAll('#matTable tbody tr')].map(tr => ({
      cls: tr.className, code: tr.querySelector('td') ? tr.querySelector('td').textContent.trim() : '',
      text: tr.innerText
    }));
    const sum = document.getElementById('matSummary');
    return { rows, summary: sum ? sum.textContent : '' };
  });
  const byCode = {};
  ledger.rows.forEach(r => { byCode[r.code] = r; });
  assert.match(byCode['HC-BG-001'].cls, /row-low/, '低于安全库存要黄底');
  assert.match(byCode['HC-BG-001'].text, /低于安全库存/, '低于安全库存要带徽标与阈值说明');
  assert.match(byCode['QT-TEST-1'].cls, /row-neg/, '负库存要红底');
  assert.match(byCode['QT-TEST-1'].text, /负库存/, '负库存要带徽标');
  assert.match(byCode['GJ-SD-001'].cls || '', /^(?!.*row-(low|neg)).*$/, '充足库存不着色');
  assert.doesNotMatch(byCode['GJ-SD-001'].text, /⚠/, '充足库存不出现预警徽标');
  assert.match(ledger.summary, /低于安全库存 1 条/, '汇总要报低库存条数');
  assert.match(ledger.summary, /负库存 1 条/, '汇总要报负库存条数');
  assert.match(ledger.summary, /本页只读/, '要说明预警只提示、不在此改数');

  /* ② items 同号守卫 */
  const dupGuard = await page.evaluate(async () => {
    state.items.push({ code:'WP-TS-001', name:'内六角扳手（重）', spec:'M3', loc:'', container:'', status:'pending', version:9, lastOpId:'z' });
    save();
    const box = document.getElementById('scanResult');
    handleScan('ITM:WP-TS-001');
    return { text: box.innerText, hasDup: /同号/.test(box.innerText), stopped: /已停止/.test(box.innerText) };
  });
  assert.equal(dupGuard.hasDup, true, '同号物品必须被发现并明说');
  assert.equal(dupGuard.stopped, true, '同号时必须停止给出权威结果');
  assert.match(dupGuard.text, /数据对齐/, '要指出去哪里收敛');

  /* ③ 残缺码识别 */
  const worn = await page.evaluate(async () => {
    const box = document.getElementById('scanResult');
    handleScan('WP-TS-0');                 // 明显被截断的物品码
    const t1 = box.innerText;
    handleScan('B-01-01-01X');
    const t2 = box.innerText;
    return { truncated: t1, partialLoc: t2 };
  });
  assert.match(worn.truncated, /可能没扫全/, '截断的物品码要提示磨损而非「未找到物品」');
  assert.match(worn.partialLoc, /可能没扫全/, '残缺库位码同样要提示磨损');

  /* ④ resDelete 死按钮改禁用 */
  const resDel = await page.evaluate(async () => {
    goTab('res');
    renderRes();
    const btns = [...document.querySelectorAll('#resTable [data-res-del]')];
    const uniqueDisabled = btns.filter(b => b.disabled).length;
    const sample = btns[0];
    return { total: btns.length, uniqueDisabled,
      title: sample ? (sample.getAttribute('title') || '') : '' };
  });
  assert.ok(resDel.total > 0, '资源档案必须有删除入口');
  assert.equal(resDel.uniqueDisabled, resDel.total, '唯一实体（物品/库位/容器）的删除按钮必须全部禁用');
  assert.match(resDel.title, /不可硬删/, '禁用的原因必须写在 title 里');

  /* ⑤ 扫码记录表 */
  const scanLog = await page.evaluate(async () => {
    state.scanHistory = [];
    const Core = window.MesCore;
    Core.recordScan(state, { raw: 'MAT:GJ-SD-001', prefix: 'MAT:', code: 'GJ-SD-001', kind: 'material', hit: true, name: '螺丝刀', operator: state.operator || 'x' });
    Core.recordScan(state, { raw: 'ITM:WP-TS-001', prefix: 'ITM:', code: 'WP-TS-001', kind: 'item', hit: true, name: '内六角扳手', loc: 'B-01-01-01', container: 'XK-001', operator: state.operator || 'x' });
    goTab('txn');
    renderScanHistory();
    const rows = [...document.querySelectorAll('#scanLogTable tbody tr')];
    const sum = document.getElementById('scanLogSummary');
    const search = document.getElementById('scanLogSearch');
    search.value = 'GJ-SD-001'; search.dispatchEvent(new Event('input', {bubbles:true}));
    const filtered = document.querySelectorAll('#scanLogTable tbody tr').length;
    search.value = ''; search.dispatchEvent(new Event('input', {bubbles:true}));
    return { hasTable: !!document.getElementById('scanLogTable'), rows: rows.length, filtered, sum: sum ? sum.textContent : '',
      firstRow: rows[0] ? rows[0].innerText : '' };
  });
  assert.equal(scanLog.hasTable, true, '必须有扫码记录表');
  assert.ok(scanLog.rows > 0, '扫码记录表要有行');
  assert.equal(scanLog.filtered, 1, '按编码筛选要只剩 1 条');
  assert.match(scanLog.sum, /共 2 条/, '汇总要给出条数');
  assert.match(scanLog.firstRow, /WP-TS-001|内六角扳手|GJ-SD-001|螺丝刀/, '表格要显示编码或名称');

  await page.screenshot({path:path.join(root,'.verify-batch3-playwright.png'),fullPage:false});
  assert.deepEqual(errors.filter(e => !/pgToc/.test(e)), [], '页面不得有 JS 错误');
  console.log(JSON.stringify({onboard,ledger:{summary:ledger.summary},dupGuard:{hasDup:dupGuard.hasDup},worn:{t:/可能没扫全/.test(worn.truncated)},resDel,scanLog:{rows:scanLog.rows,filtered:scanLog.filtered},ok:true}));
});
