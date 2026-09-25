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

test('S4 逐件扫码（批量版）：扫码入批 → 提交本批 → 一条 issueBatch 命令 → APPLIED 记进度并推飞书', async () => {
  const { context, document, state, calls } = setup('applied');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  const box = document.getElementById('scanResult');
  context.scanWip('LL20260919001', box);

  await context.wipItemExecScan('IT-1');
  assert.deepEqual(j(w.execItems), [], '扫码只入批，不提交');
  assert.equal(calls.enqueue.length, 0, '扫码时零入队（连扫不撞互斥）');
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), 1, '已入批 1 件');
  assert.match(document.getElementById('scanResult').innerHTML, /已入批/);

  await context.wipItemExecScan('ITM:IT-2');   // ITM: 前缀归一
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), 2);

  await context.wipExecSubmitBatch();          // 提交本批
  assert.equal(calls.enqueue.length, 1, '整批一条命令');
  assert.equal(calls.enqueue[0].kind, 'issueBatch', 'LL 出库 → issueBatch');
  /* TASK-11 S2：出库不再传“假锚点库位”——服务端已把 issueBatch 的 source.loc
     降级为可选兼容字段、逐件由 containerCode 反查（lib/unique-items.js:204-206），
     再传一个 source:{loc} 只会让用户误以为“本批有库位约束”。入库分支保留（:148 的 target）。 */
  assert.deepEqual(j(calls.enqueue[0].source), {}, '出库不带 source.loc（虚锚点已去掉）');
  assert.equal(calls.enqueue[0].items.length, 2);
  assert.deepEqual(j(calls.enqueue[0].items[0]), { itemCode: 'IT-1', containerCode: 'CT-1', expectedItemVersion: 1, expectedContainerVersion: 1 }, '每件带现状派生的双版本');
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2'], 'APPLIED 回执展开记进度');
  assert.match(document.getElementById('scanResult').innerHTML, /2 \/ 3/);
  assert.equal(w.status, '部分执行');
  assert.deepEqual(calls.pushRecord.map(p => String(p.rows[0])), ['LL20260919001'], 'APPLIED 才推飞书');
  assert.equal(state.transactions.length, 0, '铁律：物品化执行不产生库存流水');
  assert.ok(calls.enqueue[0].opId.indexOf('LL20260919001-') === 0, 'opId 以工单号开头（供补记匹配）');
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), 0, '提交后批次清空');
});

test('S4 重复扫（批量版）→ 拒绝重复入批；扫计划外的码 → 拒绝', async () => {
  const { context, document, state, calls } = setup('applied');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  context.scanWip('LL20260919001', document.getElementById('scanResult'));
  await context.wipItemExecScan('IT-1');
  const n = vm.runInContext('WIP_EXEC.batch.length', context);

  await context.wipItemExecScan('IT-1');
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), n, '重复扫不再入批');
  assert.match(document.getElementById('scanResult').innerHTML, /已在本批中/, '卡片要给出重复入批的中文反馈');

  await context.wipItemExecScan('IT-P');
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), n, '计划外的码不入批');
  assert.match(document.getElementById('scanResult').innerHTML, /不属于工单/);
});

test('S4 REJECTED（批量版）：整批标失败不入进度；重扫重提用新 opId', async () => {
  const { context, document, state, calls, mock } = setup('rejected');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  context.scanWip('LL20260919001', document.getElementById('scanResult'));
  await context.wipItemExecScan('IT-1');
  await context.wipExecSubmitBatch();
  assert.deepEqual(j(w.execItems), [], 'REJECTED 不入进度');
  assert.equal(w.status, '未执行');
  const html = document.getElementById('scanResult').innerHTML;
  assert.match(html, /失败|被拒/);
  assert.equal(calls.pushRecord.length, 0, '没有 APPLIED 就不得推工单记录');
  const firstOpId = calls.enqueue[0].opId;

  mock.clientMode = 'applied';
  await context.wipItemExecScan('IT-1');          // REJECTED 后同件可重新入批（旧 opId 已有最终结果）
  await context.wipExecSubmitBatch();
  assert.deepEqual(j(w.execItems), ['IT-1'], '重提 APPLIED 记进度');
  assert.notEqual(calls.enqueue[1].opId, firstOpId, '重提必须用新 opId');
});

test('S4 离线（批量版）：整批入队标「待确认」；APPLIED 回执按 request.items 展开补记', async () => {
  const { context, document, state, calls, mock } = setup('applied');
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  const box = document.getElementById('scanResult');
  context.scanWip('LL20260919001', box);
  await context.wipItemExecScan('IT-1');
  await context.wipItemExecScan('IT-2');
  await context.wipItemExecScan('IT-3');
  assert.deepEqual(j(w.execItems), [], '全在批中未提交');

  /* 提交时离线：批量命令入队但提交失败 → 待确认，不入进度 */
  mock.clientMode = 'offline';
  const pushedBefore = calls.pushRecord.length;
  await context.wipExecSubmitBatch();
  assert.equal(calls.enqueue.length, 1, '离线也要先入本机队列（命令不丢）');
  assert.deepEqual(j(w.execItems), [], '待确认不入进度');
  assert.match(box.innerHTML, /待确认|待提交/);
  assert.equal(calls.pushRecord.length, pushedBefore, '没有新 APPLIED 就不得推工单记录');

  /* 之后联网，在物品页待处理区提交成功 → itemOperations 里出现 APPLIED 回执（批量形状 request.items） */
  const req = calls.enqueue[0];
  state.itemOperations.push({ code: req.opId, phase: 'APPLIED', kind: req.kind, request: JSON.parse(JSON.stringify(req)) });
  mock.clientMode = 'applied';
  context.scanWip('LL20260919001', box);   // 重扫 WIP（或点「同步执行结果」）触发补记
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2', 'IT-3'], 'APPLIED 回执按 request.items 展开补记');
  assert.equal(w.status, '已执行');
  assert.equal(calls.pushRecord.length, pushedBefore + 1, '补记也要推飞书');
  assert.match(box.innerHTML, /已闭环/, '补记完全部 3 件后工单闭环');

  /* 幂等：再触发一次补记不得重复入账 */
  context.scanWip('LL20260919001', box);
  assert.deepEqual(j(w.execItems), ['IT-1', 'IT-2', 'IT-3']);
  assert.ok(w.execBatches.length >= 1, '补记批次入账且不重复');
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
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), 0, '没扫目标不得入批');
  assert.match(box.innerHTML, /目标库位与容器|目标库位/);

  /* 批次首扫目标：LOC/CTN 经 handleScan 路由进目标条 */
  context.handleScan('LOC:L-2');
  context.handleScan('CTN:CT-2');
  assert.deepEqual(j(vm.runInContext('WIP_EXEC.target', context)), { loc: 'L-2', container: 'CT-2' });

  await context.wipItemExecScan('IT-P');
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), 1, '入批（未提交）');
  await context.wipExecSubmitBatch();
  assert.equal(calls.enqueue.length, 1);
  assert.equal(calls.enqueue[0].kind, 'receiveBatch', 'BH 入库 → receiveBatch');
  assert.deepEqual(j(calls.enqueue[0].target), { loc: 'L-2' }, '锚点库位');
  assert.equal(calls.enqueue[0].items[0].containerCode, 'CT-2');
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
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), 1, '入批');

  context.handleScan('IT-2');                 // 裸码（计划内）也喂执行卡
  await tick();
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), 2);

  document.querySelector('#scanResult #btnWipExecExit').click();
  assert.equal(vm.runInContext('WIP_EXEC.code', context), '', '退出执行清上下文');
  assert.equal(vm.runInContext('WIP_EXEC.batch.length', context), 0, '退出清批次');
  context.handleScan('ITM:IT-3');
  await tick();
  assert.equal(calls.scanItem, 1, '退出后 ITM: 恢复走 scanItem 只读查询');
  assert.deepEqual(j(w.execItems), []);
});

