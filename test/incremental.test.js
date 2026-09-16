'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Inc = require('../lib/incremental.js');

const TS = '最后更新时间', ID = 'record_id';
const rec = (id, ts) => ({ record_id: id, 最后更新时间: ts });

/* ================= 水位 ================= */

test('增量·水位【关键】同一毫秒并列记录不能漏（只用时间戳必然漏）', () => {
  let wm = Inc.createWatermark();
  const page1 = [rec('a', 1000)];
  wm = Inc.advanceWatermark(wm, page1, TS, ID);
  assert.equal(wm.ts, 1000);
  assert.deepEqual(wm.seen, ['a']);

  // 同一毫秒的 b 还没拉过 → 必须仍被认为是新的
  assert.equal(Inc.isRecordNewer(rec('b', 1000), TS, ID, wm), true, '同毫秒未见过的 id 必须算新');
  assert.equal(Inc.isRecordNewer(rec('a', 1000), TS, ID, wm), false, '同毫秒已见过的 id 不算新');

  wm = Inc.advanceWatermark(wm, [rec('b', 1000)], TS, ID);
  assert.deepEqual(wm.seen.sort(), ['a', 'b']);
  assert.equal(Inc.isRecordNewer(rec('b', 1000), TS, ID, wm), false);

  // ts 前进后旧的 seen 作废
  wm = Inc.advanceWatermark(wm, [rec('c', 2000)], TS, ID);
  assert.equal(wm.ts, 2000);
  assert.deepEqual(wm.seen, ['c']);
});

test('增量·水位：更早的记录永远不算新', () => {
  const wm = { ts: 5000, seen: ['x'] };
  assert.equal(Inc.isRecordNewer(rec('y', 4999), TS, ID, wm), false);
  assert.equal(Inc.isRecordNewer(rec('y', 5001), TS, ID, wm), true);
});

test('增量·水位：filterNewer 保持原顺序且只留新的', () => {
  const wm = { ts: 100, seen: [] };
  const out = Inc.filterNewer([rec('old', 50), rec('n1', 200), rec('n2', 150)], TS, ID, wm);
  assert.deepEqual(out.map(r => r.record_id), ['n1', 'n2']);
});

test('增量·水位：缺系统字段/非数字一律按 0 处理，不抛错', () => {
  const wm = { ts: 100, seen: [] };
  assert.equal(Inc.isRecordNewer({ record_id: 'z' }, TS, ID, wm), false);
  assert.equal(Inc.isRecordNewer(null, TS, ID, wm), false);
  assert.equal(Inc.tsOf({ 最后更新时间: { value: 999 } }, TS), 999, '兼容 {value} 形状');
});

/* ================= 翻页停止 ================= */

test('增量·翻页：整页都早于水位才停（同毫秒边界那几条不能被切掉）', () => {
  const wm = { ts: 1000, seen: ['a'] };
  // 页内 desc：最后一条 ts=1000 等于水位 → 不能停（可能还有同毫秒未见的）
  assert.equal(Inc.shouldStopPaging([rec('n', 1200), rec('a', 1000)], TS, wm), false);
  // 最后一条严格早于水位 → 整页都是旧的，可以停
  assert.equal(Inc.shouldStopPaging([rec('a', 1000), rec('old', 900)], TS, wm), true);
  assert.equal(Inc.shouldStopPaging([], TS, wm), true, '空页必须停，否则无限翻页');
});

test('增量·翻页：短页直接停（不为「确认到底有没有」多打一次空请求）', () => {
  const wm = { ts: 0, seen: [] };
  assert.equal(Inc.shouldStopPaging([rec('a', 500)], TS, wm, 500), true, '1 < 500 是短页');
  assert.equal(Inc.shouldStopPaging(Array.from({ length: 500 }, (_, i) => rec('r' + i, 500 - i)), TS, wm, 500), false, '满页要继续翻');
});

test('增量·翻页【核心】1000 条流水、水位在 #900 时只需 1 页', () => {
  // 服务端按 desc 返回，一页 500
  const all = Array.from({ length: 1000 }, (_, i) => rec('r' + (1000 - i), 1000 + (1000 - i)));
  const wm = { ts: 1000 + 900, seen: ['r900'] };
  const pages = [];
  let cursor = 0, guard = 0;
  while (guard++ < 20) {
    const page = all.slice(cursor, cursor + 500);
    pages.push(page.length);
    if (Inc.shouldStopPaging(page, TS, wm, 500)) break;
    cursor += 500;
  }
  assert.deepEqual(pages, [500], '只应请求 1 页，实测 ' + JSON.stringify(pages));
  const first = all.slice(0, 500);
  const changed = Inc.filterNewer(first, TS, ID, wm);
  assert.equal(changed.length, 100, '只有 #901~#1000 共 100 条是新的');
});

test('增量·翻页：水位很旧时必须一直翻到尽头', () => {
  const all = Array.from({ length: 1200 }, (_, i) => rec('r' + (1200 - i), 1000 + (1200 - i)));
  const wm = { ts: 0, seen: [] };
  let cursor = 0, pages = 0, guard = 0;
  while (guard++ < 20) {
    const page = all.slice(cursor, cursor + 500);
    pages++;
    if (Inc.shouldStopPaging(page, TS, wm, 500)) break;
    cursor += 500;
  }
  assert.equal(pages, 3, '1200 条 / 每页 500 → 需要 3 页，实测 ' + pages);
});

/* ================= 变更探测 ================= */

test('增量·探测：零变化时不认为需要拉取（这样才敢 10 秒轮询）', () => {
  const wm = { ts: 5000, seen: [], total: 340 };
  assert.equal(Inc.probeSaysChanged({ latest: 5000, total: 340 }, wm), false);
  assert.equal(Inc.probeSaysChanged({ latest: 4999, total: 340 }, wm), false);
  assert.equal(Inc.probeSaysChanged({ latest: 5001, total: 340 }, wm), true, '时间戳前进 → 变了');
  assert.equal(Inc.probeSaysChanged({ latest: 5000, total: 341 }, wm), true, '条数变了 → 有增删');
  assert.equal(Inc.probeSaysChanged(null, wm), false);
});

/* ================= 删除三重闸门 ================= */

test('增量·删除【闸门1】census 不完整时删除集必须为空', () => {
  const prev = ['a', 'b', 'c'];
  const r = Inc.censusDecision(prev, ['a'], { complete: false, tableId: 'materials', ledgerConfirmed: true });
  assert.deepEqual(r.deletions, [], '半截扫描绝不能清空现场台账');
  assert.equal(r.reason, 'census-incomplete');
});

test('增量·删除【闸门2】删 3 条自动应用，删 200 条转人工', () => {
  const prev = Array.from({ length: 2000 }, (_, i) => 'k' + i);
  const next3 = prev.filter(k => ['k5', 'k6', 'k7'].indexOf(k) < 0);
  const ok = Inc.censusDecision(prev, next3, { complete: true, tableId: 'materials', ledgerConfirmed: true });
  assert.equal(ok.reason, 'ok');
  assert.deepEqual(ok.deletions.sort(), ['k5', 'k6', 'k7']);

  const next200 = prev.slice(200);   // 少了 200 条 = 10%
  const warn = Inc.censusDecision(prev, next200, { complete: true, tableId: 'materials', ledgerConfirmed: true });
  assert.deepEqual(warn.deletions, [], '超阈值不得自动删');
  assert.equal(warn.reason, 'over-threshold');
  assert.equal(warn.toConfirm.length, 200);
});

test('增量·删除【闸门2】绝对阈值 50 条单独生效（小表也不许一次删太多）', () => {
  const prev = Array.from({ length: 100 }, (_, i) => 'k' + i);   // 5% = 5 条，绝对值 50 更大
  const next = prev.slice(51);                                    // 少 51 条
  const r = Inc.censusDecision(prev, next, { complete: true, tableId: 'materials', ledgerConfirmed: true });
  assert.equal(r.reason, 'over-threshold');
  assert.equal(r.threshold, 50);
});

test('增量·删除【闸门3】主数据必须连续两次完整 census 都缺才自动确认', () => {
  const prev = ['a', 'b', 'c'];
  const first = Inc.censusDecision(prev, ['a', 'b'], { complete: true, tableId: 'materials', ledgerConfirmed: false });
  assert.deepEqual(first.deletions, []);
  assert.equal(first.reason, 'need-second-census');
  const second = Inc.censusDecision(prev, ['a', 'b'], { complete: true, tableId: 'materials', ledgerConfirmed: true });
  assert.deepEqual(second.deletions, ['c']);
});

test('增量·删除【闸门4】流水表不参与删除对账（append-only 台账）', () => {
  const r = Inc.censusDecision(['1', '2', '3'], ['1'], { complete: true, tableId: 'transactions', ledgerConfirmed: true });
  assert.deepEqual(r.deletions, []);
  assert.equal(r.reason, 'append-only-excluded');
});

test('增量·删除：没有缺失时什么也不做', () => {
  const r = Inc.censusDecision(['a', 'b'], ['a', 'b'], { complete: true, tableId: 'locations', ledgerConfirmed: true });
  assert.equal(r.reason, 'none');
  assert.deepEqual(r.deletions, []);
});

/* ================= 增量合并（绝不是全量合并） ================= */

const Core = require('../mes-core.js');

test('增量合并【核心】只带变化行的部分数据，绝不能触发删除判定', () => {
  const st = { materials: [{ code: 'A', name: '甲' }, { code: 'B', name: '乙' }, { code: 'C', name: '丙' }],
               transactions: [], txnSeq: 0, __syncedKeys: { materials: ['A', 'B', 'C'] } };
  // 只有 A 变了，部分数据里只有 A
  const r = Core.applyRemoteChanges(st, { materials: [{ code: 'A', name: '甲改' }] },
    { syncedKeys: st.__syncedKeys });
  assert.equal(st.materials.length, 3, 'B、C 不在增量里，绝不能被当成「飞书删了」');
  assert.equal(st.materials.find(m => m.code === 'A').name, '甲改');
  assert.equal(r.updated, 1);
  assert.equal(r.created, 0);
});

test('增量合并：增量里的新记录会被加入', () => {
  const st = { materials: [{ code: 'A' }], transactions: [], txnSeq: 0 };
  const r = Core.applyRemoteChanges(st, { materials: [{ code: 'A' }, { code: 'NEW', name: '新来的' }] }, {});
  assert.equal(r.created, 1);
  assert.equal(st.materials.length, 2);
  assert.equal(st.materials.find(m => m.code === 'NEW').name, '新来的');
});

test('增量合并：飞书空值不覆盖本地非空值（与全量合并同语义）', () => {
  const st = { materials: [{ code: 'A', name: '本地名', zone: 'M-01' }], transactions: [], txnSeq: 0 };
  Core.applyRemoteChanges(st, { materials: [{ code: 'A', name: '', zone: 'M-01' }] }, {});
  assert.equal(st.materials[0].name, '本地名', '空值不能把本地真值清掉');
});

test('增量合并：protect 名单里的字段以本地为准', () => {
  const st = { workorders: [{ code: 'W1', status: '部分执行' }], transactions: [], txnSeq: 0 };
  Core.applyRemoteChanges(st, { workorders: [{ code: 'W1', status: '未执行' }] },
    { protect: { workorders: { W1: ['status'] } } });
  assert.equal(st.workorders[0].status, '部分执行', '推不上去的字段不能被飞书旧值打回');
});

test('增量合并：未出现在增量里的表完全不动', () => {
  const st = { materials: [{ code: 'A' }], members: [{ code: 'M1', name: '甲' }], transactions: [], txnSeq: 0 };
  Core.applyRemoteChanges(st, { materials: [{ code: 'A', name: 'x' }] }, {});
  assert.equal(st.members.length, 1);
  assert.equal(st.members[0].name, '甲');
});

test('增量合并：流水合并后仍然新的在前、txnSeq 单调递增', () => {
  const st = { transactions: [{ seq: 1, matCode: 'A', delta: 1 }], txnSeq: 1, materials: [] };
  Core.applyRemoteChanges(st, { transactions: [{ seq: 3, matCode: 'A', delta: 1 }, { seq: 2, matCode: 'A', delta: 1 }] }, {});
  assert.deepEqual(st.transactions.map(t => t.seq), [3, 2, 1]);
  assert.equal(st.txnSeq, 3);
});

test('增量合并：syncedKeys 取并集（增量见过的键要并进基线）', () => {
  const st = { materials: [{ code: 'A' }, { code: 'B' }], transactions: [], txnSeq: 0, __syncedKeys: { materials: ['A'] } };
  const r = Core.applyRemoteChanges(st, { materials: [{ code: 'B' }] }, { syncedKeys: st.__syncedKeys });
  assert.deepEqual(r.syncedKeys.materials.sort(), ['A', 'B']);
});

test('增量合并【关键】不修改传入的远端对象（避免共享引用后被本地编辑污染）', () => {
  const st = { materials: [], transactions: [], txnSeq: 0 };
  const remote = { materials: [{ code: 'A', name: '来自网络' }] };
  Core.applyRemoteChanges(st, remote, {});
  st.materials[0].name = '本地改过';
  assert.equal(remote.materials[0].name, '来自网络', 'state 里的对象不能和响应体共享引用');
});

/* ================= 连续两次 census 确认 ================= */

test('增量·删除【闸门3】只认交集：两次缺不同的键不算连续确认', () => {
  assert.equal(Inc.secondCensusConfirms(['a', 'b'], ['a', 'b']), true, '两次都缺同样的键 → 确认');
  assert.equal(Inc.secondCensusConfirms(['a'], ['a', 'b']), false, '这次多缺了 b，b 不是连续确认');
  assert.equal(Inc.secondCensusConfirms(['a', 'b'], ['a']), true, 'a 连续两次都缺');
  assert.equal(Inc.secondCensusConfirms([], ['a']), false, '没有上一次记录 → 不确认');
  assert.equal(Inc.secondCensusConfirms(['a'], []), false, '这次没缺 → 不确认');
});

test('增量·删除【闸门5】已执行 / 已取消工单必须人工裁决', () => {
  const r = Inc.censusDecision(['W1', 'W2'], ['W1'], {
    complete: true, tableId: 'workorders', ledgerConfirmed: true, humanOnly: true
  });
  assert.deepEqual(r.deletions, [], '已执行工单绝不能被自动删掉');
  assert.equal(r.reason, 'needs-human');
  assert.deepEqual(r.toConfirm, ['W2']);
});
