'use strict';
/* =========================================================================
 * P2 子位写入路径（TASK-P2 · 子位写入）
 * 本文件覆盖审查清单 F1（proof 兼容性命门尖峰）、A2（activateLocation 子位化）、
 * A3（容器命令 LOC_ROLE_MISMATCH）、A4-A6（receive/issue/transfer 子分支、retire 双清）、
 * A7（鉴别器红线）、B1/B2（同步侧 XOR 与子位关系有效性）、C（stepsFor 与请求形状）、
 * F4（CLM-7.x 子位写入套件）。
 * 命名约定：SCL-7.x = 子位写入路径套件编号。
 * ========================================================================= */
const test = require('node:test'), assert = require('node:assert/strict');
const U = require('../lib/unique-items');
const S = require('../lib/item-sync');

function planOf(state, request, actor) { return U.plan(state, request, actor); }
const admin = { id: 'u-admin', roles: ['admin'] };
const oper = { id: 'u-op', roles: ['operator'] };

/* 标准种子：一个容器 C-A 停在自由位 L-A，一个子位 SUB-A1 归属 C-A，一个未绑定子位 SUB-NX。 */
function seed() {
  return U.migrate({
    locations: [
      { code: 'L-A', status: 'active', role: '', parentContainer: '' },
      { code: 'SUB-A1', status: 'active', role: '容器子位', parentContainer: 'C-A' },
      { code: 'SUB-NX', status: 'active', role: '容器子位', parentContainer: 'C-NX' },
      { code: 'C-03-02-01', status: 'active', role: '容器子位', parentContainer: 'C-03-02' }
    ],
    containers: [
      { code: 'C-A', loc: 'L-A', status: 'active', version: 2, lastOpId: 'mv-1' },
      { code: 'C-NX', loc: '', status: 'active', version: 1, lastOpId: 'pc-1' }
    ],
    items: [
      { code: 'I-CTN', name: '容器内物品', status: 'in_stock', container: 'C-A', loc: '', version: 3, lastOpId: 'rc-1' },
      { code: 'I-SUB', name: '子位物品', status: 'in_stock', container: '', loc: 'SUB-A1', version: 4, lastOpId: 'rs-1' },
      { code: 'I-OUT', name: '出库物品', status: 'out', container: '', loc: 'SUB-A1', version: 5, lastOpId: 'is-1' }
    ],
    itemOperations: []
  });
}

/* ============================ F1：proof 兼容性命门 ============================ */

test('SCL-7.0a 旧 4 字段 items APPLIED 流水 vs 新 normalize 实时行：group 归一两侧相等', () => {
  /* 旧代码（P1 及之前，CONTROLLED.items 无 loc）写出的 APPLIED receive 日志 after 行： */
  const legacyAfter = { code: 'I-A', container: 'C-A', status: 'in_stock', version: 1, lastOpId: 'op-1' };
  /* 生产 mapDown 实时行：受控组键齐全（loc 映射管道 P0 已在），经新 normalize 缺省归一 loc:''。 */
  const live = U.normalize('items', { code: 'I-A', container: 'C-A', status: 'in_stock', version: 1, lastOpId: 'op-1', loc: '' });
  assert.equal(U.CONTROLLED.items.includes('loc'), true, '前提：CONTROLLED.items 已含 loc');
  assert.deepEqual(U.controlled('items', U.normalize('items', legacyAfter)), U.controlled('items', live));
});

test('SCL-7.0b 旧 1 字段 locations APPLIED 流水 vs 新 normalize 实时行：proof 仍成立', () => {
  /* 旧 activateLocation 日志 after 行只有 code+status；locations proof 分支本就只认 code+status，
     新受控键（role/parentContainer）多带少带都不影响凭据判定。 */
  const logs = [{ code: 'act-1', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } }];
  const liveRow = U.normalize('locations', { code: 'L-A', status: 'active', role: '', parentContainer: '' });
  assert.equal(S.proof('locations', liveRow, logs), true);
  assert.equal(U.CONTROLLED.locations.includes('role') && U.CONTROLLED.locations.includes('parentContainer'), true);
});

test('SCL-7.0c 端到端 merge：旧形状 APPLIED 日志 + 新受控组 → 行被采纳、零冲突（不锁死）', () => {
  const st = U.migrate({
    locations: [{ code: 'L-A', status: 'unknown', desc: '现场' }],
    containers: [], items: [], itemOperations: []
  });
  /* 旧代码写出的三条历史 APPLIED 流水（受控组里没有 loc / role / parentContainer 键） */
  const legacyLogs = {
    itemOperations: [
      { code: 'act-1', kind: 'activateLocation', phase: 'APPLIED', request: { kind: 'activateLocation' }, requestHash: 'h1', operator: 'op', before: {}, after: { locations: [{ code: 'L-A', status: 'active' }] } },
      { code: 'ac-1', kind: 'activateContainer', phase: 'APPLIED', request: { kind: 'activateContainer' }, requestHash: 'h2', operator: 'op', before: {}, after: { containers: [{ code: 'C-A', loc: 'L-A', status: 'active', version: 1, lastOpId: 'ac-1' }] } },
      { code: 'rc-1', kind: 'receive', phase: 'APPLIED', request: { kind: 'receive' }, requestHash: 'h3', operator: 'op', before: {}, after: { items: [{ code: 'I-A', container: 'C-A', status: 'in_stock', version: 1, lastOpId: 'rc-1' }] } }
    ]
  };
  const r1 = S.merge(st, legacyLogs);
  assert.deepEqual(r1.conflicts, [], '日志缓存阶段不允许任何冲突');
  /* 云端实时行：mapDown 形状（受控键齐全，loc/role/parentContainer 为空串） */
  const snapshot = {
    locations: [{ code: 'L-A', status: 'active', desc: '现场', role: '', parentContainer: '' }],
    containers: [{ code: 'C-A', loc: 'L-A', status: 'active', version: 1, lastOpId: 'ac-1' }],
    items: [{ code: 'I-A', name: 'x', container: 'C-A', loc: '', status: 'in_stock', version: 1, lastOpId: 'rc-1' }]
  };
  S.merge(st, legacyLogs);
  const r2 = S.merge(st, snapshot);
  assert.deepEqual(r2.conflicts, [], '旧流水凭据必须放行新受控组行（否则全量锁死）');
  assert.equal(st.items[0].status, 'in_stock');
  assert.equal(st.locations[0].status, 'active');
});

test('SCL-7.0d revalidate 自愈路径同样兼容旧形状流水', () => {
  const st = U.migrate({
    locations: [{ code: 'L-A', status: 'unknown', role: '', parentContainer: '' }],
    containers: [], items: [], itemOperations: [
      /* 旧 1 字段 LOC 流水 + 旧 4 字段 items 流水（无 loc / role / parentContainer 键） */
      { code: 'act-1', kind: 'activateLocation', phase: 'APPLIED', after: { locations: [{ code: 'L-A', status: 'active' }] } },
      { code: 'is-1', kind: 'issue', phase: 'APPLIED', after: { items: [{ code: 'I-A', container: '', status: 'out', version: 4, lastOpId: 'is-1' }] } }
    ]
  });
  st.containers = [{ code: 'C-A', loc: 'L-A', status: 'active', version: 1, lastOpId: 'ac-1' }];
  /* T1 时序竞争：本地镜像停在旧状态（version 3, in_stock, lastOpId='rc-1'），云端行已到 v4
     但被拒；T2 旧流水到达后 revalidate 必须按凭据落地（normalize 缺省 loc/role 不阻挡）。 */
  st.items = [{ code: 'I-A', status: 'in_stock', container: 'C-A', loc: '', version: 3, lastOpId: 'rc-1' }];
  const healed = S.revalidate(st);
  assert.ok(healed.includes('locations:L-A'), '旧 1 字段 LOC 流水必须能自愈库位');
  assert.ok(healed.includes('items:I-A'), '旧 4 字段 items 流水必须能自愈物品');
  assert.equal(st.items[0].container, '');
  assert.equal(st.items[0].status, 'out');
});

/* ==================== F4：SCL-7.1+ 子位写入路径（A2–A7 / B1–B2 / C） ==================== */

const Scan = require('../lib/item-scan');

/* A2：activateLocation 子位化标记（admin 专属命令）。 */

test('SCL-7.1 A2 正向：FREE 库位显式标记为容器子位；同父重标记与幂等重确认均原样保留从属', () => {
  const st = seed();
  st.locations.push(U.normalize('locations', { code: 'L-B', status: 'unknown' }));
  const p = planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'a2-1', locationCode: 'L-B', role: '容器子位', parentContainer: 'C-A' }, admin);
  assert.deepEqual(p.before.locations, [{ code: 'L-B', status: 'unknown', role: '', parentContainer: '' }]);
  assert.deepEqual(p.after.locations, [{ code: 'L-B', status: 'active', role: '容器子位', parentContainer: 'C-A' }]);
  /* 同父容器重标记：非改绑，放行且不丢从属 */
  const remark = planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'a2-1b', locationCode: 'SUB-A1', role: '容器子位', parentContainer: 'C-A' }, admin);
  assert.deepEqual(remark.after.locations, [{ code: 'SUB-A1', status: 'active', role: '容器子位', parentContainer: 'C-A' }]);
  /* 幂等重确认（不带 role）：role/parentContainer 原样保留 */
  const recon = planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'a2-1c', locationCode: 'SUB-A1' }, admin);
  assert.deepEqual(recon.after.locations, [{ code: 'SUB-A1', status: 'active', role: '容器子位', parentContainer: 'C-A' }]);
});

test('SCL-7.2 A2 负向：空父容器/旧模型占位/改绑/未知父/停用父/孤儿子位 → 全部拒绝', () => {
  const st = seed();
  st.locations.push(U.normalize('locations', { code: 'L-B', status: 'unknown' }));
  st.containers.push(U.normalize('containers', { code: 'C-DIS', loc: '', status: 'disabled', version: 1, lastOpId: 'x-1' }));
  const mark = (opId, locationCode, parentContainer) =>
    planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId, locationCode, role: '容器子位', parentContainer }, admin);
  assert.throws(() => mark('a2-2a', 'L-B', ''), e => e.code === 'MISSING_RELATION', '空父容器串 = 未声明关系');
  assert.throws(() => mark('a2-2b', 'L-A', 'C-A'), e => e.code === 'LOC_ALREADY_BOUND', 'L-A 已被 C-A 旧模型绑定');
  assert.throws(() => mark('a2-2c', 'SUB-A1', 'C-NX'), e => e.code === 'LOC_ALREADY_BOUND', 'SUB-A1 已从属 C-A，改绑拒绝');
  assert.throws(() => mark('a2-2d', 'L-B', 'C-MISS'), e => e.code === 'NOT_FOUND', '父容器不存在');
  assert.throws(() => mark('a2-2e', 'L-B', 'C-DIS'), e => e.code === 'INACTIVE_ENTITY', '父容器非活跃');
  assert.throws(() => mark('a2-2f', 'C-03-02-01', 'C-03-02'), e => e.code === 'NOT_FOUND', '孤儿子位行重标记同样要求父容器真实存在');
});

test('SCL-7.3 A2 解绑形态拒绝 + FREE 行显式 role 被忽略：activate 只启用，不静默改角色', () => {
  const st = seed();
  st.locations.push(U.normalize('locations', { code: 'L-B', status: 'unknown' }));
  /* 子位行带空父容器 = 试图解除从属但未给解除形态 */
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'a2-3a', locationCode: 'SUB-A1', role: '容器子位' }, admin), e => e.code === 'SUBLOC_UNBIND_UNSPECIFIED');
  /* 子位行显式降级 role=自由位：同样未给解除从属形态 */
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'a2-3b', locationCode: 'SUB-A1', role: '自由位' }, admin), e => e.code === 'SUBLOC_UNBIND_UNSPECIFIED');
  /* FREE 行显式 role=自由位：忽略（activate 只负责启用，不静默改写角色） */
  const p = planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'a2-3c', locationCode: 'L-B', role: '自由位' }, admin);
  assert.deepEqual(p.after.locations, [{ code: 'L-B', status: 'active', role: '', parentContainer: '' }]);
});

test('SCL-7.4 A3 容器命令指向子位：activate/place/move 全部 LOC_ROLE_MISMATCH（在版本检查之前）', () => {
  const st = seed();
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'a3-1', containerCode: 'C-NX', target: { loc: 'SUB-A1' } }, admin), e => e.code === 'LOC_ROLE_MISMATCH');
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'placeContainer', opId: 'a3-2', containerCode: 'C-NX', target: { loc: 'SUB-A1' }, expected: { containerVersion: 1 } }, oper), e => e.code === 'LOC_ROLE_MISMATCH');
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'moveContainer', opId: 'a3-3', containerCode: 'C-A', source: { loc: 'L-A' }, target: { loc: 'SUB-A1' }, expected: { containerVersion: 2 } }, oper), e => e.code === 'LOC_ROLE_MISMATCH');
});

/* A4：receive 子位入库。 */

test('SCL-7.5 A4 正向：子位入库显式清 container + loc 落子位（在库 XOR 成立；before 留 out 行历史线索）', () => {
  const st = seed();
  const p = planOf(st, { schemaVersion: 1, kind: 'receive', opId: 'a4-1', itemCode: 'I-OUT', target: { loc: 'SUB-A1', container: '', sub: true }, expected: { itemVersion: 5 } }, oper);
  assert.deepEqual(p.before.items, [{ code: 'I-OUT', container: '', loc: 'SUB-A1', status: 'out', version: 5, lastOpId: 'is-1' }]);
  assert.deepEqual(p.after.items, [{ code: 'I-OUT', container: '', loc: 'SUB-A1', status: 'in_stock', version: 6, lastOpId: 'a4-1' }]);
  assert.ok(!!p.after.items[0].container !== !!p.after.items[0].loc, '在库 XOR：container 与 loc 恰好一真一空');
});

test('SCL-7.6 A4 负向 + 旧形状兼容：sub:true 指向 FREE 位拒绝；旧容器入库路径 loc 显式清空不变', () => {
  const st = seed();
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'receive', opId: 'a4-2', itemCode: 'I-OUT', target: { loc: 'L-A', container: '', sub: true }, expected: { itemVersion: 5 } }, oper), e => e.code === 'LOC_ROLE_MISMATCH');
  const p = planOf(st, { schemaVersion: 1, kind: 'receive', opId: 'a4-3', itemCode: 'I-OUT', target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 5, containerVersion: 2 } }, oper);
  assert.deepEqual(p.after.items, [{ code: 'I-OUT', container: 'C-A', loc: '', status: 'in_stock', version: 6, lastOpId: 'a4-3' }], '旧形状：loc 显式清空（P0 行为原样保留）');
});

/* A5：issue / transfer 子位路径。 */

test('SCL-7.7 A5 出库：子位物品 issue 后 status=out、loc 保留历史；声明子位与现状不符全部拒绝', () => {
  const st = seed();
  const p = planOf(st, { schemaVersion: 1, kind: 'issue', opId: 'a5-1', itemCode: 'I-SUB', source: { loc: 'SUB-A1', container: '', sub: true }, expected: { itemVersion: 4 } }, oper);
  assert.deepEqual(p.after.items, [{ code: 'I-SUB', container: '', loc: 'SUB-A1', status: 'out', version: 5, lastOpId: 'a5-1' }]);
  /* 负向：声明子位与物品现存子位不符 */
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'issue', opId: 'a5-2', itemCode: 'I-SUB', source: { loc: 'SUB-NX', container: '', sub: true }, expected: { itemVersion: 4 } }, oper), e => e.code === 'SOURCE_MISMATCH');
  /* 容器内物品声明子位源：item.loc 为空 → SOURCE_MISMATCH（先于角色检查） */
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'issue', opId: 'a5-3', itemCode: 'I-CTN', source: { loc: 'SUB-A1', container: '', sub: true }, expected: { itemVersion: 3 } }, oper), e => e.code === 'SOURCE_MISMATCH');
  /* 防御性：损坏行（在库但 loc 指向 FREE 位）声明 sub 源 → 角色闸门兜底拒绝 */
  st.items.push(U.normalize('items', { code: 'I-X', status: 'in_stock', container: '', loc: 'L-A', version: 1, lastOpId: 'x-1' }));
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'issue', opId: 'a5-4', itemCode: 'I-X', source: { loc: 'L-A', container: '', sub: true }, expected: { itemVersion: 1 } }, oper), e => e.code === 'LOC_ROLE_MISMATCH');
});

test('SCL-7.8 A5 换箱 2×2 矩阵：sub→sub / sub→container / container→sub / container→container', () => {
  const st = seed();
  st.locations.push(U.normalize('locations', { code: 'L-B', status: 'active' }));
  st.containers.push(U.normalize('containers', { code: 'C-B', loc: 'L-B', status: 'active', version: 1, lastOpId: 'pc-b' }));
  const tr = (opId, itemCode, source, target, expected) =>
    planOf(st, { schemaVersion: 1, kind: 'transfer', opId, itemCode, source, target, expected }, oper);
  let p = tr('tr-ss', 'I-SUB', { loc: 'SUB-A1', container: '', sub: true }, { loc: 'SUB-NX', container: '', sub: true }, { itemVersion: 4 });
  assert.deepEqual(p.after.items, [{ code: 'I-SUB', container: '', loc: 'SUB-NX', status: 'in_stock', version: 5, lastOpId: 'tr-ss' }]);
  p = tr('tr-sc', 'I-SUB', { loc: 'SUB-A1', container: '', sub: true }, { loc: 'L-A', container: 'C-A' }, { itemVersion: 4, targetContainerVersion: 2 });
  assert.deepEqual(p.after.items, [{ code: 'I-SUB', container: 'C-A', loc: '', status: 'in_stock', version: 5, lastOpId: 'tr-sc' }]);
  p = tr('tr-cs', 'I-CTN', { loc: 'L-A', container: 'C-A' }, { loc: 'SUB-A1', container: '', sub: true }, { itemVersion: 3, containerVersion: 2 });
  assert.deepEqual(p.after.items, [{ code: 'I-CTN', container: '', loc: 'SUB-A1', status: 'in_stock', version: 4, lastOpId: 'tr-cs' }]);
  p = tr('tr-cc', 'I-CTN', { loc: 'L-A', container: 'C-A' }, { loc: 'L-B', container: 'C-B' }, { itemVersion: 3, containerVersion: 2, targetContainerVersion: 1 });
  assert.deepEqual(p.after.items, [{ code: 'I-CTN', container: 'C-B', loc: '', status: 'in_stock', version: 4, lastOpId: 'tr-cc' }], '传统容器换箱行为不变');
});

/* A6：retire 双清除。 */

test('SCL-7.9 A6 退役双清除：retired 行 container 与 loc 同清（含子位历史线索）', () => {
  const st = seed();
  /* 在库物品不可直接退役（unique-items.js:372 仅放行 pending/out/unknown）。 */
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'retire', opId: 'r-in', itemCode: 'I-SUB', expected: { itemVersion: 4 } }, admin), e => e.code === 'INVALID_TRANSITION');
  let p = planOf(st, { schemaVersion: 1, kind: 'retire', opId: 'r-out', itemCode: 'I-OUT', expected: { itemVersion: 5 } }, admin);
  assert.deepEqual(p.after.items, [{ code: 'I-OUT', container: '', loc: '', status: 'retired', version: 6, lastOpId: 'r-out' }], 'out 行的历史 loc 一并显式清除');
});

/* A7：鉴别器红线——仅显式 sub===true 触发子位路径。 */

test('SCL-7.10 A7 鉴别器红线：container=\'\' 但无 sub 键 → 绝不静默子位化（旧 pair 路径拒绝）', () => {
  const st = seed();
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'issue', opId: 'a7-1', itemCode: 'I-SUB', source: { loc: 'SUB-A1', container: '' }, expected: { itemVersion: 4 } }, oper), e => e.code === 'INVALID_CODE');
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'receive', opId: 'a7-2', itemCode: 'I-OUT', target: { loc: 'SUB-A1', container: '' }, expected: { itemVersion: 5 } }, oper), e => e.code === 'INVALID_CODE');
});

/* B1：merge 侧 XOR 互斥。 */

test('SCL-7.11 B1 merge XOR：在库双写/出库带容器行被隔离，本地行不被污染、新行只落 unknown 骨架', () => {
  const st = seed();
  const log = (op, item) => ({ code: op, kind: 'receive', phase: 'APPLIED', request: { kind: 'receive' }, requestHash: 'h', operator: 'op', before: {}, after: { items: [item] } });
  const bad = { code: 'I-SUB', container: 'C-A', loc: 'SUB-A1', status: 'in_stock', version: 5, lastOpId: 'op-b1' };
  const bad2 = { code: 'I-B1X', container: 'C-A', loc: '', status: 'out', version: 1, lastOpId: 'op-b1x' };
  const r = S.merge(st, { items: [structuredClone(bad), structuredClone(bad2)], itemOperations: [log('op-b1', structuredClone(bad)), log('op-b1x', structuredClone(bad2))] });
  assert.deepEqual(r.conflicts.map(c => c.table + ':' + c.key + '#' + c.reason).sort(), ['items:I-B1X#unverified-controlled-change', 'items:I-SUB#unverified-controlled-change']);
  const local = st.items.find(x => x.code === 'I-SUB');
  assert.equal(local.version, 4, '本地行不被双写行污染');
  assert.equal(local.container, '');
  assert.equal(st.items.find(x => x.code === 'I-B1X').status, 'unknown', '被拒新行只落 unknown 骨架');
});

test('SCL-7.12 B1 merge 正向：容器侧在库行采纳；out 行 container 空 + loc 历史线索采纳', () => {
  const st = seed();
  const log = (op, item) => ({ code: op, kind: 'receive', phase: 'APPLIED', request: { kind: 'receive' }, requestHash: 'h', operator: 'op', before: {}, after: { items: [item] } });
  const ctnRow = { code: 'I-B1a', container: 'C-A', loc: '', status: 'in_stock', version: 1, lastOpId: 'op-n1' };
  const outRow = { code: 'I-SUB', container: '', loc: 'SUB-A1', status: 'out', version: 6, lastOpId: 'op-n2' };
  const r = S.merge(st, { items: [structuredClone(ctnRow), structuredClone(outRow)], itemOperations: [log('op-n1', structuredClone(ctnRow)), log('op-n2', structuredClone(outRow))] });
  assert.deepEqual(r.conflicts, [], '合法 XOR 行（两种方向）都必须零冲突');
  assert.equal(st.items.find(x => x.code === 'I-B1a').status, 'in_stock');
  const sub = st.items.find(x => x.code === 'I-SUB');
  assert.deepEqual({ status: sub.status, container: sub.container, loc: sub.loc, version: sub.version }, { status: 'out', container: '', loc: 'SUB-A1', version: 6 });
});

/* B2：merge/revalidate 侧子位关系有效性。 */

test('SCL-7.13 B2 merge 子位关系闸门：FREE 位/父缺失在库行隔离，合法子位行放行', () => {
  const st = seed();
  const log = (op, item) => ({ code: op, kind: 'receive', phase: 'APPLIED', request: { kind: 'receive' }, requestHash: 'h', operator: 'op', before: {}, after: { items: [item] } });
  const ok = { code: 'I-B2a', container: '', loc: 'SUB-A1', status: 'in_stock', version: 1, lastOpId: 'op-n1' };
  const freeLoc = { code: 'I-B2b', container: '', loc: 'L-A', status: 'in_stock', version: 1, lastOpId: 'op-n2' };
  const orphan = { code: 'I-B2c', container: '', loc: 'C-03-02-01', status: 'in_stock', version: 1, lastOpId: 'op-n3' };
  const r = S.merge(st, { items: [structuredClone(ok), structuredClone(freeLoc), structuredClone(orphan)], itemOperations: [log('op-n1', structuredClone(ok)), log('op-n2', structuredClone(freeLoc)), log('op-n3', structuredClone(orphan))] });
  assert.deepEqual(r.conflicts.map(c => c.key).sort(), ['I-B2b', 'I-B2c'], 'FREE 位与父缺失的直存行隔离');
  assert.equal(st.items.find(x => x.code === 'I-B2a').status, 'in_stock', '合法子位行放行');
  assert.equal(st.items.find(x => x.code === 'I-B2b').status, 'unknown', 'FREE 位行只落 unknown 骨架');
});

test('SCL-7.14 B2 revalidate：合法子位凭据自愈，FREE 位凭据拒绝自愈', () => {
  const st = seed();
  st.items.push(U.normalize('items', { code: 'I-B2R', status: 'in_stock', container: '', loc: 'SUB-A1', version: 3, lastOpId: 'rc-9' }));
  st.items.push(U.normalize('items', { code: 'I-B2X', status: 'in_stock', container: '', loc: 'L-A', version: 3, lastOpId: 'rc-11' }));
  st.__itmConflicts = {
    'items:I-B2R': { table: 'items', key: 'I-B2R', reason: 'unverified-controlled-change' },
    'items:I-B2X': { table: 'items', key: 'I-B2X', reason: 'unverified-controlled-change' }
  };
  st.itemOperations = [
    { code: 'rc-10', kind: 'receive', phase: 'APPLIED', request: { kind: 'receive' }, requestHash: 'h', operator: 'op', before: {}, after: { items: [{ code: 'I-B2R', container: '', loc: 'SUB-A1', status: 'in_stock', version: 4, lastOpId: 'rc-10' }] } },
    { code: 'rc-12', kind: 'receive', phase: 'APPLIED', request: { kind: 'receive' }, requestHash: 'h', operator: 'op', before: {}, after: { items: [{ code: 'I-B2X', container: '', loc: 'L-A', status: 'in_stock', version: 4, lastOpId: 'rc-12' }] } }
  ];
  const healed = S.revalidate(st);
  assert.ok(healed.includes('items:I-B2R'), '合法子位关系按凭据自愈');
  assert.ok(!healed.includes('items:I-B2X'), 'FREE 位关系不得自愈');
  assert.ok(st.__itmConflicts['items:I-B2X'], '非法关系冲突保持隔离');
  assert.equal(st.items.find(x => x.code === 'I-B2R').version, 4);
});

/* C：stepsFor 步骤表收敛 + 扫描器请求形状。 */

test('SCL-7.15 C stepsFor/请求形状：子位锚点收敛步骤表与 sub 请求；FREE 位与 sequences 原表不变', () => {
  const st = seed();
  st.locations.push(U.normalize('locations', { code: 'L-B', status: 'active' }));
  st.containers.push(U.normalize('containers', { code: 'C-B', loc: 'L-B', status: 'active', version: 1, lastOpId: 'pc-b' }));
  let n = 0;
  const scan = Scan.create({ getState: () => st, id: () => 'id-' + (++n) });
  /* 子位 receive：两步收敛 + sub 请求形状 */
  scan.add('receive');
  scan.accept('LOC:SUB-A1');
  assert.deepEqual(scan.stepsFor(scan.row()), ['LOC', 'ITM'], '子位 receive 两步');
  scan.accept('ITM:I-OUT');
  let q = scan.request();
  assert.equal(q.itemCode, 'I-OUT');
  assert.deepEqual(q.expected, { itemVersion: 5 }, '子位行只派 itemVersion（容器版本种子被整体替换）');
  assert.deepEqual(q.target, { loc: 'SUB-A1', container: '', sub: true });
  /* FREE 位 receive：三步原表 */
  scan.add('receive');
  scan.accept('LOC:L-A');
  assert.deepEqual(scan.stepsFor(scan.row()), ['LOC', 'CTN', 'ITM'], 'FREE 位 receive 三步（原表）');
  /* 子位 transfer：两步收敛 + 双端 sub 请求形状 */
  scan.add('transfer');
  scan.accept('ITM:I-SUB');
  scan.accept('LOC:SUB-NX');
  assert.deepEqual(scan.stepsFor(scan.row()), ['ITM', 'LOC'], '子位 transfer 两步');
  q = scan.request();
  assert.equal(q.itemCode, 'I-SUB');
  assert.deepEqual(q.source, { loc: 'SUB-A1', container: '', sub: true }, '源从物品现状派生为子位形状');
  assert.deepEqual(q.target, { loc: 'SUB-NX', container: '', sub: true });
  assert.deepEqual(q.expected, { itemVersion: 4 });
  /* FREE 位 transfer：三步原表 + 传统容器请求形状 */
  scan.add('transfer');
  scan.accept('ITM:I-CTN');
  scan.accept('LOC:L-B');
  assert.deepEqual(scan.stepsFor(scan.row()), ['ITM', 'LOC', 'CTN'], 'FREE 位 transfer 三步（原表）');
  scan.accept('CTN:C-B');
  q = scan.request();
  assert.deepEqual(q.source, { loc: 'L-A', container: 'C-A' });
  assert.deepEqual(q.target, { loc: 'L-B', container: 'C-B' });
  assert.deepEqual(q.expected, { itemVersion: 3, containerVersion: 2, targetContainerVersion: 1 });
  /* sequences 原表不被改写 */
  assert.deepEqual(Scan.sequences.receive, ['LOC', 'CTN', 'ITM']);
  assert.deepEqual(Scan.sequences.transfer, ['ITM', 'LOC', 'CTN']);
});

/* =========================================================================
 * P3 批量子位锚点（TASK-P3 · 批量镜像）
 * 覆盖：receiveBatch 锚点级 sub（target.sub===true，锚点级 fail-fast）、
 * issueBatch 条目级 sub（e.sub===true）、P2 溢出修复回归（:302 loc:''）、
 * 批量鉴别器红线（A7 镜像）、批量扫描器子位锚点流（C5）。
 * 命名约定：SCL-8.x = 批量子位锚点套件编号。
 * ========================================================================= */

const recvBatch = (opId, target, items) => ({ schemaVersion: 1, opId, kind: 'receiveBatch', target, items });
const issuBatch = (opId, source, items) => ({ schemaVersion: 1, opId, kind: 'issueBatch', source, items });
/* 批量 APPLIED 日志形状：一条日志 after.items 装 N 行（行 lastOpId 均为 opId → proof 逐一命中） */
const apBatchLog = (op, kind, afterItems) => ({ code: op, kind, phase: 'APPLIED', request: { kind }, requestHash: 'h', operator: 'op', before: {}, after: { items: afterItems } });

test('SCL-8.1 A4 批量正向：子位锚点 receiveBatch 直存——after XOR 成立、before 留 out 历史行、e2e merge 零冲突', () => {
  const st = seed();
  st.items.push(U.normalize('items', { code: 'I-P', status: 'pending', container: '', loc: '', version: 1, lastOpId: 'reg-1' }));
  const p = planOf(st, recvBatch('b8-1', { loc: 'SUB-A1', container: '', sub: true }, [
    { itemCode: 'I-OUT', expectedItemVersion: 5 },
    { itemCode: 'I-P', expectedItemVersion: 1 }
  ]), oper);
  assert.deepEqual(p.after.items, [
    { code: 'I-OUT', container: '', loc: 'SUB-A1', status: 'in_stock', version: 6, lastOpId: 'b8-1' },
    { code: 'I-P', container: '', loc: 'SUB-A1', status: 'in_stock', version: 2, lastOpId: 'b8-1' }
  ]);
  p.after.items.forEach(r => assert.ok(!!r.container !== !!r.loc, '在库 XOR：' + r.code));
  assert.deepEqual(p.before.items, [
    { code: 'I-OUT', container: '', loc: 'SUB-A1', status: 'out', version: 5, lastOpId: 'is-1' },
    { code: 'I-P', container: '', loc: '', status: 'pending', version: 1, lastOpId: 'reg-1' }
  ], 'before 留 out 行历史线索（out 件换位入库可审计）');
  /* e2e：批量 APPLIED 日志（after.items N 行）→ merge 零冲突（SCL-7.0c 兼容命门） */
  const st2 = seed();
  st2.items.push(U.normalize('items', { code: 'I-P', status: 'pending', container: '', loc: '', version: 1, lastOpId: 'reg-1' }));
  const rows = structuredClone(p.after.items);
  const r = S.merge(st2, { items: rows, itemOperations: [apBatchLog('b8-1', 'receiveBatch', structuredClone(rows))] });
  assert.deepEqual(r.conflicts.map(c => c.table + ':' + c.key), [], '批量子位入库必须零冲突落地');
  assert.deepEqual(
    st2.items.filter(x => x.code === 'I-OUT' || x.code === 'I-P').map(x => ({ code: x.code, container: x.container, loc: x.loc, status: x.status, version: x.version, lastOpId: x.lastOpId })),
    p.after.items
  );
});

test('SCL-8.2 A4 批量负向：FREE 锚点/缺 loc/未知位/条目带容器码/停用子位 → 全部拒绝', () => {
  const st = seed();
  st.locations.push(U.normalize('locations', { code: 'SUB-DIS', status: 'disabled', role: '容器子位', parentContainer: 'C-A' }));
  /* 锚点级 fail-fast：FREE 位声明 sub 锚点 → LOC_ROLE_MISMATCH（与单条 receive 同判） */
  assert.throws(() => planOf(st, recvBatch('b8-2a', { loc: 'L-A', container: '', sub: true }, [{ itemCode: 'I-OUT', expectedItemVersion: 5 }]), oper), e => e.code === 'LOC_ROLE_MISMATCH');
  /* 子位锚点也不例外：receiveBatch 必须带 target.loc */
  assert.throws(() => planOf(st, recvBatch('b8-2b', { container: '', sub: true }, [{ itemCode: 'I-OUT', expectedItemVersion: 5 }]), oper), e => e.code === 'MISSING_RELATION');
  /* 锚点库位不存在 → NOT_FOUND（unique 先于 role） */
  assert.throws(() => planOf(st, recvBatch('b8-2c', { loc: 'NOPE', container: '', sub: true }, [{ itemCode: 'I-OUT', expectedItemVersion: 5 }]), oper), e => e.code === 'NOT_FOUND');
  /* 子位条目带 containerCode = 旧客户端误用（子位无容器版本可派）→ INVALID_CODE 带 @件码 */
  assert.throws(() => planOf(st, recvBatch('b8-2d', { loc: 'SUB-A1', container: '', sub: true }, [{ itemCode: 'I-OUT', expectedItemVersion: 5, containerCode: 'C-A' }]), oper), e => e.code === 'INVALID_CODE' && /@ I-OUT$/.test(e.message));
  /* 锚点子位停用 → INACTIVE_ENTITY（unique→active→role 顺序：active 先于 role） */
  assert.throws(() => planOf(st, recvBatch('b8-2e', { loc: 'SUB-DIS', container: '', sub: true }, [{ itemCode: 'I-OUT', expectedItemVersion: 5 }]), oper), e => e.code === 'INACTIVE_ENTITY');
});

test('SCL-8.3 A5 批量正向：容器件 + 子位件混批出库——子位件 loc 保留历史、e2e merge 零冲突', () => {
  const st = seed();
  const p = planOf(st, issuBatch('b8-3', { loc: 'L-A' }, [
    { itemCode: 'I-CTN', containerCode: 'C-A', expectedItemVersion: 3, expectedContainerVersion: 2 },
    { itemCode: 'I-SUB', sub: true, locCode: 'SUB-A1', expectedItemVersion: 4 }
  ]), oper);
  assert.deepEqual(p.after.items, [
    { code: 'I-CTN', container: '', loc: '', status: 'out', version: 4, lastOpId: 'b8-3' },
    { code: 'I-SUB', container: '', loc: 'SUB-A1', status: 'out', version: 5, lastOpId: 'b8-3' }
  ], '子位出库不动 loc（历史线索，与单条 issue 同款）');
  assert.deepEqual(p.before.items, [
    { code: 'I-CTN', container: 'C-A', loc: 'L-A', status: 'in_stock', version: 3, lastOpId: 'rc-1' },
    { code: 'I-SUB', container: '', loc: 'SUB-A1', status: 'in_stock', version: 4, lastOpId: 'rs-1' }
  ], '容器件 before 补 srcCtn.loc（TASK-06R）；子位件 before.loc 即现存子位');
  /* e2e：混批 out 行（子位件 loc 保留）→ merge 零冲突 */
  const st2 = seed();
  const rows = structuredClone(p.after.items);
  const r = S.merge(st2, { items: rows, itemOperations: [apBatchLog('b8-3', 'issueBatch', structuredClone(rows))] });
  assert.deepEqual(r.conflicts.map(c => c.table + ':' + c.key), [], '混批出库必须零冲突落地');
  const sub = st2.items.find(x => x.code === 'I-SUB');
  assert.deepEqual({ status: sub.status, container: sub.container, loc: sub.loc, version: sub.version }, { status: 'out', container: '', loc: 'SUB-A1', version: 5 });
});

test('SCL-8.4 A5 批量负向：声明子位不符/FREE 位兜底/条目带容器码/不在库 → 全部拒绝（均带 @件码）', () => {
  const st = seed();
  const src = { loc: 'SUB-A1' };
  /* 声明子位与物品现存子位不符 → SOURCE_MISMATCH（先于 unique/active/role） */
  assert.throws(() => planOf(st, issuBatch('b8-4a', src, [{ itemCode: 'I-SUB', sub: true, locCode: 'SUB-NX', expectedItemVersion: 4 }]), oper), e => e.code === 'SOURCE_MISMATCH' && /@ I-SUB$/.test(e.message));
  /* 防御性：损坏行（在库但 loc 指向 FREE 位）声明 sub 源 → 角色闸门兜底（SOURCE_MISMATCH 之后） */
  st.items.push(U.normalize('items', { code: 'I-X', status: 'in_stock', container: '', loc: 'L-A', version: 1, lastOpId: 'x-1' }));
  assert.throws(() => planOf(st, issuBatch('b8-4b', src, [{ itemCode: 'I-X', sub: true, locCode: 'L-A', expectedItemVersion: 1 }]), oper), e => e.code === 'LOC_ROLE_MISMATCH' && /@ I-X$/.test(e.message));
  /* 子位条目带 containerCode = 旧客户端误用 → INVALID_CODE */
  assert.throws(() => planOf(st, issuBatch('b8-4c', src, [{ itemCode: 'I-SUB', sub: true, locCode: 'SUB-A1', containerCode: 'C-A', expectedItemVersion: 4 }]), oper), e => e.code === 'INVALID_CODE' && /@ I-SUB$/.test(e.message));
  /* 非在库先于子位分支拒绝（unique-items.js:306 状态门禁在 split 之前） */
  assert.throws(() => planOf(st, issuBatch('b8-4d', src, [{ itemCode: 'I-OUT', sub: true, locCode: 'SUB-A1', expectedItemVersion: 5 }]), oper), e => e.code === 'INVALID_TRANSITION' && /@ I-OUT$/.test(e.message));
});

test('SCL-8.5 P2 溢出修复回归：容器锚点批量入库 out 件 → 历史子位 loc 显式清空（XOR 不变量）', () => {
  const st = seed();
  const p = planOf(st, recvBatch('b8-5', { loc: 'L-A' }, [
    { itemCode: 'I-OUT', containerCode: 'C-A', expectedItemVersion: 5, expectedContainerVersion: 2 }
  ]), oper);
  assert.deepEqual(p.after.items, [{ code: 'I-OUT', container: 'C-A', loc: '', status: 'in_stock', version: 6, lastOpId: 'b8-5' }]);
  assert.equal(p.after.items[0].loc, '', 'out 件残留的子位 loc 必须清空——否则 in_stock 双写是 B1 永久冲突');
  /* merge 侧双保险：该行必须零冲突落地（SCL-7.11 的双写冲突形态不会再出现） */
  const st2 = seed();
  const rows = structuredClone(p.after.items);
  const r = S.merge(st2, { items: rows, itemOperations: [apBatchLog('b8-5', 'receiveBatch', structuredClone(rows))] });
  assert.deepEqual(r.conflicts, []);
});

test('SCL-8.6 A7 批量鉴别器红线：无 sub 键 → 旧 pair/容器路径，绝不静默子位化', () => {
  const st = seed();
  /* 入库：target 无 sub 键 + 条目 containerCode:'' → pair 路径 code('') → INVALID_CODE（不是子位直存） */
  assert.throws(() => planOf(st, recvBatch('b8-6a', { loc: 'SUB-A1' }, [{ itemCode: 'I-OUT', containerCode: '', expectedItemVersion: 5 }]), oper), e => e.code === 'INVALID_CODE' && /@ I-OUT$/.test(e.message));
  /* 出库：条目无 sub 键 → 容器路径 item.container='' → SOURCE_MISMATCH（不是子位直出） */
  assert.throws(() => planOf(st, issuBatch('b8-6b', { loc: 'SUB-A1' }, [{ itemCode: 'I-SUB', containerCode: '', expectedItemVersion: 4 }]), oper), e => e.code === 'SOURCE_MISMATCH' && /@ I-SUB$/.test(e.message));
});

test('SCL-8.7 C5 批量扫描器：子位 LOC 一步成锚、2 值行 stepsFor 与 sub 请求形状；容器锚点回归不变', () => {
  const st = seed();
  st.items.push(U.normalize('items', { code: 'I-P', status: 'pending', container: '', loc: '', version: 1, lastOpId: 'reg-1' }));
  let n = 0;
  const scan = Scan.create({ getState: () => st, id: () => 'id-' + (++n) });
  scan.startBatch('receive');
  scan.setBatchQty(2);
  /* 子位 LOC 一步完成锚点（无 CTN 步） */
  const a = scan.acceptBatchCode({ type: 'LOC', code: 'SUB-A1' });
  assert.equal(a.stage, 'anchor');
  assert.deepEqual(scan.batchState().anchor, { loc: 'SUB-A1', ctn: null, sub: true });
  /* 连扫物品 → 每件一条 2 值行 */
  assert.equal(scan.acceptBatchCode({ type: 'ITM', code: 'I-OUT' }).stage, 'item');
  scan.acceptBatchCode({ type: 'ITM', code: 'I-P' });
  const snap = scan.snapshot();
  const rows = snap.rows.filter(r => !r.locked && r.values.some(v => v.type === 'ITM'));
  assert.equal(rows.length, 2);
  rows.forEach(r => {
    assert.deepEqual(scan.stepsFor(r), ['LOC', 'ITM'], '子位锚点行两步表');
    assert.deepEqual(r.values.map(v => v.type), ['LOC', 'ITM']);
    assert.equal(r.values[0].code, 'SUB-A1');
  });
  /* 2 值行 request() 形状：target sub + expected 只派 itemVersion（容器版本种子被整体替换） */
  scan.select(snap.rows.indexOf(rows[0]));
  const q = scan.request();
  assert.equal(q.kind, 'receive');
  assert.equal(q.itemCode, 'I-OUT');
  assert.deepEqual(q.target, { loc: 'SUB-A1', container: '', sub: true });
  assert.deepEqual(q.expected, { itemVersion: 5 });
  /* 容器锚点回归：LOC→CTN 两步锚定、3 值行原表 */
  scan.startBatch('receive');
  scan.setBatchQty(1);
  assert.equal(scan.acceptBatchCode({ type: 'LOC', code: 'L-A' }).stage, 'anchor');
  assert.equal(scan.batchState().anchor, null, 'FREE 位锚点未完成（等容器）');
  scan.acceptBatchCode({ type: 'CTN', code: 'C-A' });
  assert.deepEqual(scan.batchState().anchor, { loc: 'L-A', ctn: 'C-A', ctnVersion: 2 });
  scan.acceptBatchCode({ type: 'ITM', code: 'I-P' });
  const snap2 = scan.snapshot();
  const row2 = snap2.rows.filter(r => !r.locked && r.values.some(v => v.type === 'ITM'))[0];
  assert.deepEqual(scan.stepsFor(row2), ['LOC', 'CTN', 'ITM'], '容器锚点行三步原表');
  assert.deepEqual(row2.values.map(v => v.type), ['LOC', 'CTN', 'ITM']);
  assert.deepEqual(row2.values.map(v => v.code), ['L-A', 'C-A', 'I-P']);
});
