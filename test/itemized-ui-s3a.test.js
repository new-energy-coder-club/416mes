'use strict';
/* G1 页面层测试（分组文件，避免同文件内 vm/linkedom 多现场相互干扰）；共享现场见 itemized-ui-helper.cjs */
const test = require('node:test');
const { setup, mkItemizedOrder, chooseWipType, tick, assert, CORE, vm, j } = require('./itemized-ui-helper.cjs');

/* ---------- S3：建单抽屉 ---------- */

test('S3 抽屉生成物品化工单：沿用 fsNextWorkorderSerial 取号，items 走 itemCodes 形态并推飞书', async () => {
  /* —— 物品码行实时提示（并入本用例，规避 runner 对连续三个 vm/linkedom 现场的挂起） —— */
  {
    const t1 = setup();
    t1.context.refreshItemCodeDatalist();
    const dl = t1.document.getElementById('itemCodeList');
    assert.ok(dl, '应有 itemCodeList datalist');
    assert.equal(dl.querySelectorAll('option').length, 4);
    assert.match(dl.innerHTML, /IT-1/);
    const tr0 = t1.context.wipItemCodeRow();
    t1.document.querySelector('#wipItemTable tbody').appendChild(tr0);
    const inp0 = tr0.querySelector('.wiItemCode');
    const info0 = tr0.querySelector('.wiItemInfo');
    inp0.value = 'IT-1';
    inp0.dispatchEvent(new t1.document.defaultView.Event('input'));
    assert.match(info0.textContent, /✓ 件1/);
    assert.match(info0.textContent, /在库/);
    assert.match(info0.textContent, /CT-1 → L-1/, '应显示 容器 → 库位');
    assert.equal(info0.style.color, '#2d9d4f');
    inp0.value = 'GHOST';
    inp0.dispatchEvent(new t1.document.defaultView.Event('input'));
    assert.match(info0.textContent, /✗ 未在物品档案建档/);
    assert.equal(info0.style.color, '#d33a2c', '未建档必须标红');
  }
  const { context, document, state, calls } = setup();
  chooseWipType(document, 'LL');
  const tb = document.querySelector('#wipItemTable tbody');
  ['IT-1', 'IT-2', 'IT-3'].forEach(c => {
    const tr = context.wipItemCodeRow();
    tb.appendChild(tr);
    tr.querySelector('.wiItemCode').value = c;
  });
  document.getElementById('btnGenWip').click();
  await tick();
  assert.equal(state.workorders.length, 1);
  const w = state.workorders[0];
  assert.equal(w.code, 'LL20260919007', '沿用 类型+日期+流水 取号');
  assert.equal(w.itemized, true);
  assert.deepEqual(j(w.items), [{ itemCodes: ['IT-1'] }, { itemCodes: ['IT-2'] }, { itemCodes: ['IT-3'] }]);
  assert.deepEqual(j(w.execItems), []);
  assert.equal(calls.pushRecord.length, 1, '建单必须写回飞书');
  assert.equal(calls.pushRecord[0].table, 'workorders');
  assert.equal(calls.pushRecord[0].rows[0], 'LL20260919007');
  assert.equal(calls.alerts.length, 0);
  assert.equal(tb.querySelectorAll('tr').length, 0, '成功后明细行清空');

});
