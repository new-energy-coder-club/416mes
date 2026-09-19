'use strict';
/* G1 页面层测试（分组文件，避免同文件内 vm/linkedom 多现场相互干扰）；共享现场见 itemized-ui-helper.cjs */
const test = require('node:test');
const { setup, mkItemizedOrder, chooseWipType, tick, assert, CORE, vm, j } = require('./itemized-ui-helper.cjs');

/* ---------- S7：旧单迁移报表 + normalizeOrder 分流 ---------- */

test('S7 迁移报表：只列未闭环旧 MAT 单（不含物品化单/已闭环单），只读引导取消改建', () => {
  const { context, document, state } = setup();
  mkItemizedOrder(state, 'LL20260919001', ['IT-1']);
  CORE.createOrder(state, { type: 'LL', code: 'LL20260901001', date: '2026-09-01', items: [{ matCode: 'MAT-A', qty: 2 }] });
  const closed = CORE.createOrder(state, { type: 'BH', code: 'BH20260901001', date: '2026-09-01', items: [{ matCode: 'MAT-A', qty: 1 }] }).order;
  CORE.cancelOrder(state, closed, {});

  context.renderWip();
  const panel = document.getElementById('wipMigratePanel');
  assert.notEqual(panel.style.display, 'none', '有未闭环旧单时报表应显示');
  const html = panel.querySelector('#wipMigrateTable tbody').innerHTML;
  assert.match(html, /LL20260901001/);
  assert.doesNotMatch(html, /LL20260919001/, '物品化单不进迁移报表');
  assert.doesNotMatch(html, /BH20260901001/, '已闭环（已取消）旧单不进报表');
  assert.match(document.getElementById('wipMigratePanel').textContent, /取消/);
});

test('S7 normalizeOrder 分流：物品化行不进 normalizeItems（不被丢弃），旧形态照常合并', () => {
  const { context } = setup();
  const w = { code: 'A', type: 'LL', itemized: true, items: [{ itemCodes: ['IT-1', 'IT-2'] }, { itemCodes: ['IT-3'] }] };
  context.normalizeOrder(w);
  assert.deepEqual(j(w.items), [{ itemCodes: ['IT-1', 'IT-2'] }, { itemCodes: ['IT-3'] }], '物品化行必须原样保留');
  assert.deepEqual(j(w.execItems), []);
  assert.deepEqual(j(w.execQty), []);

  /* 飞书下行缓存里没显式 itemized 位、但首行是物品码行 → 同样判物品化并补齐 */
  const w2 = { code: 'B', type: 'LL', items: [{ itemCodes: ['IT-9'] }] };
  context.normalizeOrder(w2);
  assert.equal(w2.itemized, true);
  assert.deepEqual(j(w2.items), [{ itemCodes: ['IT-9'] }]);

  const legacy = { code: 'C', type: 'LL', items: [{ matCode: 'M', qty: 1 }, { matCode: 'M', qty: 2 }, { matCode: 'N', qty: 3 }] };
  context.normalizeOrder(legacy);
  assert.deepEqual(j(legacy.items), [{ matCode: 'M', qty: 3 }, { matCode: 'N', qty: 3 }], '旧形态同物料多行照常合并');
  assert.equal(legacy.itemized, undefined);
});
