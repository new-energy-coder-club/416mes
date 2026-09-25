/* G1 工单物品化 · 数据层测试（S1+S2+S5+S6）
 * 覆盖：双形态 progress、同码拒绝、canonicalOrder 分流、飞书 UP/DOWN 往返恒等、
 *       执行命令构造、APPLIED/REJECTED 进度语义、冲销反向命令、库存流水铁律。
 */
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../mes-core.js');
const Feishu = require('../lib/feishu-api.js');

const T0 = '2026-09-19T09:00:00.000Z';
const T1 = '2026-09-19T10:00:00.000Z';

/** 物品化测试现场：库位/容器/物品都按唯一物品域（state.items）建档 */
function mkState() {
  return {
    materials: [{ code: 'MAT-A', qty: 10, name: '角钢' }],
    locations: [{ code: 'L-1', status: 'active' }, { code: 'L-2', status: 'active' }],
    containers: [
      { code: 'CT-1', loc: 'L-1', status: 'active', version: 1 },
      { code: 'CT-2', loc: 'L-2', status: 'active', version: 1 }
    ],
    items: [
      { code: 'IT-1', name: '件1', status: 'in_stock', container: 'CT-1', version: 3 },
      { code: 'IT-2', name: '件2', status: 'in_stock', container: 'CT-1', version: 1 },
      { code: 'IT-3', name: '件3', status: 'pending', container: '', version: 1 },
      { code: 'IT-4', name: '件4', status: 'out', container: '', version: 2 }
    ],
    workorders: [],
    transactions: [],
    txnSeq: 0
  };
}

function stockOf(st, code) { return st.materials.find(m => m.code === code).qty; }

/* ---------- S1：判别与归一化 ---------- */

test('S1 isItemizedOrder：显式位或首行物品码行均判真，旧单判假', () => {
  assert.equal(Core.isItemizedOrder({ itemized: true, items: [] }), true);
  assert.equal(Core.isItemizedOrder({ items: [{ itemCodes: ['IT-1'] }] }), true);
  assert.equal(Core.isItemizedOrder({ items: [{ matCode: 'M', qty: 1 }] }), false);
  assert.equal(Core.isItemizedOrder(null), false);
  assert.equal(Core.isItemizedOrder({}), false);
});

test('S1 normalizeItemLines：无效行丢弃、同码重复报告（不合并）', () => {
  const n = Core.normalizeItemLines([
    { itemCodes: ['IT-1', ' IT-2 ', ''] },   // 空码被清掉
    { matCode: 'M', qty: 1 },                // 旧形态行 → 丢弃
    { itemCodes: [] },                       // 空列表 → 丢弃
    { itemCodes: ['IT-2', 'IT-3'] }          // IT-2 第二次出现 → 重复
  ]);
  assert.deepEqual(n.items, [{ itemCodes: ['IT-1', 'IT-2'] }, { itemCodes: ['IT-2', 'IT-3'] }]);
  assert.equal(n.dropped.length, 2);
  assert.deepEqual(n.duplicates, ['IT-2']);
});

/* ---------- S2：进度 / 建单 / canonical ---------- */

test('S2 双形态 progress：物品化按计划码数计，旧形态按数量计，互不串扰', () => {
  const it = { code: 'LL-I', type: 'LL', itemized: true, status: '部分执行', items: [{ itemCodes: ['IT-1', 'IT-2'] }, { itemCodes: ['IT-3'] }], execItems: ['IT-1'] };
  const p = Core.orderProgress(it);
  assert.equal(p.itemized, true);
  assert.equal(p.plannedTotal, 3, 'plannedTotal = Σ itemCodes.length');
  assert.equal(p.executedTotal, 1, 'executedTotal = execItems 中属于本单的码数');
  assert.equal(p.remainingTotal, 2);
  assert.equal(p.anyExecuted, true);
  assert.equal(p.fullyExecuted, false);
  assert.equal(p.percent, 33);
  assert.deepEqual(p.items.map(i => [i.planned, i.executed, i.remaining]), [[2, 1, 1], [1, 0, 1]]);

  const legacy = { code: 'LL-L', type: 'LL', status: '未执行', items: [{ matCode: 'M', qty: 4 }], execQty: [{ matCode: 'M', qty: 1 }] };
  const q = Core.orderProgress(legacy);
  assert.equal(q.itemized, undefined, '旧形态不带 itemized 标记');
  assert.equal(q.plannedTotal, 4);
  assert.equal(q.executedTotal, 1);

  // 脏数据防御：execItems 混入外单码 / 重复码，进度不被推出 100%
  const dirty = Core.orderProgress({ itemized: true, status: '部分执行', items: [{ itemCodes: ['IT-1'] }], execItems: ['IT-1', 'IT-1', 'IT-X'] });
  assert.equal(dirty.executedTotal, 1);
  assert.equal(dirty.fullyExecuted, true);
});

test('S2 物品化 progress：已执行但无 execItems 的旧数据视为全扫完', () => {
  const p = Core.orderProgress({ itemized: true, status: '已执行', items: [{ itemCodes: ['IT-1', 'IT-2'] }], execItems: [] });
  assert.equal(p.executedTotal, 2);
  assert.equal(p.fullyExecuted, true);
  assert.equal(p.percent, 100);
});

test('S2 createOrder 物品化分支：建档校验 + 不校验在库状态 + 同码重复拒绝', () => {
  const st = mkState();
  const r = Core.createOrder(st, { type: 'BH', code: 'BH-1', date: '2026-09-19', items: [{ itemCodes: ['IT-3', 'IT-4'] }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.order.itemized, true);
  assert.deepEqual(r.order.execItems, []);
  assert.deepEqual(r.order.execQty, []);
  assert.equal(st.workorders.length, 1);

  // 不校验在库状态：pending / out / in_stock 都能建单
  const r2 = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1', 'IT-3'] }] });
  assert.equal(r2.ok, true, '在库与待入物品混排也应能建单（方向匹配是扫码时的事）');

  // 同码重复（跨行）→ 拒绝
  const dup = Core.createOrder(st, { type: 'LL', code: 'LL-2', items: [{ itemCodes: ['IT-1'] }, { itemCodes: ['IT-1', 'IT-2'] }] });
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some(e => /重复/.test(e) && /IT-1/.test(e)));
  assert.deepEqual(dup.duplicates, ['IT-1']);
  assert.equal(st.workorders.some(w => w.code === 'LL-2'), false, '拒绝后不得落单');

  // 物品未建档 → 拒绝
  const miss = Core.createOrder(st, { type: 'LL', code: 'LL-3', items: [{ itemCodes: ['IT-1', 'GHOST'] }] });
  assert.equal(miss.ok, false);
  assert.ok(miss.errors.some(e => /物品未建档/.test(e) && /GHOST/.test(e)));

  // 空码行全被丢弃 → 拒绝
  const empty = Core.createOrder(st, { type: 'LL', code: 'LL-4', items: [{ itemCodes: ['', '  '] }] });
  assert.equal(empty.ok, false);
  assert.equal(empty.dropped.length, 1);

  // 同号闸门（B10）对物品化单同样生效
  const same = Core.createOrder(st, { type: 'LL', code: 'BH-1', items: [{ itemCodes: ['IT-1'] }] });
  assert.equal(same.ok, false);
  assert.ok(same.errors.some(e => /工单号已存在/.test(e)));
});

test('S2 createOrder 旧形态不受物品化分支影响', () => {
  const st = mkState();
  const r = Core.createOrder(st, { type: 'LL', code: 'LL-9', items: [{ matCode: 'MAT-A', qty: 2 }] });
  assert.equal(r.ok, true);
  assert.equal(r.order.itemized, undefined);
  assert.equal(r.order.execItems, undefined);
});

test('S2 canonicalOrder 分流：同号两物品化单（码不同）不误判全同；同码不同行分组判全同', () => {
  const a = { code: 'LL-X', type: 'LL', itemized: true, status: '未执行', items: [{ itemCodes: ['IT-1', 'IT-2'] }], execItems: [], execBatches: [] };
  const b = { code: 'LL-X', type: 'LL', itemized: true, status: '未执行', items: [{ itemCodes: ['IT-3'] }], execItems: [], execBatches: [] };
  const g = Core.workorderDuplicateGroups({ workorders: [a, b] }).groups[0];
  assert.equal(g.identical, false, 'P0 回归：物品化行走 normalizeItems 会全丢 → 同号误判全同');
  assert.ok(g.diffFields.includes('items'));
  // 也绝不能被收敛删单
  const st = { workorders: [a, b] };
  assert.equal(Core.collapseIdenticalWorkorderDuplicates(st, 'LL-X').ok, false);
  assert.equal(st.workorders.length, 2);

  // 同码集合、行分组/顺序不同（飞书上行/下行后行边界丢失）→ 全同、可收敛
  const c = JSON.parse(JSON.stringify(a));
  c.items = [{ itemCodes: ['IT-2'] }, { itemCodes: ['IT-1'] }];
  const st2 = { workorders: [a, c] };
  assert.equal(Core.workorderDuplicateGroups(st2).groups[0].identical, true);
  assert.equal(Core.collapseIdenticalWorkorderDuplicates(st2, 'LL-X').ok, true);

  // 物品化 vs 旧形态同号 → 不全同（itemized 判别位参与比较）
  const legacy = { code: 'LL-X', type: 'LL', status: '未执行', items: [], execQty: [], execBatches: [] };
  assert.equal(Core.workorderDuplicateGroups({ workorders: [a, legacy] }).groups[0].identical, false);
});

/* ---------- 飞书 UP/DOWN 双形态往返恒等 ---------- */

test('S2/S5 明细+执行数量列：旧形态 UP→DOWN 往返恒等', () => {
  const def = Feishu.TABLE_DEFS.workorders;
  const w = {
    code: 'LL-1', type: 'LL', date: '2026-09-15',
    items: [{ matCode: 'JG-001', qty: 2 }, { matCode: 'PJ-LD-001', qty: 3.5 }],
    status: '部分执行', execQty: [{ matCode: 'JG-001', qty: 1 }],
    execBatches: [{ at: 't', operator: '甲', items: [{ matCode: 'JG-001', qty: 1, delta: -1 }] }]
  };
  const up = def.up(w);
  assert.equal(up['明细'], 'JG-001x2; PJ-LD-001x3.5');
  assert.equal(up['执行数量'], 'JG-001=1');
  const down = def.down(up);
  assert.deepEqual(down.items, w.items);
  assert.deepEqual(down.execQty, w.execQty);
  assert.equal(down.execItems, undefined, '旧形态不得产出 execItems');
  assert.deepEqual(down.execBatches, w.execBatches, 'execBatches JSONF 不变');
});

test('S2/S5 明细+执行数量列：物品化形态 UP→DOWN 往返恒等', () => {
  const def = Feishu.TABLE_DEFS.workorders;
  const w = {
    code: 'LL-2', type: 'LL', date: '2026-09-15', itemized: true,
    items: [{ itemCodes: ['IT-A', 'IT-B'] }],
    status: '部分执行', execQty: [], execItems: ['IT-A'],
    execBatches: [{ at: 't', operator: '甲', itemCodes: ['IT-A'], ops: [{ opId: 'LL-2-IT-A', itemCode: 'IT-A', fromLoc: 'L-1', fromContainer: 'CT-1' }] }]
  };
  const up = def.up(w);
  assert.equal(up['明细'], 'IT-A; IT-B', '物品化明细 = 物品码列表');
  assert.equal(up['执行数量'], 'IT-A', '物品化执行数量 = 已 APPLIED 码列表');
  const down = def.down(up);
  assert.deepEqual(down.items, w.items);
  assert.deepEqual(down.execQty, []);
  assert.deepEqual(down.execItems, w.execItems, '物品码落到 execItems 而不是 execQty');
  assert.deepEqual(down.execBatches, w.execBatches);
  // 下行结果重新上行 → 二次恒等（幂等）
  assert.deepEqual(def.up(down), up);
});

test('S2/S5 明细列 DOWN 双形态解析：x数量结尾→旧形态，否则→物品码', () => {
  const def = Feishu.TABLE_DEFS.workorders;
  const down = def.down({ '明细': 'JG-001x2; IT-A; PJ-LD-001×3; IT-B', '执行数量': 'JG-001=2; IT-A' });
  assert.deepEqual(down.items, [{ matCode: 'JG-001', qty: 2 }, { matCode: 'PJ-LD-001', qty: 3 }, { itemCodes: ['IT-A', 'IT-B'] }]);
  assert.deepEqual(down.execQty, [{ matCode: 'JG-001', qty: 2 }, { itemCodes: ['IT-A'] }],
    '混合 token 各自分流；execItems 拆分由物品化单触发（本单非物品化 → 留在 execQty）');
});

/* ---------- S5：扫码校验与执行命令 ---------- */

test('S5 validateItemScan：属于本单 / 未扫 / 方向状态匹配', () => {
  const st = mkState();
  const ll = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1', 'IT-2'] }] }).order;
  assert.equal(Core.validateItemScan(st, ll, 'IT-1').ok, true);
  assert.match(Core.validateItemScan(st, ll, 'IT-3').error, /不属于工单/, '计划外的码拒绝');
  assert.match(Core.validateItemScan(st, ll, 'GHOST').error, /不属于工单/, '未建档码先被「不属于本单」挡住');
  ll.execItems = ['IT-1'];
  assert.match(Core.validateItemScan(st, ll, 'IT-1').error, /已扫过/, '重复扫码拒绝');
  assert.equal(Core.validateItemScan(st, ll, 'IT-2').ok, true, '另一件未扫的码仍可扫');

  // 方向匹配：LL（出库）要求在库
  const ll2 = Core.createOrder(st, { type: 'LL', code: 'LL-2', items: [{ itemCodes: ['IT-3'] }] }).order;
  assert.match(Core.validateItemScan(st, ll2, 'IT-3').error, /在库/, 'pending 物品不能出库');
  // BH（入库）要求 pending | out
  const bh = Core.createOrder(st, { type: 'BH', code: 'BH-1', items: [{ itemCodes: ['IT-3'], }] }).order;
  assert.equal(Core.validateItemScan(st, bh, 'IT-3').ok, true, 'pending 可以入库');
  const bh2 = Core.createOrder(st, { type: 'BH', code: 'BH-2', items: [{ itemCodes: ['IT-1'] }] }).order;
  assert.match(Core.validateItemScan(st, bh2, 'IT-1').error, /pending \| out/, '在库物品不能入库');
  // 旧形态单走旧执行路径，不用物品扫码
  assert.equal(Core.validateItemScan(st, { code: 'X', type: 'LL', items: [{ matCode: 'M', qty: 1 }] }, 'IT-1').ok, false);
});

test('S5 buildItemExecCommands：LL/JH 用档案位置构造 issue（不扫位置）', () => {
  const st = mkState();
  const o = Core.createOrder(st, { type: 'JH', code: 'JH-1', items: [{ itemCodes: ['IT-1', 'IT-2'] }] }).order;
  const r = Core.buildItemExecCommands(st, o, ['IT-1', 'IT-2'], {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.commands.map(c => c.kind), ['issue', 'issue']);
  assert.deepEqual(r.commands[0].source, { loc: 'L-1', container: 'CT-1' }, '来源位置取自档案（物品→容器→库位），不扫位置');
  assert.deepEqual(r.ops, [
    { opId: 'JH-1-IT-1', itemCode: 'IT-1', fromLoc: 'L-1', fromContainer: 'CT-1' },
    { opId: 'JH-1-IT-2', itemCode: 'IT-2', fromLoc: 'L-1', fromContainer: 'CT-1' }
  ], 'ops 留痕执行前位置，供冲销回原位');

  // 位置无法解析 → 报错且不生成该件命令
  st.items.push({ code: 'IT-9', status: 'in_stock', container: 'GHOST-CT' });
  const o2 = Core.createOrder(st, { type: 'LL', code: 'LL-9', items: [{ itemCodes: ['IT-9'] }] }).order;
  const r2 = Core.buildItemExecCommands(st, o2, ['IT-9'], {});
  assert.equal(r2.ok, false);
  assert.equal(r2.commands.length, 0);
  assert.ok(r2.errors.some(e => /位置无法解析/.test(e)));
});

test('S5 buildItemExecCommands：BH/TL 必须带 target，构造 receive', () => {
  const st = mkState();
  const o = Core.createOrder(st, { type: 'TL', code: 'TL-1', items: [{ itemCodes: ['IT-3', 'IT-4'] }] }).order;
  const noTarget = Core.buildItemExecCommands(st, o, ['IT-3'], {});
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.errors[0], /目标库位与容器/);

  const r = Core.buildItemExecCommands(st, o, ['IT-3', 'IT-4'], { target: { loc: 'L-2', container: 'CT-2' } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.commands.map(c => c.kind), ['receive', 'receive']);
  assert.deepEqual(r.commands[0].target, { loc: 'L-2', container: 'CT-2' });
  assert.deepEqual(r.ops[0], { opId: 'TL-1-IT-3', itemCode: 'IT-3', fromLoc: 'L-2', fromContainer: 'CT-2' },
    '入库单的 fromLoc/fromContainer 记 receive 目标（冲销 issue 由此取出）');

  // 目标未建档 → 拒绝
  const bad = Core.buildItemExecCommands(st, o, ['IT-3'], { target: { loc: 'L-X', container: 'CT-2' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => /目标库位未建档/.test(e)));
});

test('S5 applyItemExecResult：APPLIED 才入账，全扫完=已执行、部分=部分执行', () => {
  const st = mkState();
  const o = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1', 'IT-2'] }] }).order;
  const built = Core.buildItemExecCommands(st, o, ['IT-1', 'IT-2'], {});
  const results = [
    { ...built.ops[0], phase: 'APPLIED' },
    { ...built.ops[1], phase: 'REJECTED', error: '版本冲突' }
  ];
  const r1 = Core.applyItemExecResult(st, o, results, { operator: '甲', now: T0 });
  assert.equal(r1.ok, true);
  assert.equal(o.status, '部分执行', '一件 REJECTED → 部分执行');
  assert.deepEqual(o.execItems, ['IT-1']);
  assert.equal(o.execBatches.length, 1);
  assert.deepEqual(o.execBatches[0].itemCodes, ['IT-1']);
  assert.deepEqual(o.execBatches[0].ops, [{ opId: 'LL-1-IT-1', itemCode: 'IT-1', fromLoc: 'L-1', fromContainer: 'CT-1' }]);
  assert.equal(o.execBatches[0].operator, '甲');
  assert.equal(r1.rejected.length, 1);
  assert.match(r1.rejected[0].error, /版本冲突/);
  assert.equal(r1.progress.executedTotal, 1);

  // 第二件补扫 APPLIED → 已执行
  const r2 = Core.applyItemExecResult(st, o, [{ ...built.ops[1], phase: 'APPLIED' }], { operator: '甲', now: T1 });
  assert.equal(r2.ok, true);
  assert.equal(o.status, '已执行');
  assert.equal(r2.partial, false);
  assert.deepEqual(o.execItems, ['IT-1', 'IT-2']);
  assert.equal(o.execBatches.length, 2);

  // 全部 REJECTED → 整批不入账
  const o2 = Core.createOrder(st, { type: 'LL', code: 'LL-2', items: [{ itemCodes: ['IT-2'] }] }).order;
  const r3 = Core.applyItemExecResult(st, o2, [{ opId: 'LL-2-IT-2', itemCode: 'IT-2', phase: 'REJECTED', error: 'x' }], {});
  assert.equal(r3.ok, false);
  assert.equal(o2.execItems.length, 0);
  assert.equal(o2.execBatches.length, 0);
  assert.equal(o2.status, '未执行');
});

test('S5 applyItemExecResult 幂等：重复回执（同 opId / 同码）不重复入账', () => {
  const st = mkState();
  const o = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1', 'IT-2'] }] }).order;
  const built = Core.buildItemExecCommands(st, o, ['IT-1'], {});
  const r1 = Core.applyItemExecResult(st, o, [{ ...built.ops[0], phase: 'APPLIED' }], { now: T0 });
  assert.equal(r1.ok, true);
  // 超时重试收回同一条回执
  const r2 = Core.applyItemExecResult(st, o, [{ ...built.ops[0], phase: 'APPLIED' }], { now: T1 });
  assert.equal(r2.ok, false);
  assert.deepEqual(o.execItems, ['IT-1']);
  assert.equal(o.execBatches.length, 1);
});

test('S5 铁律：物品化执行全程不碰 applyStockChange / state.transactions / 物料库存', () => {
  const st = mkState();
  const beforeQty = stockOf(st, 'MAT-A');
  const o = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1', 'IT-2'] }] }).order;
  const built = Core.buildItemExecCommands(st, o, ['IT-1', 'IT-2'], {});
  Core.applyItemExecResult(st, o, built.ops.map(x => ({ ...x, phase: 'APPLIED' })), { now: T0 });
  /* TASK-17：物品状态由服务端落账（issue APPLIED → out），applyItemExecResult 不模拟该步，
     冲销计划按物品现状判定——现场须先补上服务端落账结果 */
  st.items.find(x => x.code === 'IT-1').status = 'out';
  st.items.find(x => x.code === 'IT-1').container = '';
  st.items.find(x => x.code === 'IT-2').status = 'out';
  st.items.find(x => x.code === 'IT-2').container = '';
  const rev = Core.buildItemReverseCommands(st, o, {});
  Core.applyItemReverseResult(st, o, rev.commands.map(c => ({ ...c, phase: 'APPLIED' })), { now: T1 });
  assert.equal(st.transactions.length, 0, '物品化执行+冲销不得产生任何库存流水');
  assert.equal(st.txnSeq, 0);
  assert.equal(stockOf(st, 'MAT-A'), beforeQty, '物料库存数量不得变化');
  assert.equal(o.status, '已取消');
});

/* ---------- S6：取消与冲销 ---------- */

test('S6 物品化 cancelOrder：未扫可取消；已扫一件即须冲销', () => {
  const st = mkState();
  const o = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1'] }] }).order;
  const c = Core.cancelOrder(st, o, { reason: '建错单', now: T0 });
  assert.equal(c.ok, true);
  assert.equal(o.status, '已取消');
  assert.equal(o.cancelInfo.reason, '建错单');

  const o2 = Core.createOrder(st, { type: 'LL', code: 'LL-2', items: [{ itemCodes: ['IT-1', 'IT-2'] }] }).order;
  const built = Core.buildItemExecCommands(st, o2, ['IT-1'], {});
  Core.applyItemExecResult(st, o2, [{ ...built.ops[0], phase: 'APPLIED' }], { now: T0 });
  const c2 = Core.cancelOrder(st, o2, {});
  assert.equal(c2.ok, false);
  assert.match(c2.error, /冲销/);
  assert.equal(o2.status, '部分执行');
});

test('S6 冲销计划：LL/JH→receive 回原位；BH/TL→issue 由留痕位置取出', () => {
  const st = mkState();
  // 出库单冲销 = receive 回执行前位置
  const ll = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1', 'IT-2'] }] }).order;
  const b1 = Core.buildItemExecCommands(st, ll, ['IT-1', 'IT-2'], {});
  Core.applyItemExecResult(st, ll, b1.ops.map(x => ({ ...x, phase: 'APPLIED' })), { now: T0 });
  /* TASK-17：补服务端落账（issue APPLIED → out），否则现状已是 in_stock 会被判「已回库」跳过 */
  st.items.find(x => x.code === 'IT-1').status = 'out';
  st.items.find(x => x.code === 'IT-1').container = '';
  st.items.find(x => x.code === 'IT-2').status = 'out';
  st.items.find(x => x.code === 'IT-2').container = '';
  const revL = Core.buildItemReverseCommands(st, ll, {});
  assert.equal(revL.ok, true, JSON.stringify(revL.errors));
  assert.deepEqual(revL.commands.map(c => [c.kind, c.itemCode, c.target]),
    [['receive', 'IT-1', { loc: 'L-1', container: 'CT-1' }], ['receive', 'IT-2', { loc: 'L-1', container: 'CT-1' }]],
    'LL 冲销 = receive 回原位（target = 留痕的执行前位置）');
  assert.equal(revL.commands[0].reverseOf, 'LL-1-IT-1');

  // 入库单冲销 = issue 从 receive 目标取出
  const bh = Core.createOrder(st, { type: 'BH', code: 'BH-1', items: [{ itemCodes: ['IT-3'] }] }).order;
  const b2 = Core.buildItemExecCommands(st, bh, ['IT-3'], { target: { loc: 'L-2', container: 'CT-2' } });
  Core.applyItemExecResult(st, bh, [{ ...b2.ops[0], phase: 'APPLIED' }], { now: T0 });
  /* TASK-17：补服务端落账（receive APPLIED → in_stock@CT-2） */
  st.items.find(x => x.code === 'IT-3').status = 'in_stock';
  st.items.find(x => x.code === 'IT-3').container = 'CT-2';
  const revB = Core.buildItemReverseCommands(st, bh, {});
  assert.equal(revB.ok, true);
  assert.deepEqual(revB.commands.map(c => [c.kind, c.itemCode, c.source]),
    [['issue', 'IT-3', { loc: 'L-2', container: 'CT-2' }]],
    'BH 冲销 = issue 由留痕位置（receive 目标）取出');

  // 未执行 → 无冲销计划；已取消 → 无冲销计划
  const o3 = Core.createOrder(st, { type: 'LL', code: 'LL-3', items: [{ itemCodes: ['IT-1'] }] }).order;
  assert.equal(Core.buildItemReverseCommands(st, o3, {}).ok, false);
  Core.cancelOrder(st, o3, {});
  assert.equal(Core.buildItemReverseCommands(st, o3, {}).ok, false);
});

test('S6 冲销回执：全部 APPLIED 才关单留痕；缺回执不关单', () => {
  const st = mkState();
  const o = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1', 'IT-2'] }] }).order;
  const built = Core.buildItemExecCommands(st, o, ['IT-1', 'IT-2'], {});
  Core.applyItemExecResult(st, o, built.ops.map(x => ({ ...x, phase: 'APPLIED' })), { now: T0 });
  /* TASK-17：补服务端落账（issue APPLIED → out） */
  st.items.find(x => x.code === 'IT-1').status = 'out';
  st.items.find(x => x.code === 'IT-1').container = '';
  st.items.find(x => x.code === 'IT-2').status = 'out';
  st.items.find(x => x.code === 'IT-2').container = '';
  const rev = Core.buildItemReverseCommands(st, o, {});

  // 只回一件 → 不关单
  const partial = Core.applyItemReverseResult(st, o, [{ ...rev.commands[0], phase: 'APPLIED' }], { now: T1 });
  assert.equal(partial.ok, false);
  assert.equal(partial.pending.length, 1);
  assert.equal(o.status, '已执行', '部分反向完成时工单保持原状态');
  assert.equal(o.reverseInfo, undefined);

  // 全部 APPLIED（按冲销命令的 REV- opId 回执）→ 关单留痕
  const done = Core.applyItemReverseResult(st, o, rev.commands.map(c => ({ ...c, phase: 'APPLIED' })), { operator: '乙', reason: '发错货', now: T1 });
  assert.equal(done.ok, true);
  assert.equal(o.status, '已取消');
  assert.deepEqual(o.reverseInfo.itemCodes, ['IT-1', 'IT-2']);
  assert.equal(o.reverseInfo.reason, '发错货');
  assert.equal(o.reverseInfo.operator, '乙');
  assert.deepEqual(o.execItems, ['IT-1', 'IT-2'], '执行历史保留（与旧形态冲销同语义）');
  // 已取消后不能再冲销/取消
  assert.equal(Core.applyItemReverseResult(st, o, [], {}).ok, false);
  assert.equal(Core.cancelOrder(st, o, {}).ok, false);
});

/* ---------- 摘要与历史 ---------- */

test('S2 orderSummary / orderHistory 支持物品化形态', () => {
  const st = mkState();
  const o = Core.createOrder(st, { type: 'BH', code: 'BH-1', date: '2026-09-19', items: [{ itemCodes: ['IT-3', 'IT-4'] }] }).order;
  const built = Core.buildItemExecCommands(st, o, ['IT-3'], { target: { loc: 'L-2', container: 'CT-2' } });
  Core.applyItemExecResult(st, o, [{ ...built.ops[0], phase: 'APPLIED' }], { operator: '甲', now: T0 });
  const sum = Core.orderSummary(o);
  assert.equal(sum.plannedTotal, 2);
  assert.equal(sum.executedTotal, 1);
  assert.equal(sum.percent, 50);
  assert.equal(sum.statusLabel, '部分执行');
  assert.equal(sum.batchCount, 1);

  const hist = Core.orderHistory(o);
  assert.equal(hist.length, 2);
  assert.match(hist[0].text, /2 件物品/);
  assert.match(hist[1].text, /扫码 1 件（IT-3）/);
});
