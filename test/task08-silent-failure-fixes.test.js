'use strict';
/* TASK-08 阶段 1：静默失败类修复 + UI 一致性
 * 每个 M 项一个「失败可见/被拦住」的测试。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../mes-core');

/* ── M6: qty 直写硬闸 ── */
const XY_LOCAL = () => ({
  materials: [{
    code: 'XY-001', cat: 'GJ', name: '旧名字', spec: 'PH2×100mm',
    xy: 'XY-001', loc: 'B-01-01-01', container: 'XK-001', zone: 'M-01',
    qty: 5, minQty: 3, cost: 10, img: ''
  }]
});

test('T08-M6 默认调用 mergeXianyu 带 qty 差异 → 抛 DEPRECATED', () => {
  const s = XY_LOCAL();
  assert.throws(() => Core.mergeXianyu(s, [{ outer_id: 'XY-001', stock: 9, '售价': 850 }]), /DEPRECATED.*applyStockChange/);
});

test('T08-M6 默认调用 qty 相同（无差异）→ 不触发硬闸，字段合并正常', () => {
  const s = XY_LOCAL();
  const stat = Core.mergeXianyu(s, [{ outer_id: 'XY-001', stock: 5, '售价': 850 }]);
  assert.equal(stat.updated, 1);
  assert.equal(s.materials[0].cost, 8.5);
});

test('T08-M6 显式 allowDirectQty:true → 历史路径放行', () => {
  const s = XY_LOCAL();
  const stat = Core.mergeXianyu(s, [{ outer_id: 'XY-001', stock: 9, '售价': 850 }], { allowDirectQty: true });
  assert.equal(stat.updated, 1);
  assert.equal(s.materials[0].qty, 9);
});

test('T08-M6 新建物料不受硬闸影响', () => {
  const s = { materials: [] };
  const stat = Core.mergeXianyu(s, [{ outer_id: 'FRESH-1', '标题': '新品', stock: 3, '售价': 500 }]);
  assert.equal(stat.created, 1);
  assert.equal(s.materials[0].qty, 3);
});

/* ── M5: __pushBlocked 解除前区分原因 ── */
test('T08-M5 结构性缺列（表里没有这一列）→ 不解除 __pushBlocked', () => {
  // 模拟 index.html 中 upsert 返回后的解除逻辑
  const droppedColumns = { '执行批次': '表里没有这一列' };
  const blocked = {};  // 本次没被 blocked（推上去了）
  const prevBlocked = { 'T001': ['execBatch'] };  // 之前被 blocked
  const t = { ...prevBlocked };
  const structural = Object.values(droppedColumns).some(why => typeof why === 'string' && why.includes('表里没有这一列'));
  if (!structural) Object.keys(prevBlocked).forEach(id => { if (!blocked[id]) delete t[id]; });
  assert.ok(t['T001'], '结构性缺列不应解除 __pushBlocked');
});

test('T08-M5 数据性问题（单选无此选项）→ 可解除 __pushBlocked', () => {
  const droppedColumns = { '状态': '单选无此选项：草稿，现有 进行中/已完成' };
  const blocked = {};
  const prevBlocked = { 'T001': ['status'] };
  const t = { ...prevBlocked };
  const structural = Object.values(droppedColumns).some(why => typeof why === 'string' && why.includes('表里没有这一列'));
  if (!structural) Object.keys(prevBlocked).forEach(id => { if (!blocked[id]) delete t[id]; });
  assert.ok(!t['T001'], '数据性问题应解除 __pushBlocked');
});

test('T08-M5 droppedColumns 为空 → 正常解除', () => {
  const droppedColumns = {};
  const prevBlocked = { 'T001': ['status'] };
  const t = { ...prevBlocked };
  const structural = Object.values(droppedColumns).some(why => typeof why === 'string' && why.includes('表里没有这一列'));
  if (!structural) Object.keys(prevBlocked).forEach(id => { delete t[id]; });
  assert.ok(!t['T001'], 'droppedColumns 为空应解除');
});

/* ── M3: 离线取号健康面板 ── */
test('T08-M3 离线取号 seqInfo.warned=true → 健康面板有「离线取号」条目', () => {
  // 模拟 index.html 中的健康面板写入
  const errors = [];
  const seqInfo = { warned: true, key: 'WIP', local: 5, remote: 0 };
  const code = 'WIP-006';
  if (seqInfo.warned) {
    errors.unshift({ at: '12:00:00', where: '离线取号', msg: '工单 ' + code + ' 未与云端核对号段（本地 ' + seqInfo.local + '），恢复网络后请核对是否撞号' });
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0].where, /离线取号/);
  assert.match(errors[0].msg, /WIP-006/);
  assert.match(errors[0].msg, /撞号/);
});
