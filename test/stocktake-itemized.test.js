'use strict';
/* G2 盘点物品化 · 页面层测试（现场复用 itemized-ui-helper.cjs，内含 G2 代码块抽取）
 *
 * 口径（方案定稿）：「扫到一件确认一件，清单差异 = 未扫到的在库物品」。
 * 铁律：整条盘点路径只读 —— 不改物品状态、不写库存流水、不推飞书；
 * 唯一落盘的是盘点会话 state.stocktake（随 save() 持久化，刷新不丢）。
 *
 * 已知坑遵守：本文件不做抽屉/表单提交（只走 handleScan / checkbox change / 按钮 click），
 * 避免 vm+linkedom 同进程多次提交的挂死问题。
 */
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { setup, tick, assert, vm, j } = require('./itemized-ui-helper.cjs');
const ItemLink = require('../lib/item-link.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** 勾选盘点开关（走真实 change 接线） */
function toggleOn(document) {
  const chk = document.getElementById('chkStocktake');
  chk.checked = true;
  chk.dispatchEvent(new document.defaultView.Event('change'));
}

test('G2 静态：旧 MAT 盘点 UI 已移除，物品盘点开关就位', () => {
  assert.ok(!HTML.includes('btnStocktakeOff'), '旧的「退出盘点模式」按钮还在');
  assert.ok(!HTML.includes('stocktakeQty'), '旧的实盘数量输入框还在');
  assert.ok(!HTML.includes('initStocktakeBanner'), '旧的 initStocktakeBanner 还在');
  assert.ok(!/确认盘点/.test(HTML), '「确认盘点」按钮文案还在（MAT 盘点分支没删干净）');
  assert.ok(HTML.includes('btnStocktakeEnd'), '缺「结束盘点」按钮');
  assert.ok(HTML.includes('🧾 物品盘点模式'), '缺物品盘点开关文案');
  assert.ok(HTML.includes('stocktakeCount'), '缺「已盘 x 件」计数位');
});

test('G2 开启盘点模式：建会话（操作人/空清单）、打横幅 class、落盘', () => {
  const { context, document, state, calls } = setup();
  assert.equal(context.stocktakeActive(), false);
  toggleOn(document);
  assert.ok(context.stocktakeActive(), '勾选后盘点会话应建立');
  assert.ok(Array.isArray(state.stocktake.scanned) && state.stocktake.scanned.length === 0);
  assert.equal(state.stocktake.operator, '测试员');
  assert.ok(state.stocktake.startedAt, '会话要有开始时间');
  assert.ok(document.body.classList.contains('stocktake-on'), 'body 应打 stocktake-on（横幅呈现）');
  assert.equal(document.getElementById('stocktakeCount').textContent, '已盘 0 件');
  assert.ok(calls.saved >= 1, '会话应随 save() 持久化');
});

test('G2 扫 ITM 码 → 已确认 ✓ 卡（名称/容器/库位），计数 +1，只读不写账', () => {
  const { context, document, state, calls } = setup();
  toggleOn(document);
  context.handleScan('ITM:IT-1');
  const html = document.getElementById('scanResult').innerHTML;
  assert.match(html, /已确认 ✓/);
  assert.match(html, /件1/);                    // 物品名
  assert.match(html, /CT-1 → L-1/);             // 容器 → 库位
  assert.deepEqual(j(state.stocktake.scanned), ['IT-1']);
  assert.equal(document.getElementById('stocktakeCount').textContent, '已盘 1 件');
  assert.equal(state.transactions.length, 0, '盘点确认绝不能写库存流水');
  assert.equal(calls.pushRecord.length, 0, '盘点确认绝不能推飞书');
  assert.equal(calls.scanItem, 0, '盘点模式下不应走 scanItem 的普通查询分支');
});

test('G2 同一件重复扫 → 提示「已盘过」，不重复计数', () => {
  const { context, document, state } = setup();
  toggleOn(document);
  context.handleScan('ITM:IT-1');
  context.handleScan('ITM:IT-2');
  context.handleScan('IT-1');   // 裸物品码重复扫
  const html = document.getElementById('scanResult').innerHTML;
  assert.match(html, /已盘过/);
  assert.match(html, /不重复计数/);
  assert.deepEqual(j(state.stocktake.scanned), ['IT-1', 'IT-2']);
  assert.equal(document.getElementById('stocktakeCount').textContent, '已盘 2 件');
});

test('G2 短链 URL 与裸物品码都归一进盘点确认（复用 parseScanText/自动识别）', () => {
  const { context, document, state } = setup();
  state.items.push({ code: 'WP-TS-001', name: '调试设备1', status: 'in_stock', container: 'CT-1', version: 1 });
  toggleOn(document);
  context.handleScan(ItemLink.linkFor('WP-TS-001'));   // 8 位短链 URL
  assert.deepEqual(j(state.stocktake.scanned), ['WP-TS-001']);
  context.handleScan('WP-TS-001');                     // 裸物品码 → 重复 → 已盘过
  assert.match(document.getElementById('scanResult').innerHTML, /已盘过/);
  assert.equal(state.stocktake.scanned.length, 1, '短链与裸码是同一件，不能计两次');
});

test('G2 盘点模式扫 LOC:/MAT: → 走原只读查询分支并提示「盘点模式仅统计物品」', () => {
  const { context, document, state, calls } = setup();
  toggleOn(document);
  context.handleScan('LOC:L-1');
  assert.match(document.getElementById('scanResult').innerHTML, /盘点模式仅统计物品/);
  context.handleScan('MAT:MAT-A');
  assert.equal(calls.scanMat, 1, 'MAT: 应走原 scanMat 只读查询分支');
  assert.match(document.getElementById('scanResult').innerHTML, /盘点模式仅统计物品/);
  assert.deepEqual(j(state.stocktake.scanned), [], '非物品码不计入盘点');
  assert.ok(calls.logs.some(l => l.includes('盘点模式仅统计物品')), '操作日志里要有提示');
});

test('G2 盘点模式扫未建档物品码 → 未命中卡，不计数', () => {
  const { context, document, state } = setup();
  toggleOn(document);
  context.handleScan('ITM:NO-SUCH');
  assert.match(document.getElementById('scanResult').innerHTML, /未找到该物品/);
  assert.deepEqual(j(state.stocktake.scanned), []);
});

test('G2 结束盘点 → 只读报告：已确认 / 差异（在库未扫到）/ 异常（扫到但非在库）', () => {
  const { context, document, state, calls } = setup();
  toggleOn(document);
  context.handleScan('ITM:IT-1');    // in_stock → 已确认
  context.handleScan('ITM:IT-P');    // pending → 异常清单
  document.getElementById('btnStocktakeEnd').click();   // 走真实按钮接线
  const html = document.getElementById('scanResult').innerHTML;
  assert.match(html, /盘点结束/);
  assert.match(html, /报告只读/);
  assert.match(html, /① 已确认清单（2 件）/);
  assert.match(html, /IT-1/);
  assert.match(html, /② 差异清单（在库但未扫到）（2 件）/, 'IT-2/IT-3 是在库且未扫到');
  assert.match(html, /IT-2/);
  assert.match(html, /IT-3/);
  assert.match(html, /③ 异常清单（扫到但状态非在库）（1 件）/);
  assert.match(html, /IT-P/);
  assert.match(html, /退役/, '差异清单要引导「找到后扫码确认，或走退役」');
  assert.equal(state.stocktake, null, '结束后会话应清空');
  assert.ok(!document.body.classList.contains('stocktake-on'), '结束后横幅应收起');
  assert.equal(state.transactions.length, 0, '报告只读：不写流水');
  assert.equal(calls.pushRecord.length, 0, '报告只读：不推飞书');
  // 物品状态一个都不许动
  assert.equal(state.items.find(i => i.code === 'IT-P').status, 'pending');
  assert.equal(state.items.find(i => i.code === 'IT-2').status, 'in_stock');
});

test('G2 取消勾选 = 结束盘点（同一条路径出报告）', () => {
  const { context, document, state } = setup();
  toggleOn(document);
  context.handleScan('ITM:IT-1');
  const chk = document.getElementById('chkStocktake');
  chk.checked = false;
  chk.dispatchEvent(new document.defaultView.Event('change'));
  assert.equal(state.stocktake, null);
  assert.match(document.getElementById('scanResult').innerHTML, /① 已确认清单（1 件）/);
});

test('G2 盘点会话随 save() 持久化：刷新后（重跑 init）横幅与计数自动恢复', () => {
  const { context, document, state } = setup();
  toggleOn(document);
  context.handleScan('ITM:IT-1');
  context.handleScan('ITM:IT-2');
  // 模拟刷新：勾选框/横幅是 DOM 态会丢，但 state.stocktake 还在 → init 负责复位
  document.getElementById('chkStocktake').checked = false;
  document.body.classList.remove('stocktake-on');
  context.initItemStocktake();
  assert.equal(document.getElementById('chkStocktake').checked, true, '会话存活 → 勾选框复位');
  assert.ok(document.body.classList.contains('stocktake-on'), '会话存活 → 横幅复位');
  assert.equal(document.getElementById('stocktakeCount').textContent, '已盘 2 件');
});

test('G2 开始新盘点会清掉旧会话（哪怕上次没点结束）', () => {
  const { context, document, state } = setup();
  toggleOn(document);
  context.handleScan('ITM:IT-1');
  toggleOn(document);   // 再次勾选 = 新一轮
  assert.deepEqual(j(state.stocktake.scanned), [], '新盘点必须清空旧清单');
  assert.equal(document.getElementById('stocktakeCount').textContent, '已盘 0 件');
});
