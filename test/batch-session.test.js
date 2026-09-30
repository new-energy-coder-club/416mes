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

/* v3.13.36（去锚点批量）：批量=单行三步流的批量壳——每件独立扫 LOC→CTN→ITM
   （子位库位自动两步），件间无关系、可不同库位；行满自动开新行；全部扫完一次提交。
   锚点机制整个移除：批量扫码路由与单行共用 acceptParsed（单一事实源）。 */

test('S1 逐件三步流：LOC→CTN→ITM 成第一行，行满自动开新行，第二件重扫三步且可换库位', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  s.setBatchQty(5);
  assert.match(s.acceptBatchCode({ type: 'LOC', code: 'L-1' }).text, /请扫容器/);
  assert.match(s.acceptBatchCode({ type: 'CTN', code: 'C-1' }).text, /请扫物品/);
  assert.match(s.acceptBatchCode({ type: 'ITM', code: 'I-1' }).text, /第 1 件/);
  /* 行满 → 自动开新行；第二件完整重扫三步，换库位/容器（件间无关系） */
  assert.match(s.acceptBatchCode({ type: 'LOC', code: 'L-2' }).text, /请扫容器/);
  assert.match(s.acceptBatchCode({ type: 'CTN', code: 'C-2' }).text, /请扫物品/);
  assert.match(s.acceptBatchCode({ type: 'ITM', code: 'I-2' }).text, /第 2 件/);
  const snap = s.snapshot();
  const rows = snap.rows.filter(r => r.values.some(v => v.type === 'ITM'));
  assert.equal(rows.length, 2, '两件各占一行');
  assert.deepEqual(rows[0].values.map(v => v.type + v.code), ['LOCL-1', 'CTNC-1', 'ITMI-1'], '第一行是完整标准行');
  assert.deepEqual(rows[1].values.map(v => v.type + v.code), ['LOCL-2', 'CTNC-2', 'ITMI-2'], '第二件可不同库位');
  s.select(snap.rows.indexOf(rows[0]));
  const q = s.request();
  assert.equal(q.kind, 'receive', '行即标准 receive 行（S5：request 零改动）');
  assert.deepEqual(q.target, { loc: 'L-1', container: 'C-1' });
});

test('S2 容器归属校验：扫了不在当前行库位的容器 → 拒绝（单行同款逐字比对）', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  s.setBatchQty(3);
  s.acceptBatchCode({ type: 'LOC', code: 'L-1' });
  assert.throws(() => s.acceptBatchCode({ type: 'CTN', code: 'C-2' }), /归属不符/);
});

test('S3 步骤顺序错 → 单行同款拒绝（相机卡/手输/placeholder 三通道同一事实源：当前行 stepsFor）', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  s.setBatchQty(3);
  assert.throws(() => s.acceptBatchCode({ type: 'CTN', code: 'C-1' }), /当前请扫描LOC码/);
  s.acceptBatchCode({ type: 'LOC', code: 'L-1' });
  assert.throws(() => s.acceptBatchCode({ type: 'LOC', code: 'L-2' }), /当前请扫描CTN码/);
});

test('S4 重复物品软忽略（全批已入批查重，照旧）；已在库物品拒绝', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  s.setBatchQty(3);
  s.acceptBatchCode({ type: 'LOC', code: 'L-1' });
  s.acceptBatchCode({ type: 'CTN', code: 'C-1' });
  s.acceptBatchCode({ type: 'ITM', code: 'I-1' });
  assert.equal(s.acceptBatchCode({ type: 'ITM', code: 'I-1' }).duplicate, true, '全批查重软忽略');
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-3' }), /已在库/);
});

test('S5 数量先行：未设数量拒扫；表单全部填齐后拒再扫（引导「提交本批」）', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  assert.throws(() => s.acceptBatchCode({ type: 'LOC', code: 'L-1' }), /请先输入本批数量/);
  s.setBatchQty(1);
  s.acceptBatchCode({ type: 'LOC', code: 'L-1' });
  s.acceptBatchCode({ type: 'CTN', code: 'C-1' });
  s.acceptBatchCode({ type: 'ITM', code: 'I-1' });
  assert.throws(() => s.acceptBatchCode({ type: 'LOC', code: 'L-2' }), /已全部填齐——请点「提交本批」/);
});

test('S6 stopBatch 后可重新开始；startBatch 只收 receive/issue', () => {
  const s = mk(mkState());
  s.startBatch('receive');
  s.stopBatch();
  assert.equal(s.batchState(), null);
  assert.throws(() => s.startBatch('transfer'), /不支持的批量类型/);
  assert.throws(() => s.acceptBatchCode({ type: 'ITM', code: 'I-1' }), /不在批量模式/);
});

test('S7 旧锚点草稿恢复：restore 剥 batch.anchor/_loc，保留 kind/targetQty 与 rows（方案 S4 零数据丢失）', () => {
  const s = mk(mkState());
  s.restore({ sessionId: 'legacy-1', active: 0,
    batch: { kind: 'receive', anchor: { loc: 'L-1', ctn: 'C-1', ctnVersion: 3 }, _loc: { code: 'L-1' }, targetQty: 2 },
    rows: [
      { rowId: 'r1', kind: 'receive', generation: 1, locked: false, opId: null, values: [{ type: 'LOC', code: 'L-1', version: 0 }, { type: 'CTN', code: 'C-1', version: 3 }] }
    ] });
  assert.deepEqual(s.batchState(), { kind: 'receive', targetQty: 2 }, 'anchor/_loc 已剥、kind/targetQty 原样保留');
  const rows = s.snapshot().rows;
  assert.equal(rows.length, 1, '行保留');
  assert.deepEqual(rows[0].values.map(v => v.type + v.code), ['LOCL-1', 'CTNC-1'], '已扫值原样保留');
  /* 恢复后可继续按当前行 stepsFor 逐件扫码（未满行直接续扫） */
  assert.match(s.acceptBatchCode({ type: 'ITM', code: 'I-1' }).text, /第 1 件/);
});

test('S8 出库批量：首件即开行（无锚点派生），跨库位件可入批（TASK-06 语义保持）', () => {
  const s = mk(mkState());
  s.startBatch('issue');
  s.setBatchQty(3);
  const r1 = s.acceptBatchCode({ type: 'ITM', code: 'I-3' });
  assert.match(r1.text, /已入批（第 1 件）/);
  assert.ok(r1.text.includes('L-1'), '现状展示仍可读');
  assert.ok(r1.text.includes('出库不限库位'), '不再宣称后续件须同库位');
  const r2 = s.acceptBatchCode({ type: 'ITM', code: 'I-4' });
  assert.match(r2.text, /第 2 件/, '异库位件也可入批（TASK-06 跨库位混拣）');
  const rows = s.snapshot().rows.filter(r => r.values.some(v => v.type === 'ITM'));
  assert.equal(rows.length, 2, '每件独立一行');
});
