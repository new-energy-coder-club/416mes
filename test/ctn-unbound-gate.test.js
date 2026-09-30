'use strict';
/* 3.13.33（A-9，问题②）：容器-库位从属门控 ctnUnboundGate 的行为锁定。
 * 背景：A-2 纯启用后 containers.loc 退役（新容器恒 ''），旧门禁拿退役字段比对目标库位，
 * 把「刚启用的容器 × 刚启用的库位」全部拦死为「容器与库位归属不符」死端（用户实测
 * B-01-01-03 + SLG-002）。新模型从属唯一落点是 locations.parentContainer 子位标注；
 * 门控只做分类拒绝（Error.code='CTN_LOC_UNBOUND'，detail={kind,ctnCode,locCode}），
 * 绑定由 UI「标注子位并继续」显式确认卡承接，绝不静默放行/改数据。
 * 覆盖：单行/批量四分类（含批量 own_sub 子位锚点转换）、门控抛出后行不被污染、
 * 标注后的单行 rebase 流、verifyLegacy/旧模型容器原契约不变。
 * 夹具库位语义：W00-G01=空闲自由位（unbound 场景）；W01-G01=被 C-A 旧模型占位；
 * W02-G01=被 C-D 旧模型占位。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Scan = require('../lib/item-scan');
const U = require('../lib/unique-items');

function mkState() {
  const st = {
    locations: [
      { code: 'W00-G01', status: 'active' },
      { code: 'W01-G01', status: 'active' },
      { code: 'W02-G01', status: 'active' }
    ],
    containers: [
      { code: 'C-A', loc: 'W01-G01', status: 'active', version: 1, lastOpId: '' },  // 旧模型：已定位
      { code: 'C-D', loc: 'W02-G01', status: 'active', version: 1, lastOpId: '' },  // 旧模型：定位在别处
      { code: 'C-B', loc: '', status: 'active', version: 1, lastOpId: '' },         // 新模型：纯启用未定位
      { code: 'C-N2', loc: '', status: 'active', version: 1, lastOpId: '' }         // 新模型：另一纯启用容器
    ],
    items: [
      { code: 'WP-NEW', name: '新建档', status: 'pending', container: '', version: 1, lastOpId: '' }
    ],
    itemOperations: []
  };
  U.migrate(st);
  return st;
}
const mk = (st, kind) => { const s = Scan.create({ getState: () => st, id: () => 'g-' + Math.random().toString(36).slice(2) }); if (kind) s.add(kind); return s; };
const mkr = st => mk(st, 'receive'); // 单行入口：create 初始无行，必须 add 一次（同 itm-legacy-edge scanOf）
const catchOf = fn => { try { fn(); return null; } catch (e) { return e; } };
const locOf = (st, code) => st.locations.find(l => l.code === code);

/* ---------- 单行（accept）---------- */
test('G1 单行 receive：新模型容器×空闲自由位 → unbound 分类拒绝，行不被污染', () => {
  const st = mkState(), s = mkr(st);
  s.accept('LOC:W00-G01');
  const e = catchOf(() => s.accept('CTN:C-B'));
  assert.ok(e, '必须拒绝（静默放行会被 apply 层 pair 再拒一次）');
  assert.equal(e.code, 'CTN_LOC_UNBOUND');
  assert.deepEqual(e.detail, { kind: 'unbound', ctnCode: 'C-B', locCode: 'W00-G01' });
  assert.match(e.message, /尚未建立从属/);
  /* 门控在 values.push 之前抛：values 仍只有 LOC，generation 不变 → 后续 rebase 零改行 */
  assert.equal(s.row().values.length, 1);
  assert.equal(s.row().values[0].code, 'W00-G01');
  assert.equal(s.row().generation, 0);
});
test('G2 单行：LOC 已扫后镜像才翻转子位（竞态）→ stepsFor 动态分流，CTN 文本被拒「当前请扫描ITM码」，直接扫 ITM 走子位直存', () => {
  const st = mkState(), s = mkr(st);
  s.accept('LOC:W00-G01'); /* 扫 LOC 时还是自由位 */
  locOf(st, 'W00-G01').role = '容器子位';      /* 锚定后镜像才翻转（含 bound_other 形态） */
  locOf(st, 'W00-G01').parentContainer = 'C-N2';
  assert.deepEqual(s.stepsFor(s.row()), ['LOC', 'ITM'], '步骤表按已扫值动态重估');
  /* 门控的 own_sub/bound_other 单行分支被 stepsFor 分流前置，公开 API 不可直达；
     能观察到的单行契约是：CTN 文本被步表拒绝，物品直存该子位 */
  const e = catchOf(() => s.accept('CTN:C-B'));
  assert.ok(e);
  assert.match(e.message, /当前请扫描ITM码/);
  const done = s.accept('ITM:WP-NEW');
  assert.equal(done.complete, true);
  assert.deepEqual(s.request().target, { loc: 'W00-G01', container: '', sub: true });
});
test('G3 单行：库位被别的容器以旧模型占位 → legacy_occupied', () => {
  const st = mkState(), s = mkr(st);
  s.accept('LOC:W01-G01'); // C-A 以旧模型 loc 占位 W01-G01
  const e = catchOf(() => s.accept('CTN:C-B'));
  assert.equal(e && e.code, 'CTN_LOC_UNBOUND');
  assert.equal(e.detail.kind, 'legacy_occupied');
  assert.match(e.message, /旧模型占位/);
});
test('G4 单行 rebase 流（问题②的修复闭环）：门控拒绝 → 标注子位（镜像翻转）→ 同一行直接扫 ITM 完成，请求为子位直存形', () => {
  const st = mkState(), s = mkr(st);
  s.accept('LOC:W00-G01');
  const e = catchOf(() => s.accept('CTN:C-B'));
  assert.equal(e && e.detail.kind, 'unbound');
  /* —— UI「标注子位并继续」确认卡 → activateLocation APPLIED → 镜像翻转 —— */
  locOf(st, 'W00-G01').role = '容器子位';
  locOf(st, 'W00-G01').parentContainer = 'C-B';
  /* 单行模式绝不重扫 CTN 文本（stepsFor 已动态变为 ['LOC','ITM']，会抛「当前请扫描ITM码」）；
     直接扫 ITM：同一行零改行完成 */
  assert.deepEqual(s.stepsFor(s.row()), ['LOC', 'ITM']);
  const done = s.accept('ITM:WP-NEW');
  assert.equal(done.complete, true);
  const q = s.request();
  assert.deepEqual(q.target, { loc: 'W00-G01', container: '', sub: true }, '子位直存请求形状');
  assert.deepEqual(q.expected, { itemVersion: 1 });
});
test('G5 verifyLegacy 原契约不变：新模型容器(loc空)仍走旧逐字比对（归属不符，无结构化码）', () => {
  const st = mkState(), s = mk(st, 'verifyLegacy');
  s.accept('LOC:W01-G01');
  const e = catchOf(() => s.accept('CTN:C-B'));
  assert.ok(e);
  assert.equal(e.message, '容器与库位归属不符', 'verifyLegacy 分支字节级保持旧文案');
  assert.equal(e.code, undefined);
});
test('G6 旧模型容器定位在别处：普通 receive 仍是原「归属不符」逐字比对（不进新门控）', () => {
  const st = mkState(), s = mkr(st);
  s.accept('LOC:W01-G01');
  const e = catchOf(() => s.accept('CTN:C-D'));
  assert.ok(e);
  assert.equal(e.message, '容器与库位归属不符');
  assert.equal(e.code, undefined);
});
test('G7 旧模型容器定位匹配：普通 receive 照常放行（回归锚）', () => {
  const st = mkState(), s = mkr(st);
  s.accept('LOC:W01-G01');
  const r = s.accept('CTN:C-A');
  assert.equal(r.complete, false, '还差 ITM 步');
  assert.equal(s.accept('ITM:WP-NEW').complete, true);
  assert.deepEqual(s.request().target, { loc: 'W01-G01', container: 'C-A' });
});

/* ---------- 批量（acceptBatchCode，v3.13.36 去锚点：与单行共用 acceptParsed 同一门控）---------- */
test('G8 批量 receive：新模型容器×空闲自由位 → unbound 分类拒绝，行不被污染（LOC 值保留可续扫）', () => {
  const st = mkState(), s = mk(st);
  s.startBatch('receive');
  s.setBatchQty(2);
  s.acceptBatchCode({ type: 'LOC', code: 'W00-G01' });
  const e = catchOf(() => s.acceptBatchCode({ type: 'CTN', code: 'C-B' }));
  assert.equal(e && e.code, 'CTN_LOC_UNBOUND');
  assert.deepEqual(e.detail, { kind: 'unbound', ctnCode: 'C-B', locCode: 'W00-G01' });
  /* 门控在 values.push 之前抛：当前行仍只有 LOC 值——标注后按行续扫即可 */
  const row = s.snapshot().rows[s.snapshot().active];
  assert.equal(row.values.length, 1);
  assert.equal(row.values[0].code, 'W00-G01');
});
test('G9 批量 rebase 流（问题②批量侧闭环，与单行 G4 同构）：unbound 拒绝 → 标注（镜像翻转）→ CTN 文本被步表拒、同批行直接扫 ITM 子位直存', () => {
  const st = mkState(), s = mk(st);
  s.startBatch('receive');
  s.setBatchQty(1);
  s.acceptBatchCode({ type: 'LOC', code: 'W00-G01' });
  const e = catchOf(() => s.acceptBatchCode({ type: 'CTN', code: 'C-B' }));
  assert.equal(e && e.code, 'CTN_LOC_UNBOUND');
  assert.equal(e.detail.kind, 'unbound');
  /* —— UI「标注子位并继续」确认卡 → activateLocation APPLIED → 镜像翻转 —— */
  locOf(st, 'W00-G01').role = '容器子位';
  locOf(st, 'W00-G01').parentContainer = 'C-B';
  /* 与单行 G2/G4 同契约：stepsFor 活读镜像已动态变为 ['LOC','ITM']，重放 CTN 文本被步表拒；
     直接扫 ITM：同一行零改行完成（own_sub 门控分支被分流前置，公开 API 不可直达） */
  assert.deepEqual(s.stepsFor(s.row()), ['LOC', 'ITM'], '批量行 stepsFor 动态分流与单行同判');
  const e2 = catchOf(() => s.acceptBatchCode({ type: 'CTN', code: 'C-B' }));
  assert.match(e2 && e2.message, /当前请扫描ITM码/);
  assert.match(s.acceptBatchCode({ type: 'ITM', code: 'WP-NEW' }).text, /第 1 件/);
  const snap = s.snapshot();
  const rows = snap.rows.filter(r2 => r2.values.some(v => v.type === 'ITM'));
  assert.deepEqual(rows[0].values.map(v => v.type + v.code), ['LOCW00-G01', 'ITMWP-NEW']);
  s.select(snap.rows.indexOf(rows[0]));
  const q = s.request();
  assert.deepEqual(q.target, { loc: 'W00-G01', container: '', sub: true }, '子位行 request 形状与单行同款');
});
test('G10 批量：库位已从属别的容器（bound_other 形态）→ 步表前置拒绝，绝不静默放行进错误容器（与单行 G2 同构）', () => {
  const st = mkState(), s = mk(st);
  s.startBatch('receive');
  s.setBatchQty(2);
  s.acceptBatchCode({ type: 'LOC', code: 'W00-G01' });
  locOf(st, 'W00-G01').role = '容器子位';
  locOf(st, 'W00-G01').parentContainer = 'C-N2';
  const e = catchOf(() => s.acceptBatchCode({ type: 'CTN', code: 'C-B' }));
  assert.ok(e, '必须拒绝');
  assert.match(e.message, /当前请扫描ITM码/, '步表分流前置（门控 bound_other 为竞态防御，公开 API 不可直达）');
  assert.equal(s.row().values.length, 1, '行不被污染');
});
test('G11 批量：库位被旧模型占位 → legacy_occupied', () => {
  const st = mkState(), s = mk(st);
  s.startBatch('receive');
  s.setBatchQty(2);
  s.acceptBatchCode({ type: 'LOC', code: 'W01-G01' }); // C-A 以旧模型占位
  const e = catchOf(() => s.acceptBatchCode({ type: 'CTN', code: 'C-B' }));
  assert.equal(e && e.detail.kind, 'legacy_occupied');
});
test('G12 批量：旧模型容器归属不符语义不变（与单行 G6 同文案，S2 同口径回归锚）', () => {
  const st = mkState(), s = mk(st);
  s.startBatch('receive');
  s.setBatchQty(2);
  s.acceptBatchCode({ type: 'LOC', code: 'W01-G01' });
  const e = catchOf(() => s.acceptBatchCode({ type: 'CTN', code: 'C-D' }));
  assert.ok(e);
  assert.equal(e.code, undefined, '旧模型路径不产结构化码');
  assert.match(e.message, /归属不符/, '批量与单行共用 acceptParsed → 同款比对文案（旧批量富文案随锚点分支删除）');
});
