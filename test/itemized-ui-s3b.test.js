'use strict';
/* G1 页面层测试（分组文件，避免同文件内 vm/linkedom 多现场相互干扰）；共享现场见 itemized-ui-helper.cjs */
const test = require('node:test');
const { setup, mkItemizedOrder, chooseWipType, tick, assert, CORE, vm, j } = require('./itemized-ui-helper.cjs');

/* ---------- S3：建单抽屉 ---------- */

test('S3 抽屉同码重复 / 未建档 → 拒绝建单并回收占号', async () => {
  const { context, document, state, calls } = setup();
    chooseWipType(document, 'LL');
    const tb = document.querySelector('#wipItemTable tbody');
    ['IT-1', 'IT-1'].forEach(c => {
      const tr = context.wipItemCodeRow();
      tb.appendChild(tr);
      tr.querySelector('.wiItemCode').value = c;
    });
    document.getElementById('btnGenWip').click();
    await tick();
    assert.equal(state.workorders.length, 0);
    assert.ok(calls.alerts.some(a => /重复/.test(a) && /IT-1/.test(a)), JSON.stringify(calls.alerts));
    assert.equal(state.serials['LL20260919'], 6, '占号应回收到取号前的本地值');
    calls.alerts.length = 0;
    tb.innerHTML = '';
    ['IT-1', 'GHOST'].forEach(c => {
      const tr = context.wipItemCodeRow();
      tb.appendChild(tr);
      tr.querySelector('.wiItemCode').value = c;
    });
    document.getElementById('btnGenWip').click();
    await tick();
    assert.equal(state.workorders.length, 0);
    assert.ok(calls.alerts.some(a => /物品未建档/.test(a) && /GHOST/.test(a)));
});



/* ---------- S3：列表 / 搜索双形态 ---------- */

test('S3 renderWip：物品化进度=已扫/总件数；旧 MAT 单挂「物料工单（历史）」徽标；双形态搜索', () => {
  const { context, document, state } = setup();
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  const built = CORE.buildItemExecCommands(state, w, ['IT-1', 'IT-2'], {});
  CORE.applyItemExecResult(state, w, built.ops.map(o => ({ ...o, phase: 'APPLIED' })), { operator: '甲' });
  CORE.createOrder(state, { type: 'LL', code: 'LL20260901001', date: '2026-09-01', items: [{ matCode: 'MAT-A', qty: 2 }] });
  context.renderWip();
  let html = document.querySelector('#wipTable tbody').innerHTML;
  assert.match(html, /2 \/ 3/, '物品化单进度 = 已扫件数/总件数');
  const legacyRow = [...document.querySelectorAll('#wipTable tbody tr')].find(tr => tr.textContent.includes('LL20260901001'));
  assert.match(legacyRow.innerHTML, /物料工单（历史）/);
  const itemizedRow = [...document.querySelectorAll('#wipTable tbody tr')].find(tr => tr.textContent.includes('LL20260919001'));
  assert.doesNotMatch(itemizedRow.innerHTML, /物料工单（历史）/);

  const search = document.getElementById('wipSearch');
  const rowCount = () => document.querySelectorAll('#wipTable tbody tr').length;
  search.value = 'IT-3'; context.renderWip();
  assert.equal(rowCount(), 1, '按物品码搜到物品化单');
  search.value = '件1'; context.renderWip();
  assert.equal(rowCount(), 1, '按物品名搜到物品化单');
  search.value = 'MAT-A'; context.renderWip();
  assert.equal(rowCount(), 1, '旧形态仍按物料码可搜');
  assert.match(document.querySelector('#wipTable tbody').innerHTML, /LL20260901001/);
  search.value = '角钢'; context.renderWip();
  assert.equal(rowCount(), 1, '旧形态仍按物料名可搜');
  search.value = ''; context.renderWip();
  assert.equal(rowCount(), 2);
});

/* ---------- S3：详情双形态 + 旧单只读裁剪 ---------- */

test('S3 详情：物品化单逐件 ✓/✗ + 有「去扫码执行」；旧 MAT 单裁剪执行/编辑/冲销、保留取消/删除', () => {
  const { context, document, state } = setup();
  const w = mkItemizedOrder(state, 'LL20260919001', ['IT-1', 'IT-2', 'IT-3']);
  const built = CORE.buildItemExecCommands(state, w, ['IT-1'], {});
  CORE.applyItemExecResult(state, w, [{ ...built.ops[0], phase: 'APPLIED' }], { operator: '甲' });
  CORE.createOrder(state, { type: 'BH', code: 'BH20260901001', date: '2026-09-01', items: [{ matCode: 'MAT-A', qty: 2 }] });
  /* 部分执行过的旧单：验证连「冲销」也被裁掉 */
  const legacyPart = CORE.createOrder(state, { type: 'LL', code: 'LL20260902001', date: '2026-09-02', items: [{ matCode: 'MAT-A', qty: 2 }] }).order;
  CORE.executeOrder(state, legacyPart, { execQtyByCode: { 'MAT-A': 1 }, operator: '甲' });
  context.showWipDetail('LL20260919001');
  let html = document.getElementById('wipDetail').innerHTML;
  assert.match(html, /物品逐件扫码（已扫 1 \/ 3）/);
  assert.match(html, /IT-1[\s\S]*?✓ 已扫/);
  assert.match(html, /不产生库存流水/, '物品化单应说明没有库存流水');
  assert.ok(document.querySelector('#wipDetail #btnWipExec'), '物品化单保留「去扫码执行」');
  assert.equal(document.querySelector('#wipDetail #btnWipEditPlan'), null, '物品化单不出「编辑计划」（旧物料形态功能）');

  context.showWipDetail('BH20260901001');
  html = document.getElementById('wipDetail').innerHTML;
  assert.match(html, /物料工单（历史）/);
  assert.equal(document.querySelector('#wipDetail #btnWipExec'), null, '旧 MAT 单隐藏「去扫码执行」');
  assert.equal(document.querySelector('#wipDetail #btnWipEditPlan'), null, '旧 MAT 单隐藏「编辑计划」');
  assert.equal(document.querySelector('#wipDetail #btnWipReverse'), null);
  assert.ok(document.querySelector('#wipDetail #btnWipCancel'), '旧 MAT 单保留「取消」');
  assert.ok(document.querySelector('#wipDetail #btnWipDelete'), '旧 MAT 单保留「删除」');

  context.showWipDetail('LL20260902001');
  assert.equal(document.querySelector('#wipDetail #btnWipReverse'), null, '部分执行过的旧 MAT 单也隐藏「冲销」');
  assert.ok(document.querySelector('#wipDetail #btnWipDelete'), '仍保留「删除」入口（点击时走原有守卫）');
});
