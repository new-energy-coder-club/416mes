'use strict';
/* v3.13.36（去锚点批量）· describeWorkHit 批量模式覆盖 —— RCA 确认的测试空洞：
   旧实现批量下确认卡拿 batch._loc/anchor 推断「当前步骤需要X码」，子位锚点 _loc 恒 null
   → 相机确认卡错判（RCA 病根），而测试从未覆盖「批量+相机确认卡」组合，bug 漏网。
   本文件锁死新契约：批量确认卡与单行同走当前行 stepsFor（单一事实源），仅行满提示
   换批量口径；另含 /c/ 短链逐件扫容器步回归（v3.13.35 W12 不破）。
   断言真实行为（返回对象的 text/ok），非字符串存在性。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const UI = require('../lib/item-ui');
const U = require('../lib/unique-items');
const CtnLink = require('../lib/ctn-link');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mkState() {
  const st = {
    locations: [
      { code: 'L-A', status: 'active' },
      { code: 'SUB-1', status: 'active', role: '容器子位', parentContainer: 'C-S' }
    ],
    containers: [
      { code: 'C-A', loc: 'L-A', status: 'active', version: 2 },
      { code: 'C-S', loc: '', status: 'active', version: 1 },
      { code: 'SLG-003', loc: 'L-A', status: 'active', version: 1 }   /* BCC-6：旧模型形态过归属比对（短码推导与 loc 无关） */
    ],
    items: [
      { code: 'WP-TS-001', name: 'part', status: 'pending', container: '', version: 0 },
      { code: 'WP-TS-002', name: 'part2', status: 'pending', container: '', version: 0 },
      { code: 'WP-TS-003', name: 'inlib', status: 'in_stock', container: 'C-A', version: 1 }
    ],
    itemOperations: []
  };
  U.migrate(st);
  return st;
}
/* mount 不直接暴露 describeWorkHit——经真实接线捕获：注入 scanCamera 假组件，
   点「相机扫码」→ c.open({describe:describeWorkHit,...}) 保存回调，再以 hit 调用。
   相当于把确认卡「识别→describe→确认卡文案」整条真实链路纳入断言。 */
function setup2() {
  const box = { st: mkState() };
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const { document } = parseHTML(html);
  document.defaultView.ItemLink = require('../lib/item-link');
  document.defaultView.CtnLink = CtnLink;
  const cam = { opened: null, close() {} };
  const scanCamera = { open: async o => { cam.opened = o; }, close: () => {} };
  let n = 0;
  const page = UI.mount({ document, getState: () => box.st, getPersistence: () => ({ async enqueue() {}, async saveDraft() {}, async recover() { return { drafts: [], commands: [] }; } }), getCommands: async () => [], id: () => 'bcc-' + (++n), scanCamera });
  const openCamera = async () => { cam.opened = null; document.getElementById('itmCamera').click(); await tick(); };
  const describe = hit => {
    if (!cam.opened || !cam.opened.describe) throw Error('相机确认卡未打开（describe 未接线）');
    return cam.opened.describe(hit);
  };
  return { document, page, st: box.st, openCamera, describe };
}
const fill = async (d, t) => { d.getElementById('itmCode').value = t; d.getElementById('itmScanBtn').click(); await tick(); };

test('BCC-1 批量 LOC 步：确认卡给实体摘要（可确定填入）；跨类型 CTN 被拒「当前步骤需要库位码」', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  openCamera();
  page.scan.startBatch('receive');
  page.scan.setBatchQty(2);
  const hitLoc = describe({ text: 'LOC:L-A', format: 'QR' });
  assert.ok(!hitLoc.ok, 'ok 为假值=允许确定填入');
  assert.match(String(hitLoc), /库位 L-A/);
  const hitCtn = describe({ text: 'CTN:C-A', format: 'QR' });
  assert.equal(hitCtn.ok, false);
  assert.match(hitCtn.text, /当前步骤需要库位码/, '单一事实源：当前行 stepsFor[0]=LOC');
});

test('BCC-2 批量 CTN 步：LOC 后确认卡放行容器；重扫 LOC 被拒「需要容器码」', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  openCamera();
  page.scan.startBatch('receive');
  page.scan.setBatchQty(2);
  await fill(d, 'LOC:L-A');
  const hitCtn = describe({ text: 'CTN:C-A', format: 'QR' });
  assert.ok(!hitCtn.ok, 'CTN 步放行');
  assert.match(String(hitCtn), /容器 C-A/);
  const hitLoc = describe({ text: 'LOC:L-A', format: 'QR' });
  assert.equal(hitLoc.ok, false);
  assert.match(hitLoc.text, /当前步骤需要容器码/);
});

test('BCC-3 批量 ITM 步：确认卡放行物品；裸 WP 条形码放行（旧批量推断下被误拒的次要错位一并消除）', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  openCamera();
  page.scan.startBatch('receive');
  page.scan.setBatchQty(2);
  await fill(d, 'LOC:L-A');
  await fill(d, 'CTN:C-A');
  const hitItm = describe({ text: 'ITM:WP-TS-001', format: 'QR' });
  assert.ok(!hitItm.ok, 'ITM 步放行');
  assert.match(String(hitItm), /物品 WP-TS-001/);
  const hitBarcode = describe({ text: 'WP-TS-001', format: 'EAN13' });
  assert.ok(!hitBarcode.ok, '裸 WP 条形码在 ITM 步放行（单行同款 ：29 路径）');
  assert.match(String(hitBarcode), /（条形码）/);
});

test('BCC-4 批量子位两步行：子位库位 LOC 后 stepsFor 翻 2 步，确认卡拒 CTN「需要物品码」、放行 ITM', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  openCamera();
  page.scan.startBatch('receive');
  page.scan.setBatchQty(2);
  await fill(d, 'LOC:SUB-1');
  assert.deepEqual(page.scan.stepsFor(page.scan.row()), ['LOC', 'ITM'], '子位两步表（与单行同判）');
  const hitCtn = describe({ text: 'CTN:C-S', format: 'QR' });
  assert.equal(hitCtn.ok, false);
  assert.match(hitCtn.text, /当前步骤需要物品码/, '子位行无容器步骤——旧 _loc 恒 null 推断在这里错判（RCA 病根场景）');
  const hitItm = describe({ text: 'ITM:WP-TS-001', format: 'QR' });
  assert.ok(!hitItm.ok, 'ITM 放行');
  assert.match(String(hitItm), /物品 WP-TS-001/);
});

test('BCC-5 行满放行（v3.13.37，方案 §1）：批未满扫下一件首步放行、错类型严格拦截不跳步；describeWorkHit 纯函数；issue 段同款', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  openCamera();
  page.scan.startBatch('receive');
  page.scan.setBatchQty(2);
  await fill(d, 'LOC:L-A');
  await fill(d, 'CTN:C-A');
  await fill(d, 'ITM:WP-TS-001');   /* 第一件填齐（旧行为在这里卡死：ok:false 禁用确定键） */
  const before = page.scan.snapshot().rows.map(r => r.values.map(v => v.type + v.code));
  /* 行满+批未满：扫下一件首步 LOC → 放行（返回字符串无 ok 字段=确定键启用） */
  const hitNext = describe({ text: 'LOC:L-B', format: 'QR' });
  assert.ok(!hitNext.ok, '放行口径：字符串无 ok 字段');
  assert.match(String(hitNext), /下一件/);
  assert.match(String(hitNext), /库位 L-B/);
  assert.match(String(hitNext), /自动开新表单/);
  /* 纯函数：评价不得 mutate 会话（真正开行只发生在 acceptBatchCode） */
  const after = page.scan.snapshot().rows.map(r => r.values.map(v => v.type + v.code));
  assert.deepEqual(after, before, 'describeWorkHit 不得开行/改行（单一事实源不破）');
  /* 行满+批未满：扫错类型（CTN）→ ok:false 严格拦截不跳步 */
  const hitWrong = describe({ text: 'CTN:C-A', format: 'QR' });
  assert.equal(hitWrong.ok, false);
  assert.match(hitWrong.text, /本件已填齐/);
  assert.match(hitWrong.text, /下一件首步请扫库位码/);
  assert.doesNotMatch(hitWrong.text, /undefined/);
  /* 出库批量同款：首步 ITM → ITM 放行、LOC 拦截、裸 WP 条形码放行 */
  page.scan.startBatch('issue');
  page.scan.setBatchQty(2);
  await fill(d, 'ITM:WP-TS-003');
  const hitIssue = describe({ text: 'ITM:WP-TS-001', format: 'QR' });
  assert.ok(!hitIssue.ok, 'issue 行满+批未满扫 ITM 放行');
  assert.match(String(hitIssue), /下一件/);
  const hitLoc = describe({ text: 'LOC:L-A', format: 'QR' });
  assert.equal(hitLoc.ok, false);
  assert.match(hitLoc.text, /下一件首步请扫物品码/);
  const hitBare = describe({ text: 'WP-TS-001', format: 'EAN13' });
  assert.ok(!hitBare.ok, 'issue 行满+批未满裸 WP 条形码放行（复刻 ITM 步建档校验口径）');
  assert.match(String(hitBare), /条形码/);
  assert.match(String(hitBare), /下一件/);
});

test('BCC-8 批满拦截（v3.13.37）：targetQty 填齐后再扫 → ok:false「已全部填齐请提交本批」（receive/issue 同款）', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  openCamera();
  page.scan.startBatch('receive');
  page.scan.setBatchQty(1);
  await fill(d, 'LOC:L-A');
  await fill(d, 'CTN:C-A');
  await fill(d, 'ITM:WP-TS-001');
  const hit = describe({ text: 'LOC:L-A', format: 'QR' });
  assert.equal(hit.ok, false);
  assert.match(hit.text, /本批 1 件已全部填齐/);
  assert.match(hit.text, /提交本批/);
  assert.doesNotMatch(hit.text, /undefined/);
  page.scan.startBatch('issue');
  page.scan.setBatchQty(1);
  await fill(d, 'ITM:WP-TS-003');
  const hit2 = describe({ text: 'ITM:WP-TS-003', format: 'QR' });
  assert.equal(hit2.ok, false);
  assert.match(hit2.text, /已全部填齐/);
  assert.match(hit2.text, /提交本批/);
});

test('BCC-9 表单卡片化（方案 §2）：卡数===targetQty、徽标三态、chips、active 高亮、已填齐折叠、半成品可见、点卡 select、连续编号', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  openCamera();
  page.scan.startBatch('receive');
  page.scan.setBatchQty(3);
  await fill(d, 'LOC:L-A'); await fill(d, 'CTN:C-A'); await fill(d, 'ITM:WP-TS-001');   /* 件1 填齐（行满自动开行） */
  await fill(d, 'LOC:SUB-1');   /* 件2 半成品（子位 2 步行；旧扁平列表完全不渲染它是洞） */
  page.render();
  const cards = [...d.getElementById('itmStep').querySelectorAll('.itm-batch-card')];
  assert.equal(cards.length, 3, '卡数===targetQty（含空槽）');
  /* 卡头连续编号（按卡序，不因半成品行跳号） */
  cards.forEach((c, i) => assert.match(c.querySelector('.itm-batch-card-head').textContent, new RegExp('表单 ' + (i + 1) + '\\b'), '卡 ' + (i + 1) + ' 编号'));
  /* 卡1 已填齐：✓ 徽标 + 折叠摘要（无 chips） */
  assert.match(cards[0].querySelector('.itm-batch-card-badge').textContent, /已填齐/);
  assert.match(cards[0].querySelector('.itm-batch-card-sum').textContent, /WP-TS-001 @ L-A \/ C-A/);
  assert.equal(cards[0].querySelector('.itm-batch-card-chips'), null, '已填齐折叠');
  /* 卡2 半成品（active）：▶ 扫描中 + chips（子位两步自动正确）+ 高亮 + aria-current */
  assert.match(cards[1].querySelector('.itm-batch-card-badge').textContent, /扫描中/, '进行中之件必须可见');
  const chips2 = [...cards[1].querySelectorAll('.itm-batch-card-chips li')];
  assert.deepEqual(chips2.map(li => li.textContent), ['✓ SUB-1', '入库物品'], '子位两步行 chips（labelsFor 分流）');
  assert.ok(cards[1].classList.contains('itm-batch-card-active'), 'active 高亮');
  assert.equal(chips2[1].getAttribute('aria-current'), 'step', '下一步 chip 标注');
  /* 卡3 空槽：◌ 待扫 + base 三步 chips + 不可点 */
  assert.match(cards[2].querySelector('.itm-batch-card-badge').textContent, /待扫/);
  assert.equal(cards[2].querySelectorAll('.itm-batch-card-chips li').length, 3, '空槽用 base 三步表');
  assert.equal(cards[2].getAttribute('role'), null, '空槽不可点');
  /* 点卡 = scan.select（复刻 :249 语义） */
  cards[0].click(); await tick();
  const snap = page.scan.snapshot();
  assert.equal(snap.rows[snap.active].values[2].code, 'WP-TS-001', '点已填齐卡 → select 切到该行');
});

test('BCC-6 /c/ 短链逐件扫容器步回归（v3.13.35 W12 不破）：批量 CTN 步扫 /c/8位 → 解码入行', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  openCamera();
  page.scan.startBatch('receive');
  page.scan.setBatchQty(2);
  await fill(d, 'LOC:L-A');
  const short = CtnLink.fromCtnCode('SLG-003');
  assert.equal(short, 'FE1P8BZC', '锁值回归：SLG-003 → FE1P8BZC');
  /* 确认卡对 /c/ 文本先给容器摘要（describeWorkHit 归一，此时仍在 CTN 步） */
  const hit = describe({ text: '/c/' + short, format: 'QR' });
  assert.match(String(hit), /容器 SLG-003/);
  await fill(d, '/c/' + short);
  const row = page.scan.row();
  assert.deepEqual(row.values.map(v => v.type + v.code), ['LOCL-A', 'CTNSLG-003'], '/c/ 短链经批量路由归一为 CTN 步并入行');
  /* 行满自动开新行后第二件可继续（逐件扫描语义完整） */
  await fill(d, 'ITM:WP-TS-001');
  assert.deepEqual(page.scan.row().values.map(v => v.type + v.code), ['LOCL-A', 'CTNSLG-003', 'ITMWP-TS-001']);
  await fill(d, 'LOC:L-A');
  assert.deepEqual(page.scan.row().values.map(v => v.type), ['LOC'], '第二件自动开新行');
});

test('BCC-7 批量未设数量时确认卡不误导（数量先行提示与 placeholder 同口径）', async () => {
  const { document: d, page, openCamera, describe } = setup2();
  page.scan.startBatch('receive');
  page.render();   /* 直接调 scan API（不经按钮），placeholder 由 render 刷新 */
  /* 未 setBatchQty：placeholder 引导设定件数 */
  await tick();
  assert.match(d.getElementById('itmCode').placeholder, /设定本批件数/, 'U2：数量未定时 placeholder 引导设定件数');
  await fill(d, 'LOC:L-A').catch(() => {});
  const statusText = d.getElementById('itmStatus').textContent;
  assert.match(statusText, /请先输入本批数量/, '手输通道同口径拒绝');
});
