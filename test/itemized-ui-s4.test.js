'use strict';
/* G1 页面层测试（分组文件，避免同文件内 vm/linkedom 多现场相互干扰）；共享现场见 itemized-ui-helper.cjs */
const test = require('node:test');
const { setup, mkItemizedOrder, chooseWipType, tick, assert, CORE, vm, j } = require('./itemized-ui-helper.cjs');

/* ---------- S4：扫码执行卡 ---------- */

test('S4 扫 WIP 进物品化执行卡：已扫 x/y + 未扫清单 + 逐行 ✓/✗ + 顶部「正在执行/退出执行」', () => {
  const { context, document, state } = setup();
  mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  const box = document.getElementById('scanResult');
  context.scanWip('LL20260919001', box);
  const html = box.innerHTML;
  assert.match(html, /已扫/);
  assert.match(html, /0 \/ 3/);
  assert.match(html, /未扫清单/);
  assert.match(html, /正在执行 LL20260919001/);
  assert.match(html, /退出执行/);
  assert.ok(document.querySelector('#scanResult #wipExecItemInput'), '执行卡有物品码输入');
  assert.equal(box.querySelectorAll('tbody tr').length, 3, '逐行列出全部计划物品');
  assert.equal(vm.runInContext('WIP_EXEC.code', context), 'LL20260919001', '执行上下文应激活');
});

test('S4 逐件扫码 2/3：ITM: 前缀归一 → 校验 → 入队 → 提交 APPLIED 才记进度并推飞书', async () => {
  const { context, document, state, calls } = setup('applied');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  const box = document.getElementById('scanResult');
  context.scanWip('LL20260919001', box);

  await context.wipItemExecScan('IT-1');
  assert.deepEqual(j(w.execItems), ['IT-1']);
  assert.equal(calls.enqueue.length, 1);
  assert.equal(calls.enqueue[0].kind, 'issue', 'LL 出库 → issue 命令');
  assert.deepEqual(j(calls.enqueue[0].source), { loc: 'L-1', container: 'CT-1' }, '出库按档案位置，不扫位置');
  assert.match(document.getElementById('scanResult').innerHTML, /1 \/ 3/);
  assert.equal(w.status, '部分执行');

  await context.wipItemExecScan('ITM:IT-2');   // ITM: 前缀归一
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2']);
  assert.match(document.getElementById('scanResult').innerHTML, /2 \/ 3/);
  /* APPLIED 才推飞书：建单 0 次（本测试走 core 直建）+ 两次执行各 1 次 */
  assert.deepEqual(calls.pushRecord.map(p => String(p.rows[0])), ['LL20260919001', 'LL20260919001']);
  assert.equal(state.transactions.length, 0, '铁律：物品化执行不产生库存流水');
  const opIds = calls.enqueue.map(r => r.opId);
  assert.ok(opIds.every(id => id.indexOf('LL20260919001-') === 0), 'opId 以工单号开头（供补记匹配）');
});

test('S4 重复扫同一件 → 拒绝，不再入队、不进进度；扫计划外的码 → 拒绝', async () => {
  const { context, document, state, calls } = setup('applied');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  context.scanWip('LL20260919001', document.getElementById('scanResult'));
  await context.wipItemExecScan('IT-1');
  const n = calls.enqueue.length;

  await context.wipItemExecScan('IT-1');
  assert.equal(calls.enqueue.length, n, '重复扫不再产生新命令');
  assert.deepEqual(j(w.execItems), ['IT-1']);
  assert.match(document.getElementById('scanResult').innerHTML, /已扫过/, '卡片要给出重复扫的中文反馈');

  await context.wipItemExecScan('IT-P');
  assert.equal(calls.enqueue.length, n, '计划外的码不入队');
  assert.match(document.getElementById('scanResult').innerHTML, /不属于工单/);
});

test('S4 REJECTED：标「失败」不入进度，中文错误；同件可重扫（新 opId）', async () => {
  const { context, document, state, calls, mock } = setup('rejected');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  context.scanWip('LL20260919001', document.getElementById('scanResult'));
  await context.wipItemExecScan('IT-1');
  assert.deepEqual(j(w.execItems), [], 'REJECTED 不入进度');
  assert.equal(w.status, '未执行');
  const html = document.getElementById('scanResult').innerHTML;
  assert.match(html, /失败/);
  assert.match(html, /当前状态不允许该操作/, 'INVALID_TRANSITION 要翻成中文');
  assert.equal(calls.pushRecord.length, 0, '没有 APPLIED 就不得推工单记录');

  mock.clientMode = 'applied';
  await context.wipItemExecScan('IT-1');
  assert.deepEqual(j(w.execItems), ['IT-1'], 'REJECTED 后同件可重扫');
  assert.notEqual(calls.enqueue[0].opId, calls.enqueue[1].opId, '重扫必须用新 opId（旧 opId 已有最终结果）');
});

test('S4 离线：命令入队标「待确认」不入进度；提交后 APPLIED 回执自动补记', async () => {
  const { context, document, state, calls, mock } = setup('applied');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  const box = document.getElementById('scanResult');
  context.scanWip('LL20260919001', box);
  await context.wipItemExecScan('IT-1');
  await context.wipItemExecScan('IT-2');
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2'], '先在线扫 2/3');

  /* 第 3 件扫的时候离线：命令入队但提交失败 → 待确认，不入进度 */
  mock.clientMode = 'offline';
  const pushedBefore = calls.pushRecord.length;
  await context.wipItemExecScan('IT-3');
  assert.equal(calls.enqueue.length, 3, '离线也要先入本机队列（命令不丢）');
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2'], '待确认不入进度');
  assert.match(box.innerHTML, /待确认|待提交/);
  assert.equal(calls.pushRecord.length, pushedBefore, '没有新 APPLIED 就不得推工单记录');

  /* 之后联网，在物品页待处理区提交成功 → itemOperations 里出现 APPLIED 回执 */
  const req = calls.enqueue[2];
  state.itemOperations.push({ code: req.opId, phase: 'APPLIED', kind: req.kind, request: JSON.parse(JSON.stringify(req)) });
  mock.clientMode = 'applied';
  context.scanWip('LL20260919001', box);   // 重扫 WIP（或点「同步执行结果」）触发补记
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2', 'IT-3'], 'APPLIED 回执按 opId 幂等补记进进度');
  assert.equal(w.status, '已执行');
  assert.equal(calls.pushRecord.length, pushedBefore + 1, '补记也要推飞书');
  assert.match(box.innerHTML, /已闭环/, '补记完全部 3 件后工单闭环');

  /* 幂等：再触发一次补记不得重复入账 */
  context.scanWip('LL20260919001', box);
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2', 'IT-3']);
  assert.equal(w.execBatches.length, 3, '三个批次（含补记批次），不重复入账');
});

test('S4 BH 入库方向：每批次先扫一次目标库位+容器（复用），缺目标不执行', async () => {
  const { context, document, state, calls } = setup('applied');
  state.items[3].status = 'pending';   // IT-P 待入库
  const w = mkItemizedOrder(state, 'BH20260919001', ['IT-P'], { type: 'BH' });
  const box = document.getElementById('scanResult');
  context.scanWip('BH20260919001', box);
  assert.ok(document.querySelector('#scanResult #wipExecTargetLoc'), '入库方向要有目标库位输入');
  assert.ok(document.querySelector('#scanResult #wipExecTargetCtn'));

  await context.wipItemExecScan('IT-P');
  assert.equal(calls.enqueue.length, 0, '没扫目标不得构造命令');
  assert.match(box.innerHTML, /目标库位与容器|目标库位/);

  /* 批次首扫目标：LOC/CTN 经 handleScan 路由进目标条 */
  context.handleScan('LOC:L-2');
  context.handleScan('CTN:CT-2');
  assert.deepEqual(j(vm.runInContext('WIP_EXEC.target', context)), { loc: 'L-2', container: 'CT-2' });

  await context.wipItemExecScan('IT-P');
  assert.equal(calls.enqueue.length, 1);
  assert.equal(calls.enqueue[0].kind, 'receive', 'BH 入库 → receive 命令');
  assert.deepEqual(j(calls.enqueue[0].target), { loc: 'L-2', container: 'CT-2' });
  assert.deepEqual(j(w.execItems), ['IT-P']);
  assert.equal(state.transactions.length, 0, '铁律：入库方向同样不产生库存流水');
});

test('S4 执行上下文：激活时物品码喂执行卡（不走路由 scanItem）；退出后恢复只读查询', async () => {
  const { context, document, state, calls } = setup('applied');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  const box = document.getElementById('scanResult');
  context.handleScan('WIP:LL20260919001');   // 经统一入口进执行卡
  assert.equal(vm.runInContext('WIP_EXEC.code', context), 'LL20260919001');

  context.handleScan('ITM:IT-1');
  await tick();
  assert.equal(calls.scanItem, 0, '执行上下文激活时不得走 scanItem 只读查询');
  assert.deepEqual(j(w.execItems), ['IT-1']);

  context.handleScan('IT-2');                 // 裸码（计划内）也喂执行卡
  await tick();
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2']);

  document.querySelector('#scanResult #btnWipExecExit').click();
  assert.equal(vm.runInContext('WIP_EXEC.code', context), '', '退出执行清上下文');
  context.handleScan('ITM:IT-3');
  await tick();
  assert.equal(calls.scanItem, 1, '退出后 ITM: 恢复走 scanItem 只读查询');
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2']);
});

