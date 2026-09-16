'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TWM = require('../lib/three-way-merge.js');

const MAT = (fields) => ({ materials: fields });
const plan1 = (base, local, remote, opts) => TWM.planMerge(
  base === null ? null : { materials: base },
  { materials: local },
  { materials: remote },
  opts);

/* ================= 三方矩阵穷举（3×3×3 = 27 组） ================= */

test('三方矩阵：穷举 27 组 base × local × remote，逐组核对结果', () => {
  const V = ['', 'A', 'B'];   // '' = 空
  const expect = (b, l, r) => {
    if (l === r) return 'none';            // 一致
    if (l === b) return 'remote';          // 本地没动 → 采纳远端
    if (r === b) return 'local';           // 远端没动 → 保留本地
    return 'conflict';                     // 三者互不相同
  };
  let checked = 0;
  for (const b of V) for (const l of V) for (const r of V) {
    // 三份都**保留同一条记录**，只让字段值为空/非空 ——
    // 「记录不存在」是另一回事（计划里判 create / deleteCandidate），不混进字段矩阵
    const p = plan1([{ code: 'K', f: b }], [{ code: 'K', f: l }], [{ code: 'K', f: r }]);
    const want = expect(b, l, r);
    const w = (p.writes[0] && p.writes[0].fields) || {};
    if (want === 'none') {
      assert.equal(p.conflicts.length, 0, `b=${b} l=${l} r=${r} 不该冲突`);
      assert.equal(w.f, undefined, `b=${b} l=${l} r=${r} 不该写`);
    } else if (want === 'remote') {
      assert.equal(p.conflicts.length, 0, `b=${b} l=${l} r=${r} 本地没动，不该冲突`);
      if (l !== r) assert.ok('f' in w, `b=${b} l=${l} r=${r} 应采纳远端`);
    } else if (want === 'local') {
      assert.equal(p.conflicts.length, 0, `b=${b} l=${l} r=${r} 远端没动，不该冲突`);
      assert.equal(w.f, undefined, `b=${b} l=${l} r=${r} 不该写`);
    } else {
      assert.equal(p.conflicts.length, 1, `b=${b} l=${l} r=${r} 应判为真双改`);
    }
    checked++;
  }
  assert.equal(checked, 27, '必须真的穷举 27 组');
});

/* ================= 空值歧义（方案点名的两个方向） ================= */

test('空值歧义：base 非空 + 远端清空 + 本地未动 → 必须采纳远端清空', () => {
  const p = plan1([{ code: 'K', f: '原值' }], [{ code: 'K', f: '原值' }], [{ code: 'K', f: '' }]);
  assert.equal(p.conflicts.length, 0, '本地没动过，这不是冲突');
  assert.equal(p.writes[0].fields.f, '', '人在飞书里明确删掉了，必须清空本地');
});

test('空值歧义：base 空 + 远端空 + 本地有值 → 保留本地（远端本来就没有）', () => {
  const p = plan1([{ code: 'K', f: '' }], [{ code: 'K', f: '本地填的' }], [{ code: 'K', f: '' }]);
  assert.equal(p.conflicts.length, 0);
  assert.equal(p.writes.length, 0, '远端没动 → 不该写任何东西');
});

/* ================= 量化收益：500 + 20 → 确认数 == 20 ================= */

test('三方合并【核心】500 条远端单方改动 + 20 条真双改 → 需确认 == 20', () => {
  const base = [], local = [], remote = [];
  for (let i = 0; i < 520; i++) {
    const k = 'K' + i;
    base.push({ code: k, name: '原名' + i, spec: 'S' });
    if (i < 500) {                       // 仅远端改
      local.push({ code: k, name: '原名' + i, spec: 'S' });
      remote.push({ code: k, name: '飞书改的' + i, spec: 'S' });
    } else {                             // 真双改
      local.push({ code: k, name: '本地改的' + i, spec: 'S' });
      remote.push({ code: k, name: '飞书也改的' + i, spec: 'S' });
    }
  }
  const p = TWM.planMerge({ materials: base }, { materials: local }, { materials: remote });
  assert.equal(p.conflicts.length, 20, '两方合并要问 ≥500 条；三方只该问 20 条，实测 ' + p.conflicts.length);
  assert.equal(p.groups.length, 1, '20 条同类冲突应聚成 1 组');
  assert.equal(p.groups[0].field, 'name');
  assert.equal(p.groups[0].count, 20);
  // 500 条单方改动全部自动快进，不打扰人
  const autoKeys = p.writes.filter(w => w.kind === 'update').length;
  assert.equal(autoKeys, 500, '远端单方改动应全部自动应用，实测 ' + autoKeys);
});

/* ================= 无 base 时降级为保守策略 ================= */

test('三方合并【降级】没有 base 时不猜谁改的，一律转人工', () => {
  const p = TWM.planMerge(null,
    { materials: [{ code: 'K', name: '本地' }] },
    { materials: [{ code: 'K', name: '飞书' }] });
  assert.equal(p.degraded, true);
  assert.equal(p.conflicts.length, 1, '无 base 时不能静默挑一个赢');
  // 但「本地空、远端有值」这种单向补齐仍可自动
  const p2 = TWM.planMerge(null,
    { materials: [{ code: 'K', name: '' }] },
    { materials: [{ code: 'K', name: '飞书' }] });
  assert.equal(p2.conflicts.length, 0);
  assert.equal(p2.writes[0].fields.name, '飞书');
});

/* ================= 分组：5000 冲突 → 少量组，且够快 ================= */

test('三方合并【核心】5000 条冲突按「表×类型×字段」分组 → <50 组且 <50ms', () => {
  const conflicts = [];
  for (let i = 0; i < 5000; i++) {
    conflicts.push({ table: 'materials', key: 'K' + i, field: 'name', base: 'b', local: 'l', remote: 'r', kind: 'update' });
  }
  const t0 = Date.now();
  const groups = TWM.groupConflicts(conflicts);
  const ms = Date.now() - t0;
  assert.equal(groups.length, 1, '同表同字段应聚成 1 组');
  assert.equal(groups[0].count, 5000);
  assert.ok(groups[0].samples.length <= 20, '组内只留少量样例，避免面板被淹没');
  assert.ok(ms < 50, '分组必须 <50ms，实测 ' + ms + 'ms');

  // 多表多字段时组数仍然很少
  const many = [];
  ['materials', 'members', 'containers'].forEach(t => ['name', 'spec', 'qty'].forEach(f => {
    for (let i = 0; i < 100; i++) many.push({ table: t, key: 'K' + i, field: f, kind: 'update' });
  }));
  const g2 = TWM.groupConflicts(many);
  assert.equal(g2.length, 9, '3 表 × 3 字段 = 9 组');
  assert.ok(g2.length < 50, '5000 条量级也要远小于 50 组');
});

/* ================= 自动快进 / 新增 / 待核删 ================= */

test('三方合并：远端新增的记录自动加入；本地新建的保留不动', () => {
  const p = TWM.planMerge({ materials: [] },
    { materials: [{ code: 'LOCAL-NEW', name: '本地新建' }] },
    { materials: [{ code: 'REMOTE-NEW', name: '飞书新建' }] });
  const created = p.writes.filter(w => w.kind === 'create');
  assert.equal(created.length, 1);
  assert.equal(created[0].key, 'REMOTE-NEW');
  assert.equal(p.deleteCandidates.length, 0, '本地新建不是删除候选');
});

test('三方合并：base 有、远端没了 → 只列为待核删，不自动删', () => {
  const p = TWM.planMerge({ materials: [{ code: 'K', name: 'x' }] },
    { materials: [{ code: 'K', name: 'x' }] },
    { materials: [] });
  assert.equal(p.deleteCandidates.length, 1);
  assert.equal(p.deleteCandidates[0].key, 'K');
  assert.equal(p.writes.length, 0, '删除绝不在合并里自动执行（要过 census 闸门）');
});

test('三方合并：protect 名单里的字段以本地为准，不算冲突', () => {
  const p = TWM.planMerge({ workorders: [{ code: 'W', status: '未执行' }] },
    { workorders: [{ code: 'W', status: '部分执行' }] },
    { workorders: [{ code: 'W', status: '未执行' }] },
    { protect: { workorders: { W: ['status'] } } });
  assert.equal(p.conflicts.length, 0, '推不上去的字段不该被判成冲突');
  assert.equal(p.writes.length, 0);
});

/* ================= applyMerge → undo → 深度相等 ================= */

test('applyMerge【核心】应用后可完全回滚（deep-equal）', () => {
  const state = {
    materials: [{ code: 'A', name: '本地A' }, { code: 'B', name: '本地B' }],
    transactions: [], txnSeq: 0
  };
  const before = JSON.stringify(state);
  const plan = TWM.planMerge(
    { materials: [{ code: 'A', name: '原A' }, { code: 'B', name: '原B' }] },
    { materials: [{ code: 'A', name: '本地A' }, { code: 'B', name: '本地B' }] },
    { materials: [{ code: 'A', name: '飞书A' }, { code: 'C', name: '飞书新增C' }] });

  const r = TWM.applyMerge(state, plan, {});
  assert.ok(r.applied > 0);
  assert.notEqual(JSON.stringify(state), before, '应用后必须真的变了');
  assert.ok(state.materials.find(m => m.code === 'C'), '新增记录应写进 state');

  TWM.undoMerge(state, r.snapshot);
  assert.equal(JSON.stringify(state), before, '回滚后必须与原来深度相等');
});

test('applyMerge：人工裁决 local / remote 都能落到 state，且可回滚', () => {
  const plan = TWM.planMerge({ materials: [{ code: 'K', name: '原' }] },
    { materials: [{ code: 'K', name: '本地改' }] },
    { materials: [{ code: 'K', name: '飞书改' }] });
  assert.equal(plan.conflicts.length, 1);
  const rid = plan.conflicts[0].table + '\u0000' + plan.conflicts[0].key + '\u0000' + plan.conflicts[0].field;

  const s1 = { materials: [{ code: 'K', name: '本地改' }] };
  TWM.applyMerge(s1, plan, { [rid]: 'remote' });
  assert.equal(s1.materials[0].name, '飞书改', '裁决 remote 应采纳飞书值');

  const s2 = { materials: [{ code: 'K', name: '本地改' }] };
  const r2 = TWM.applyMerge(s2, plan, { [rid]: 'local' });
  assert.equal(s2.materials[0].name, '本地改', '裁决 local 应保留本地值');
  TWM.undoMerge(s2, r2.snapshot);
  assert.equal(s2.materials[0].name, '本地改');
});

test('applyMerge：未裁决的冲突保持本地原值（绝不替人做决定）', () => {
  const state = { materials: [{ code: 'K', name: '本地改' }] };
  const plan = TWM.planMerge({ materials: [{ code: 'K', name: '原' }] },
    { materials: [{ code: 'K', name: '本地改' }] },
    { materials: [{ code: 'K', name: '飞书改' }] });
  TWM.applyMerge(state, plan, {});
  assert.equal(state.materials[0].name, '本地改');
});

test('planText：给人看的一句话里包含关键数字与降级提示', () => {
  const p = TWM.planMerge(null, { materials: [{ code: 'K', name: 'l' }] }, { materials: [{ code: 'K', name: 'r' }] });
  const txt = TWM.planText(p);
  assert.match(txt, /需确认 1/);
  assert.match(txt, /无基线/);
});

test('三方合并【关键】base 必须跟着远端前进，否则会产生满屏假冲突', () => {
  // 第 1 轮：远端把 K 从「原」改成「v1」，本地没动 → 自动快进，无冲突
  let base = { materials: [{ code: 'K', name: '原' }] };
  let local = { materials: [{ code: 'K', name: '原' }] };
  let remote = { materials: [{ code: 'K', name: 'v1' }] };
  let p = TWM.planMerge(base, local, remote);
  assert.equal(p.conflicts.length, 0, '远端单方改动不该冲突');
  // 本地跟随远端
  local = { materials: [{ code: 'K', name: 'v1' }] };
  // base 前进到 v1（fsUpdateBase 做的事）
  base = { materials: [{ code: 'K', name: 'v1' }] };

  // 第 2 轮：远端又改成 v2，本地仍未动 → 仍应自动快进
  p = TWM.planMerge(base, local, { materials: [{ code: 'K', name: 'v2' }] });
  assert.equal(p.conflicts.length, 0, 'base 前进后不该把「本地跟随」误判成双改');
  assert.equal(p.writes[0].fields.name, 'v2');

  // 反例：base 忘了前进（仍是「原」）→ 就会误报冲突
  const stale = TWM.planMerge({ materials: [{ code: 'K', name: '原' }] }, local, { materials: [{ code: 'K', name: 'v2' }] });
  assert.equal(stale.conflicts.length, 1, 'base 不前进就会出现假冲突 —— 这正是必须 fsUpdateBase 的原因');
});

/* ================= P1：流水顺序与 txnSeq（原缺口，已实测复现） ================= */

test('applyMerge【P1·关键】流水必须新的在前，且 txnSeq 必须推进到最大 seq', () => {
  // 原缺口：applyMerge 对不存在的记录一律 push 到尾部，且不推进 txnSeq。
  // 实测后果：order=[5,4,6,7]（新流水被塞到尾部）；txnSeq 停在 5
  //   → 本地下一笔 recordTransaction 会拿到已被远端占用的 seq=6，
  //     正是 Phase 0 修掉的「流水号撞号」在增量路径上复活。
  const state = { transactions: [{ seq: 5 }, { seq: 4 }], txnSeq: 5, materials: [] };
  const plan = {
    writes: [
      { table: 'transactions', key: '6', fields: { seq: 6, matCode: 'A', delta: 1 }, kind: 'create' },
      { table: 'transactions', key: '7', fields: { seq: 7, matCode: 'A', delta: 1 }, kind: 'create' }
    ],
    conflicts: []
  };
  TWM.applyMerge(state, plan, {});
  assert.deepEqual(state.transactions.map(t => t.seq), [7, 6, 5, 4], '必须严格降序（新的在前）');
  assert.equal(state.txnSeq, 7, 'txnSeq 必须推进到最大 seq，否则本地下一笔会撞号');
});

test('applyMerge【P1】没有流水时不该凭空造出 transactions 数组或改 txnSeq', () => {
  const state = { materials: [{ code: 'A' }] };
  TWM.applyMerge(state, { writes: [{ table: 'materials', key: 'A', fields: { name: 'x' } }], conflicts: [] }, {});
  assert.equal(state.transactions, undefined, '没有流水就不该出现该字段');
  assert.equal(state.txnSeq, undefined);
});

test('applyMerge【P1】无 seq 的旧流水仍拼在尾部，不被排序打乱', () => {
  const state = { transactions: [{ seq: null, matCode: 'A', time: 'old' }, { seq: 3 }], txnSeq: 3 };
  TWM.applyMerge(state, { writes: [{ table: 'transactions', key: '4', fields: { seq: 4, matCode: 'A' } }], conflicts: [] }, {});
  assert.deepEqual(state.transactions.map(t => t.seq), [4, 3, null], '带 seq 的降序在前，无 seq 的旧数据在后');
  assert.equal(state.txnSeq, 4);
});

/* ============================================================================
 * P4-1 qty 冲突必须换算成增量走账本，不能写绝对值
 *
 * 为什么：qty 是**派生量**（= 账本期初 + Σ变动），不是可以直接覆盖的普通字段。
 * 「保留本地」的真正含义是「把本地这次改动也应用上去」。直接写 c.local 会在
 * 两端并发时把对方在我们读快照之后做的改动整段抹掉，而且不记流水、无从追溯。
 * ========================================================================== */

test('applyMerge【P4 核心】qty「保留本地」必须写成 远端 + (本地 − 基线)，并产出库存直写', () => {
  const st = { materials: [{ code: 'M', qty: 10 }] } ;
  const conflicts = [{ table: 'materials', key: 'M', field: 'qty', base: 8, local: 10, remote: 13, kind: 'update' }];
  const r = TWM.applyMerge(st, { writes: [], conflicts }, { 'materials\u0000M\u0000qty': 'local' });
  // 本地相对基线 +2；对方在我们读取之后把它改到了 13 → 结果必须是 15，而不是本地的 10
  assert.equal(st.materials[0].qty, 15, '必须是 remote + (local - base) = 13 + 2 = 15');
  assert.equal(r.stockWrites.length, 1, '必须产出一条库存直写（走账本、记流水）');
  assert.deepEqual(
    { matCode: r.stockWrites[0].matCode, qty: r.stockWrites[0].qty, delta: r.stockWrites[0].delta },
    { matCode: 'M', qty: 15, delta: 2 });
});

test('applyMerge【P4】qty「采用飞书」不产出库存直写（本地对齐即可，飞书本来就是这个值）', () => {
  const st = { materials: [{ code: 'M', qty: 10 }] };
  const conflicts = [{ table: 'materials', key: 'M', field: 'qty', base: 8, local: 10, remote: 13, kind: 'update' }];
  const r = TWM.applyMerge(st, { writes: [], conflicts }, { 'materials\u0000M\u0000qty': 'remote' });
  assert.equal(st.materials[0].qty, 13);
  assert.equal(r.stockWrites.length, 0, '采用飞书不需要写回账本');
  assert.equal(r.needsStocktake.length, 0);
});

test('applyMerge【P4】qty 降级模式（无基线）不猜增量，要求走盘点', () => {
  const st = { materials: [{ code: 'M', qty: 10 }] };
  const conflicts = [{ table: 'materials', key: 'M', field: 'qty', base: undefined, local: 10, remote: 13, kind: 'update' }];
  const r = TWM.applyMerge(st, { writes: [], conflicts }, { 'materials\u0000M\u0000qty': 'local' });
  assert.equal(r.needsStocktake.length, 1, '缺基线 → 必须列为「需要盘点」而不是硬猜');
  assert.equal(r.stockWrites.length, 0, '绝不能凭猜写回飞书');
  assert.equal(st.materials[0].qty, 10, '保持本地原值不动');
});

test('applyMerge【P4】非 qty 字段仍然按绝对值落地（不能一刀切）', () => {
  const st = { materials: [{ code: 'M', name: '本地名', qty: 10 }] };
  const conflicts = [{ table: 'materials', key: 'M', field: 'name', base: '旧', local: '本地名', remote: '飞书名', kind: 'update' }];
  const r = TWM.applyMerge(st, { writes: [], conflicts }, { 'materials\u0000M\u0000name': 'local' });
  assert.equal(st.materials[0].name, '本地名');
  assert.equal(r.stockWrites.length, 0);
});

test('applyMerge【P4 闸门】plan.writes 里「更新型」的绝对 qty 必须被剥掉', () => {
  const st = { materials: [{ code: 'M', qty: 10, name: 'X' }] };
  const r = TWM.applyMerge(st, {
    writes: [{ table: 'materials', key: 'M', kind: 'update', fields: { qty: 999, name: 'Y' } }],
    conflicts: []
  }, {});
  assert.equal(st.materials[0].qty, 10, '绝对 qty 绝不能通过 updates 路径写进本地');
  assert.equal(st.materials[0].name, 'Y', '其它字段照常');
  assert.deepEqual(r.strippedQty, [{ key: 'M', qty: 999 }], '要如实报出来，不能静默');
});

test('applyMerge【P4】create 路径的 qty 是新建记录的初值，允许落地', () => {
  const st = { materials: [] };
  const r = TWM.applyMerge(st, {
    writes: [{ table: 'materials', key: 'NEW', kind: 'create', fields: { qty: 7, name: '新' } }], conflicts: []
  }, {});
  assert.equal(st.materials[0].qty, 7, '新建物料时 qty 就是它的初值（此时账本为空，不存在覆盖问题）');
  assert.equal(r.strippedQty.length, 0);
});

test('applyMerge【P4-4 核心】回滚必须连 __base 一起回退，否则旧值会被当成新改动推回飞书', () => {
  const st = { materials: [{ code: 'M', name: '本地' }], __base: { materials: [{ code: 'M', name: '基线' }] } };
  const before = JSON.stringify(st);
  const r = TWM.applyMerge(st, {
    writes: [{ table: 'materials', key: 'M', kind: 'update', fields: { name: '飞书新值' } }], conflicts: []
  }, {});
  st.__base = { materials: [{ code: 'M', name: '飞书新值' }] };   // 模拟 pull 期间基线前进了
  assert.equal(st.materials[0].name, '飞书新值');
  TWM.undoMerge(st, r.snapshot);
  assert.equal(st.materials[0].name, '本地', '数据要回退');
  assert.equal(JSON.stringify(st.__base), JSON.stringify({ materials: [{ code: 'M', name: '基线' }] }),
    '__base 也必须回到快照里的样子 —— 不回退的话「本地没改」会被误判成「本地改过」');
  assert.equal(JSON.stringify(st), before, '回滚后整体必须与原来完全一致');
});

test('applyMerge【P4-4】原本没有 __base 时，回滚不能凭空留一个 __base:null', () => {
  const st = { materials: [{ code: 'M', name: '本地' }] };
  const r = TWM.applyMerge(st, { writes: [{ table: 'materials', key: 'M', kind: 'update', fields: { name: 'R' } }], conflicts: [] }, {});
  TWM.undoMerge(st, r.snapshot);
  assert.equal('__base' in st, false, '键本来就没有 → 回滚后也不能有');
});

test('applyMerge【P4-4】旧格式快照（没有 hadBase）仍然可用，不抛错', () => {
  const st = { materials: [{ code: 'M', name: 'R' }], __base: { materials: [] } };
  TWM.undoMerge(st, { tables: { materials: [{ code: 'M', name: '旧' }] } });
  assert.equal(st.materials[0].name, '旧');
  assert.deepEqual(st.__base, { materials: [] }, '旧快照不回退 __base（兼容）');
});

/* ============================================================================
 * B1/B2（阶段二实测发现）：假冲突的两个来源
 * ========================================================================== */

test('B1【关键】结构相同的数组/对象不得判为「两边都改了」', () => {
  // 工单的 items 是数组 —— 只要用工作单就会走到这里
  const items = [{ matCode: 'M-1', qty: 2 }];
  const base = [{ code: 'WO-1', items, status: '未执行' }];
  const local = [{ code: 'WO-1', items: [{ matCode: 'M-1', qty: 2 }], status: '未执行' }];   // 新对象、同内容
  const remote = [{ code: 'WO-1', items: [{ matCode: 'M-1', qty: 2 }], status: '未执行' }];
  const p = TWM.planMerge({ workorders: base }, { workorders: local }, { workorders: remote });
  assert.equal(p.conflicts.length, 0,
    '内容完全相同（只是不同对象）不该产生冲突；旧实现用 === 比较数组，这里会报冲突');
  assert.equal(p.writes.length, 0, '也不该产生写入');
});

test('B1 数组内容真的不同时仍然要报冲突（不能为了消假冲突把真改动也吞掉）', () => {
  const base = [{ code: 'WO-1', items: [{ matCode: 'M-1', qty: 2 }] }];
  const local = [{ code: 'WO-1', items: [{ matCode: 'M-1', qty: 5 }] }];
  const remote = [{ code: 'WO-1', items: [{ matCode: 'M-1', qty: 3 }] }];
  const p = TWM.planMerge({ workorders: base }, { workorders: local }, { workorders: remote });
  assert.equal(p.conflicts.length, 1, '三边互不相同 → 必须报冲突');
  assert.equal(p.conflicts[0].field, 'items');
});

test('B1 数组元素顺序不同算改动（执行批次的顺序是有意义的历史）', () => {
  const base = [{ code: 'WO-1', execBatches: [{ at: 'a' }, { at: 'b' }] }];
  const local = [{ code: 'WO-1', execBatches: [{ at: 'b' }, { at: 'a' }] }];
  const remote = [{ code: 'WO-1', execBatches: [{ at: 'a' }, { at: 'b' }] }];
  const p = TWM.planMerge({ workorders: base }, { workorders: local }, { workorders: remote });
  // 本地改了顺序、远端没动 → 保留本地（不冲突）
  assert.equal(p.conflicts.length, 0, '远端没动 → 保留本地，不算冲突');
});

test('B1 键序不同不算改动（对象比较要与键序无关）', () => {
  const base = [{ code: 'T-1', reverseInfo: { at: 'x', reason: 'y' } }];
  const local = [{ code: 'T-1', reverseInfo: { reason: 'y', at: 'x' } }];
  const remote = [{ code: 'T-1', reverseInfo: { at: 'x', reason: 'y' } }];
  const p = TWM.planMerge({ transactions: base }, { transactions: local }, { transactions: remote });
  assert.equal(p.conflicts.length, 0, '键序不同、内容相同 → 不算改动');
});

test('B2【关键】流水的 ts/time 是派生字段：两边不同也不问人，直接采用飞书', () => {
  const base = [{ seq: 22, ts: '2026-09-16T13:32:06.724Z', time: '2026/9/16 21:32:06' }];
  const local = [{ seq: 22, ts: '2026-09-16T13:32:06.724Z', time: '2026/9/16 21:32:06' }];
  const remote = [{ seq: 22, ts: '2026-09-16T13:32:08.596Z', time: '2026-09-16 13:32:08' }];
  const p = TWM.planMerge({ transactions: base }, { transactions: local }, { transactions: remote });
  assert.equal(p.conflicts.length, 0, 'ts/time 不该产生冲突（旧实现每条本地新建流水都会冲突）');
  const w = (p.writes[0] || {}).fields || {};
  assert.equal(w.ts, '2026-09-16T13:32:08.596Z', '要直接采用飞书的时间');
});

test('B2 降级模式（没有 base）下 ts/time 同样不问人', () => {
  const local = [{ seq: 22, ts: 'AAA', time: 'a' }];
  const remote = [{ seq: 22, ts: 'BBB', time: 'b' }];
  const p = TWM.planMerge(null, { transactions: local }, { transactions: remote });
  assert.equal(p.conflicts.length, 0, '降级模式下也不该为派生字段问人');
});

test('B2 补：workorders.execTime 也是派生时间，格式不同不该问人', () => {
  const base = [{ code: 'WO-1', execTime: '' }];
  const local = [{ code: 'WO-1', execTime: '2026/9/16 21:52:03' }];
  const remote = [{ code: 'WO-1', execTime: '2026-09-16 21:52' }];
  const p = TWM.planMerge({ workorders: base }, { workorders: local }, { workorders: remote });
  assert.equal(p.conflicts.length, 0,
    'execTime 是 toLocaleString 与 DT() 的格式差异，不是业务改动 —— 阶段二重跑实测它会产生假冲突');
  assert.equal(((p.writes[0] || {}).fields || {}).execTime, '2026-09-16 21:52', '采用飞书的格式');
});
