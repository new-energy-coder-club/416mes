'use strict';
/* 2.97.0 Phase 1（锚点批量）：会话模型批量模式层测试 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Scan = require('../lib/item-scan');
const U = require('../lib/unique-items');

function mkState() {
  const st = {
    locations: [{ code: 'L-1', status: 'active' }, { code: 'L-2', status: 'active' }],
    containers: [
      { code: 'C-1', loc: 'L-1', status: 'active', version: 3 },
      { code: 'C-2', loc: 'L-2', status: 'active', version: 5 }
    ],
    items: [
      { code: 'I-1', status: 'pending', container: '', version: 0 },
      { code: 'I-2', status: 'pending', container: '', version: 0 },
      { code: 'I-3', status: 'in_stock', container: 'C-1', version: 2 },
      { code: 'I-4', status: 'in_stock', container: 'C-2', version: 2 }
    ],
    itemOperations: []
  };
  U.migrate(st);
  return st;
}
const mk = st => Scan.create({ getState: () => st, id: () => Math.random().toString(36).slice(2) });

test('S1 入库锚点批量：LOC→CTN 锚定 → 连扫合成完整行', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  assert.match(s.acceptBatchCode({ type: 'LOC', code: 'L-1' }).text, /库位锚点/);
  assert.match(s.acceptBatchCode({ type: 'CTN', code: 'C-1' }).text, /开始连扫/);
  assert.match(s.acceptBatchCode({ type: 'ITM', code: 'I-1' }).text, /第 1 件/);
  assert.match(s.acceptBatchCode({ type: 'ITM', code: 'I-2' }).text, /第 2 件/);
  const rows = s.snapshot().rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].values.map(v => v.type + v.code), ['LOCL-1', 'CTNC-1', 'ITMI-1'], '合成行是完整行');
  s.select(0);
  const q = s.request();
  assert.equal(q.kind, 'receive', '合成行可直接 request（草稿兼容）');
});

test('S2 容器归属校验：扫了不在锚点库位的容器 → 拒绝', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  s.acceptBatchCode({ type: 'LOC', code: 'L-1' });
  assert.throws(() => s.acceptBatchCode({ type: 'CTN', code: 'C-2' }), /归属不符/);
});

test('S3 锚点阶段顺序错 → 拒绝；锚点已定再扫 LOC → 引导', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  assert.throws(() => s.acceptBatchCode({ type: 'CTN', code: 'C-1' }), /先扫库位/);
  s.acceptBatchCode({ type: 'LOC', code: 'L-1' });
  assert.throws(() => s.acceptBatchCode({ type: 'LOC', code: 'L-2' }), /库位锚点已定/);
});

test('S4 重复物品静默忽略；已在库物品拒绝', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  s.acceptBatchCode({ type: 'LOC', code: 'L-1' });
  s.acceptBatchCode({ type: 'CTN', code: 'C-1' });
  s.acceptBatchCode({ type: 'ITM', code: 'I-1' });
  assert.equal(s.acceptBatchCode({ type: 'ITM', code: 'I-1' }).duplicate, true);
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-3' }), /已在库/);
});

test('S5 出库批量：首件派生锚点、异库位件拒绝', () => {
  const s = mk(mkState());
  s.startBatch('issue');
  assert.match(s.acceptBatchCode({ type: 'ITM', code: 'I-3' }).text, /锚点库位 L-1 已派生/);
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-4' }), /不在本批库位/);
});

test('S6 stopBatch 后可重新开始；startBatch 只收 receive/issue', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  s.stopBatch();
  assert.equal(s.batchState(), null);
  assert.throws(() => s.startBatch('transfer'), /不支持的批量类型/);
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-1' }), /不在批量模式/);
});
