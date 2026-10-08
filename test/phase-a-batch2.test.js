'use strict';
/* =========================================================================
 * Phase A 第 2 批次（A-2 + A-3）：容器库位模型重构
 * · A-2 activateContainer 纯激活：不解析 target、不写/不校验 loc；幂等收窄为
 *   只看 status；after 显式 loc:''（绝不保留旧值）；真实激活（unknown/disabled
 *   → active）保留 expected.containerVersion 版本前置。
 * · A-3 activateLocation 增量A：旧模型「自身占用」放行，并在同一计划内显式
 *   清除父容器行的 loc（一条命令一条 APPLIED 日志 = 子位标注 + 旧绑定清除凭据）；
 *   他者占用仍 LOC_ALREADY_BOUND。
 * · A-3 activateLocation 增量B：解除从属专门形态（role:'自由位' + parentContainer:''
 *   + confirmSublocUnbind:true）；子位下仍有在库物品 → SUBLOC_OCCUPIED；通过后
 *   role/parentContainer 双重清除。
 * · CONTROLLED 形状锁：历史 APPLIED 凭证字段集契约（字段集不可变，值可变）。
 * 命名约定：PA2-x = A-2 套件；PA3-x = A-3 套件；PA4-x = 形状锁。
 * ========================================================================= */
const test = require('node:test'), assert = require('node:assert/strict');
const U = require('../lib/unique-items');

const admin = { id: 'u-admin', roles: ['admin'] };
const oper = { id: 'u-op', roles: ['operator'] };
function planOf(state, request, actor) { return U.plan(state, request, actor); }

/* 标准种子：C-OLD/C-ACT 停在旧模型 loc 上（unknown/active 各一）；C-P 占着自由位
 * L-SELF（增量A 的自身占用场景）；C-X 占着 L-OTHER（他者占用场景）；SUB-1 有在库
 * 占用件 + 出库历史件，SUB-2 无任何物品（增量B 场景）。 */
function seed() {
  return U.migrate({
    locations: [
      { code: 'L-OLD', status: 'unknown', role: '', parentContainer: '' },
      { code: 'L-ACT', status: 'unknown', role: '', parentContainer: '' },
      { code: 'L-SELF', status: 'active', role: '', parentContainer: '' },
      { code: 'L-OTHER', status: 'active', role: '', parentContainer: '' },
      { code: 'L-FRESH', status: 'active', role: '', parentContainer: '' },
      { code: 'SUB-1', status: 'active', role: '容器子位', parentContainer: 'C-P' },
      { code: 'SUB-2', status: 'active', role: '容器子位', parentContainer: 'C-P' }
    ],
    containers: [
      { code: 'C-OLD', loc: 'L-OLD', status: 'unknown', version: 5, lastOpId: 'seed-1' },
      { code: 'C-ACT', loc: 'L-ACT', status: 'active', version: 9, lastOpId: 'seed-2' },
      { code: 'C-P', loc: 'L-SELF', status: 'active', version: 3, lastOpId: 'seed-3' },
      { code: 'C-X', loc: 'L-OTHER', status: 'active', version: 1, lastOpId: 'seed-4' }
    ],
    items: [
      { code: 'I-IN', name: '在库占用件', status: 'in_stock', container: '', loc: 'SUB-1', version: 2, lastOpId: 'seed-5' },
      { code: 'I-HIST', name: '出库历史件', status: 'out', container: '', loc: 'SUB-1', version: 3, lastOpId: 'seed-6' }
    ],
    itemOperations: []
  });
}

/* ============================ ① A-2：纯激活 ============================ */

test('PA2-1 A-2 纯激活：unknown 容器激活后 loc 显式清空；target 不再解析（LEGACY 路径消失）', () => {
  const st = seed();
  /* 真实激活：unknown v5 → active；before 留旧 loc 供审计，after 显式 loc:''（绝不保留旧值） */
  const p = planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-1a', containerCode: 'C-OLD', expected: { containerVersion: 5 } }, admin);
  assert.deepEqual(p.before.containers, [{ code: 'C-OLD', loc: 'L-OLD', status: 'unknown', version: 5, lastOpId: 'seed-1' }]);
  assert.deepEqual(p.after.containers, [{ code: 'C-OLD', loc: '', status: 'active', version: 6, lastOpId: 'pa2-1a' }]);
  /* 旧客户端仍带 target：彻底忽略——目标位不存在也不报错、不落 loc（容器从属唯一落点是 placeContainer/moveContainer） */
  const p2 = planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-1b', containerCode: 'C-OLD', target: { loc: 'NO-SUCH-LOC' }, expected: { containerVersion: 5 } }, admin);
  assert.deepEqual(p2.after.containers, [{ code: 'C-OLD', loc: '', status: 'active', version: 6, lastOpId: 'pa2-1b' }]);
  /* LEGACY_LOCATION_CONFLICT 不再由本命令产出：旧 loc 与 target 指向不一致照常激活 */
  const p3 = planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-1c', containerCode: 'C-OLD', target: { loc: 'L-ACT' }, expected: { containerVersion: 5 } }, admin);
  assert.equal(p3.after.containers[0].loc, '');
});

test('PA2-2 A-2 幂等收窄为只看 status：active 跳过版本前置；真实激活照旧强制版本一致', () => {
  const st = seed();
  /* active 容器 + 错误版本声明 → 幂等重确认照常成功（version 照常 +1，lastOpId 换新凭据） */
  const p = planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-2a', containerCode: 'C-ACT', expected: { containerVersion: 2 } }, admin);
  assert.deepEqual(p.after.containers, [{ code: 'C-ACT', loc: '', status: 'active', version: 10, lastOpId: 'pa2-2a' }]);
  /* active 容器 + 完全不带 expected → 同样放行（expected 缺省安全） */
  const p2 = planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-2b', containerCode: 'C-ACT' }, admin);
  assert.equal(p2.after.containers[0].version, 10);
  /* 同一错误版本用在 unknown 容器上 → VERSION_CONFLICT（真实变更保留版本门禁） */
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-2c', containerCode: 'C-OLD', expected: { containerVersion: 2 } }, admin), e => e.code === 'VERSION_CONFLICT');
  /* disabled 容器同样走真实变更路径：版本不符拒绝，版本一致激活 */
  st.containers.push(U.normalize('containers', { code: 'C-DIS', loc: '', status: 'disabled', version: 4, lastOpId: 'seed-7' }));
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-2d', containerCode: 'C-DIS', expected: { containerVersion: 9 } }, admin), e => e.code === 'VERSION_CONFLICT');
  const p3 = planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-2e', containerCode: 'C-DIS', expected: { containerVersion: 4 } }, admin);
  assert.deepEqual(p3.after.containers, [{ code: 'C-DIS', loc: '', status: 'active', version: 5, lastOpId: 'pa2-2e' }]);
});

test('PA2-3 A-2 边界守卫原样：retired 容器 STATE_CONFLICT、非 admin FORBIDDEN', () => {
  const st = seed();
  st.containers.push(U.normalize('containers', { code: 'C-RET', loc: '', status: 'retired', version: 1, lastOpId: 'seed-8' }));
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-3a', containerCode: 'C-RET', expected: { containerVersion: 1 } }, admin), e => e.code === 'STATE_CONFLICT');
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateContainer', opId: 'pa2-3b', containerCode: 'C-OLD', expected: { containerVersion: 5 } }, oper), e => e.code === 'FORBIDDEN');
});

/* ==================== ② A-3 增量A：自身占用放行 ==================== */

test('PA3-1 A-3 增量A 自身占用放行：同一计划内子位化标注 + 父容器旧 loc 显式清除（一条命令一条凭据）', () => {
  const st = seed();
  const p = planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'pa3-1', locationCode: 'L-SELF', role: '容器子位', parentContainer: 'C-P' }, admin);
  assert.deepEqual(p.after.locations, [{ code: 'L-SELF', status: 'active', role: '容器子位', parentContainer: 'C-P' }]);
  assert.deepEqual(p.after.containers, [{ code: 'C-P', loc: '', status: 'active', version: 4, lastOpId: 'pa3-1' }], '旧模型占位在同一计划显式清除：CONTROLLED 字段集不变、loc 显式空串');
  assert.deepEqual(p.before.containers, [{ code: 'C-P', loc: 'L-SELF', status: 'active', version: 3, lastOpId: 'seed-3' }], 'before 留旧绑定供审计');
});

test('PA3-2 A-3 增量A 他者占用仍拒绝；无旧模型绑定的 FREE 位不触碰容器行', () => {
  const st = seed();
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'pa3-2a', locationCode: 'L-OTHER', role: '容器子位', parentContainer: 'C-P' }, admin), e => e.code === 'LOC_ALREADY_BOUND', 'L-OTHER 被 C-X 占用，声明的父容器却是 C-P → 拒绝');
  const p = planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'pa3-2b', locationCode: 'L-FRESH', role: '容器子位', parentContainer: 'C-P' }, admin);
  assert.deepEqual(p.after.locations, [{ code: 'L-FRESH', status: 'active', role: '容器子位', parentContainer: 'C-P' }]);
  assert.equal(p.after.containers, undefined, '无旧模型绑定时计划不产出容器变更');
});

/* ==================== ③ A-3 增量B：解除从属专门形态 ==================== */

test('PA3-3 A-3 增量B 占用者门禁：子位下仍有在库物品 → SUBLOC_OCCUPIED；缺 confirmSublocUnbind 仍按未给形态拒绝', () => {
  const st = seed();
  const unbind = opId => ({ schemaVersion: 1, kind: 'activateLocation', opId, locationCode: 'SUB-1', role: '自由位', parentContainer: '', confirmSublocUnbind: true });
  assert.throws(() => planOf(st, unbind('pa3-3a'), admin), e => e.code === 'SUBLOC_OCCUPIED' && /I-IN/.test(e.message), 'SUB-1 有在库占用件 I-IN → 拒绝并指名');
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'pa3-3b', locationCode: 'SUB-1', role: '自由位', parentContainer: '' }, admin), e => e.code === 'SUBLOC_UNBIND_UNSPECIFIED', '缺 confirmSublocUnbind = 未给解除形态');
});

test('PA3-4 A-3 增量B 解绑成功：role 显式自由位 + parentContainer 清空；out 历史件不算占用', () => {
  const st = seed();
  st.items = st.items.filter(x => x.code !== 'I-IN');   // 前置：占用件已移出（不在本命令职责内）
  const p = planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'pa3-4a', locationCode: 'SUB-1', role: '自由位', parentContainer: '', confirmSublocUnbind: true }, admin);
  assert.deepEqual(p.after.locations, [{ code: 'SUB-1', status: 'active', role: '自由位', parentContainer: '' }], '解绑：role 显式落「自由位」，parentContainer 清空（飞书单选不靠空串清值）');
  assert.deepEqual(p.before.locations, [{ code: 'SUB-1', status: 'active', role: '容器子位', parentContainer: 'C-P' }]);
  /* SUB-1 上仅剩 out 件 I-HIST（loc 是历史线索）未阻挡解绑；SUB-2 完全无物品照常解绑 */
  const p2 = planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'pa3-4b', locationCode: 'SUB-2', role: '自由位', parentContainer: '', confirmSublocUnbind: true }, admin);
  assert.deepEqual(p2.after.locations, [{ code: 'SUB-2', status: 'active', role: '自由位', parentContainer: '' }]);
});

test('PA3-5 A-3 权限边界：activateLocation 的子位化与解绑形态都是 admin 专属', () => {
  const st = seed();
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'pa3-5a', locationCode: 'L-FRESH', role: '容器子位', parentContainer: 'C-P' }, oper), e => e.code === 'FORBIDDEN');
  assert.throws(() => planOf(st, { schemaVersion: 1, kind: 'activateLocation', opId: 'pa3-5b', locationCode: 'SUB-2', role: '自由位', parentContainer: '', confirmSublocUnbind: true }, oper), e => e.code === 'FORBIDDEN');
});

/* ==================== ④ CONTROLLED 形状锁 ==================== */

test('PA4-1 CONTROLLED 形状锁：历史 APPLIED 凭证字段集契约——本批次零变更', () => {
  assert.deepEqual(U.CONTROLLED, {
    items: ['container', 'loc', 'status', 'version', 'lastOpId'],
    containers: ['loc', 'status', 'version', 'lastOpId'],
    locations: ['status', 'role', 'parentContainer']
  });
  assert.equal(U.KINDS.includes('activateLocation') && U.KINDS.includes('activateContainer'), true, '两个激活命令仍在命令面（本批次不增删 KINDS）');
});
