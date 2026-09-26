'use strict';
/* v3.13.20 · 实测发现 BG 的回归测试
 *
 * 线上实测复现：工单执行卡激活（WIP_EXEC.code 非空）时，扫**任意** ITM: 码
 * （哪怕不属于这张工单）都被塞进工单执行卡，操作员想查那个物品的位置
 * 反而拿到工单卡，查不到位置信息。
 *
 * 根因：index.html 的 G1 执行上下文分支里，ITM: 前缀**不做归属校验**：
 *     if (prefix === 'ITM:') { wipItemExecScan(code); return; }
 * 而同一条链路里**无前缀的裸码反而有校验**：
 *     if (!m && wipItemPlannedCodes(wAct).indexOf(code) >= 0) { wipItemExecScan(code); return; }
 * 两处口径不一致 —— 带前缀的比裸码还宽松。
 *
 * 修法：ITM: 分支补上与裸码相同的 wipItemPlannedCodes 归属校验，
 * 不属于本工单的物品码继续往下走到 scanItem() 做只读查询。
 */
const test = require('node:test');
const { setup, mkItemizedOrder, assert, vm } = require('./itemized-ui-helper.cjs');

/* 工单执行上下文激活 + 一张物品化单（计划内 IT-1/IT-2/IT-3，计划外 IT-P） */
function withExecContext() {
  const env = setup('applied');
  mkItemizedOrder(env.state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  env.context.scanWip('LL20260919001', env.document.getElementById('scanResult'));
  assert.equal(vm.runInContext('WIP_EXEC.code', env.context), 'LL20260919001', '执行上下文应激活');
  return env;
}

test('BG-1 执行中扫计划内的 ITM: 码 → 仍进工单执行卡（不能把正常路径改坏）', async () => {
  const { context, state, calls } = withExecContext();
  const before = vm.runInContext('WIP_EXEC.batch.length', context);

  await context.wipItemExecScan('ITM:IT-2');

  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), before + 1, '计划内物品应入批');
  assert.equal(calls.scanItem, 0, '不应掉到只读查询');
  assert.match(context.document.getElementById('scanResult').innerHTML, /已入批/, '卡片应显示入批反馈');
});

test('BG-2 执行中扫计划外的 ITM: 码 → 走只读物品查询，不再被劫持进工单卡', async () => {
  const { context, calls } = withExecContext();
  const before = vm.runInContext('WIP_EXEC.batch.length', context);

  /* 计划外物品：IT-P（status=pending，不在 LL20260919001 的计划里） */
  vm.runInContext("handleScan('ITM:IT-P')", context);

  assert.equal(calls.scanItem, 1, '计划外 ITM: 码应走到 scanItem() 只读查询');
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), before, '不应入批');
  assert.equal(calls.enqueue.length, 0, '不应产生任何命令');
});

test('BG-3 修复前后口径一致：同一计划外物品码，带 ITM: 前缀与不带前缀行为相同', async () => {
  /* 关键：必须用**已建档但不在本工单计划里**的物品码（IT-P）。
     这样两条路径的 prefix 都会被解析成 'ITM:'（无前缀时由 state.items 自动识别），
     唯一差别就是「显式带前缀」与「自动识别」，二者对计划外码必须同径。
     修复前：显式带前缀的被劫持进工单卡（scanItem=0、可能入批），
             自动识别的走只读查询（scanItem=1）→ 同一件物品两种待遇，这就是 bug。 */
  const a = withExecContext();
  vm.runInContext("handleScan('IT-P')", a.context);
  const auto = { scanItem: a.calls.scanItem, batch: vm.runInContext('WIP_EXEC.batch.length', a.context) };

  const b = withExecContext();
  vm.runInContext("handleScan('ITM:IT-P')", b.context);
  const explicit = { scanItem: b.calls.scanItem, batch: vm.runInContext('WIP_EXEC.batch.length', b.context) };

  assert.equal(explicit.batch, auto.batch, '两条路径都不应把计划外码塞进工单批次');
  assert.equal(explicit.scanItem, auto.scanItem, '同一计划外物品码，带前缀与不带前缀必须同径');
  assert.equal(auto.scanItem, 1, '计划外物品码应走只读物品查询');
  assert.equal(auto.batch, 0, '计划外物品码不应入批');
});

test('BG-4 未激活执行上下文时 ITM: 码照常只读查询（不影响普通查询路径）', async () => {
  const { context, calls } = setup('applied');
  mkItemizedOrder(context.state || {}, 'LL20260919001', ['IT-1']);

  vm.runInContext("handleScan('ITM:IT-1')", context);

  assert.equal(vm.runInContext('WIP_EXEC.code', context) || '', '', '执行上下文不应被隐式激活');
  assert.equal(calls.scanItem, 1, '应走只读物品查询');
  assert.equal(calls.enqueue.length, 0, '只读查询零命令');
});
