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
