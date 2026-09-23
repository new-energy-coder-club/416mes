'use strict';
/* 阶段B 查询页改造 —— 真机（Chromium + 真 IDB）验证。
   覆盖：① 名称模糊查找 ② 结果卡带位置摘要（容器→库位 / 旧定位 / 库位容器数）
        ③ 空查询守卫（不再全表渲染）④ 字段补齐（kind/loc/category）
        ⑤ 多关键词 AND ⑥ 上限与「另有 N 条」 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');

const SEED={
  locations:[
    {code:'L-A',kind:'货架库位',desc:'A区角钢货架',status:'active'},
    {code:'W01-G01',kind:'工位收纳格',desc:'1号工位',status:'active'}],
  containers:[
    {code:'C-A',type:'A4四抽收纳盒',spec:'32×25×34cm',loc:'L-A',status:'active',version:2},
    {code:'C-B',type:'零件盒',spec:'小',loc:'',status:'unknown',version:0}],
  items:[
    {code:'WP-TS-001',name:'内六角扳手',spec:'M3',loc:'',container:'C-A',status:'in_stock',version:2,lastOpId:''},
    {code:'WP-GJ-001',name:'螺丝刀',spec:'十字 PH2',loc:'',container:'',status:'pending',version:1,lastOpId:''},
    {code:'WP-DJ-001',name:'电烙铁',spec:'60W',loc:'W01-G01',container:'',status:'unknown',version:0,lastOpId:''}],
  materials:[],transactions:[],workorders:[],members:[],manuals:[],necOrders:[]
};

test('阶段B：查询页按名称查找并直接给出位置',{timeout:120000},async t=>{
  const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+path.sep))throw Error('path');const bytes=await fs.readFile(file);const ct=file.endsWith('.js')?'text/javascript':'text/html';res.setHeader('Content-Type',ct);res.end(bytes);}catch(e){res.statusCode=404;res.end('nf');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({executablePath:process.env.ITM_TEST_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(()=>browser.close());
  const ctx=await browser.newContext({viewport:{width:1024,height:800}});
  const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.dismiss());

  /* 只注入 localStorage：页面 load() 读它后 save() 会自行写入 IDB，
     因此不需要手工操作 IDB（ego 手工 IDB 事务在此环境不 flush）。 */
  await page.addInitScript(seed=>{
    localStorage.clear();
    localStorage.setItem('mes416_state_v1',JSON.stringify(seed));
    localStorage.removeItem('mes416_idb_behind_v1');
  },SEED);

  await page.goto(origin+'/index.html#items',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>typeof localStoreReady!=='undefined');
  await page.evaluate(()=>localStoreReady);
  await page.evaluate(()=>goTab('items'));

  const q=async v=>{await page.locator('#itmSearch').fill(v);await page.locator('#itmSearchBtn').click();
    return {status:await page.locator('#itmSearchStatus').innerText(),
      cards:await page.locator('#itmResults .itm-result-card').count(),
      text:await page.locator('#itmResults').innerText()};};

  /* ① 按名称查找 —— 用户的核心诉求 */
  const r1=await q('内六角');
  assert.equal(r1.cards,1,'名称命中唯一物品');
  assert.match(r1.status,/找到 1 条/);
  /* ② 结果卡必须带位置（容器 → 库位），不必点详情 */
  assert.match(r1.text,/WP-TS-001/);
  assert.match(r1.text,/位置：当前 C-A → L-A/,'在库物品的结果卡要直接给出 容器 → 库位');

  /* ②b 未定位物品给旧定位线索 */
  const r2=await q('电烙铁');
  assert.equal(r2.cards,1);
  assert.match(r2.text,/旧定位，容器待核实：W01-G01/,'旧定位线索必须出现在结果卡');

  /* ③ 空查询守卫：不再全表渲染 */
  const r3=await q('   ');
  assert.equal(r3.cards,0,'空查询禁止全表渲染（扫码枪误触回车曾卡死移动端）');
  assert.match(r3.status,/请输入名称、规格、分类或编码/);
  assert.match(r3.text,/按名称查找/);

  /* ④ 字段补齐：库位类型 / 容器库位 / 物品分类 */
  assert.match((await q('货架库位')).text,/L-A/,'locations.kind 应可检索');
  assert.match((await q('L-A')).text,/C-A/,'containers.loc 应可反查');
  assert.match((await q('TS')).text,/内六角扳手/,'items.category 应可检索');

  /* ⑤ 多关键词 AND */
  const r5=await q('扳手 M3');
  assert.match(r5.text,/内六角扳手/,'两个词都命中才返回');

  /* ⑥ 上限：库位 desc 含「位」之类宽词时不得全表刷屏 */
  const r6=await q('货架');
  assert.ok(r6.cards<=60,'结果数必须受上限约束');
  assert.match(r6.text,/另有 \d+ 条/,'超出上限要明说');
  await page.screenshot({path:path.join(root,'.verify-batch1-playwright.png'),fullPage:false});

  assert.deepEqual(errors,[],'页面不得有 JS 错误');
  console.log(JSON.stringify({items:3,cardsWhenHuojia:r6.cards,statusHuojia:r6.status,ok:true}));
});
