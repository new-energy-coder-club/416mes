/* TASK-17 · BUG-9 修复测试：冲销命令按物品当前状态生成（不再按历史留痕硬写）
 * 覆盖任务书六节：
 *   1. 物品移动后冲销 → 用当前位置/合理跳过，不是历史位置
 *   2. 命令必须带 expected（itemVersion=当前 version）
 *   3. 物品已 out（入库单冲销）→ 跳过 + 人话原因，无注定失败的命令
 *   4. 回归：物品未移动时行为与修复前一致
 *   5. 端到端：移动后冲销计划走 applyItemReverseResult（豁免）能关单
 */
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../mes-core.js');

const T0 = '2026-09-19T09:00:00.000Z';
const T1 = '2026-09-19T10:00:00.000Z';

function mkState() {
  return {
    materials: [{ code: 'MAT-A', qty: 10, name: '角钢' }],
    locations: [{ code: 'L-1', status: 'active' }, { code: 'L-2', status: 'active' }, { code: 'L-3', status: 'active' }],
    containers: [
      { code: 'CT-1', loc: 'L-1', status: 'active', version: 1 },
      { code: 'CT-2', loc: 'L-2', status: 'active', version: 1 },
      { code: 'CT-3', loc: 'L-3', status: 'active', version: 1 }
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

/** 造一张已执行的入库单：IT-3 receive 进 CT-2（留痕 fromLoc/fromContainer = L-2/CT-2）。
 *  applyItemExecResult 不落物品状态（服务端协议负责），此处按服务端语义手工落地：
 *  receive APPLIED → in_stock@CT-2。 */
function executedInbound(st) {
  const o = Core.createOrder(st, { type: 'BH', code: 'BH-1', items: [{ itemCodes: ['IT-3'] }] }).order;
  const built = Core.buildItemExecCommands(st, o, ['IT-3'], { target: { loc: 'L-2', container: 'CT-2' } });
  Core.applyItemExecResult(st, o, [{ ...built.ops[0], phase: 'APPLIED' }], { now: T0 });
  const it = st.items.find(x => x.code === 'IT-3');
  it.status = 'in_stock';
  it.container = 'CT-2';
  return o;
}

/** 造一张已执行的出库单：IT-1 从 CT-1 出库（留痕 = L-1/CT-1）。
 *  同上按服务端语义落地：issue APPLIED → out、container=''。 */
function executedOutbound(st) {
  const o = Core.createOrder(st, { type: 'LL', code: 'LL-1', items: [{ itemCodes: ['IT-1'] }] }).order;
  const built = Core.buildItemExecCommands(st, o, ['IT-1'], {});
  Core.applyItemExecResult(st, o, [{ ...built.ops[0], phase: 'APPLIED' }], { now: T0 });
  const it = st.items.find(x => x.code === 'IT-1');
  it.status = 'out';
  it.container = '';
  return o;
}

test('T17-1 入库单冲销：物品被移到别的容器后，命令按当前位置（CT-3）而不是留痕（CT-2）', () => {
  const st = mkState();
  const o = executedInbound(st);
  // 执行后物品被移走：IT-3 从 CT-2 → CT-3（version 前进）
  const it = st.items.find(x => x.code === 'IT-3');
  it.container = 'CT-3';
  it.version = 5;
  const rev = Core.buildItemReverseCommands(st, o, {});
  assert.equal(rev.ok, true, JSON.stringify(rev.errors));
  assert.equal(rev.commands.length, 1);
  assert.equal(rev.commands[0].kind, 'issue');
  assert.deepEqual(rev.commands[0].source, { loc: 'L-3', container: 'CT-3' },
    '冲销必须按物品当前所在容器生成，不是历史留痕 CT-2');
});

test('T17-2 冲销命令必须带 expected，且 itemVersion 等于物品当前 version、containerVersion 等于所用容器当前 version', () => {
  const st = mkState();
  const o = executedInbound(st);
  const it = st.items.find(x => x.code === 'IT-3');
  it.container = 'CT-3';
  it.version = 5;
  const rev = Core.buildItemReverseCommands(st, o, {});
  const c = rev.commands[0];
  assert.ok(c.expected, '反向命令必须携带 expected 版本前置条件');
  assert.equal(c.expected.itemVersion, 5, 'expected.itemVersion 必须是物品当前 version');
  assert.equal(c.expected.containerVersion, 1, 'expected.containerVersion 必须是所用容器的当前 version');

  // 出库单方向同样带 expected（物品已 out，退回目标容器的当前 version）
  const st2 = mkState();
  const ll = executedOutbound(st2);
  const rev2 = Core.buildItemReverseCommands(st2, ll, {});
  assert.equal(rev2.ok, true);
  assert.deepEqual(rev2.commands[0].expected,
    { itemVersion: 3, containerVersion: 1 },
    'LL 冲销 receive 的 expected：物品当前 version + 目标容器当前 version');
});

test('T17-3 入库单冲销：物品已 out → 跳过并给出人话原因，不产生注定被 VERSION_CONFLICT 拒绝的命令', () => {
  const st = mkState();
  const o = executedInbound(st);
  // 复刻 DSH 生产场景：BH 执行后又把物品出库了（status=out, container=''）
  const it = st.items.find(x => x.code === 'IT-3');
  it.status = 'out';
  it.container = '';
  it.version = 4;
  const rev = Core.buildItemReverseCommands(st, o, {});
  assert.equal(rev.ok, true, '跳过不是错误，计划本身应 ok');
  assert.equal(rev.commands.length, 0, '不得产生任何注定被拒的命令');
  assert.equal(rev.skipped.length, 1);
  assert.equal(rev.skipped[0].itemCode, 'IT-3');
  assert.match(rev.skipped[0].reason, /已出库/);
});

test('T17-3b 出库单冲销：物品已被重新收货（in_stock）→ 跳过并说明，不二次 receive', () => {
  const st = mkState();
  const o = executedOutbound(st);
  const it = st.items.find(x => x.code === 'IT-1');
  it.status = 'in_stock';
  it.container = 'CT-2';
  it.version = 6;
  const rev = Core.buildItemReverseCommands(st, o, {});
  assert.equal(rev.commands.length, 0, '物品已回库，不得再生成 receive 造成二次入库');
  assert.equal(rev.skipped.length, 1);
  assert.match(rev.skipped[0].reason, /已回库/);
});

test('T17-4 回归：物品未移动时，入库/出库冲销命令与修复前行为一致（位置=留痕）', () => {
  const st = mkState();
  const bh = executedInbound(st); // IT-3 执行后仍在 CT-2
  const revB = Core.buildItemReverseCommands(st, bh, {});
  assert.equal(revB.ok, true);
  assert.deepEqual(revB.commands.map(c => [c.kind, c.itemCode, c.source]),
    [['issue', 'IT-3', { loc: 'L-2', container: 'CT-2' }]],
    '入库单：物品未移动 → source 仍是留痕位置');
  assert.equal(revB.skipped.length, 0);

  const st2 = mkState();
  const ll = executedOutbound(st2); // IT-1 执行后 out，位置概念上仍在留痕
  const revL = Core.buildItemReverseCommands(st2, ll, {});
  assert.equal(revL.ok, true);
  assert.deepEqual(revL.commands.map(c => [c.kind, c.itemCode, c.target]),
    [['receive', 'IT-1', { loc: 'L-1', container: 'CT-1' }]],
    '出库单：物品未移动 → target 仍是留痕位置');
  assert.equal(revL.skipped.length, 0);
});

test('T17-5 端到端：移动后冲销（1 件豁免 + 1 件 APPLIED）能关单，reverseInfo 如实记录 skipped', () => {
  const st = mkState();
  const o = Core.createOrder(st, { type: 'BH', code: 'BH-2', items: [{ itemCodes: ['IT-3'] }, { itemCodes: ['IT-2'] }] }).order;
  /* 两件初始都 pending 可 receive；执行顺序 IT-2 先（它随后会被再次出库制造「已退过」现状） */
  /* IT-2 在 mkState 里是 in_stock（出库场景用），入库单要求 pending|out——先按场景置为待入库 */
  st.items.find(x => x.code === 'IT-2').status = 'pending';
  const b2 = Core.buildItemExecCommands(st, o, ['IT-2'], { target: { loc: 'L-2', container: 'CT-2' } });
  Core.applyItemExecResult(st, o, [{ ...b2.ops[0], phase: 'APPLIED' }], { now: T0 });
  const built = Core.buildItemExecCommands(st, o, ['IT-3'], { target: { loc: 'L-2', container: 'CT-2' } });
  Core.applyItemExecResult(st, o, [{ ...built.ops[0], phase: 'APPLIED' }], { now: T0 });
  // 按服务端语义落地两件 receive 的结果，再制造「移动/出库」现状：
  st.items.find(x => x.code === 'IT-3').status = 'in_stock';
  st.items.find(x => x.code === 'IT-3').container = 'CT-2';
  st.items.find(x => x.code === 'IT-2').status = 'in_stock';
  st.items.find(x => x.code === 'IT-2').container = 'CT-2';
  // IT-3 已被移走（换容器）；IT-2 已被出库（退回后状态，应豁免）
  st.items.find(x => x.code === 'IT-3').container = 'CT-3';
  st.items.find(x => x.code === 'IT-2').status = 'out';
  st.items.find(x => x.code === 'IT-2').container = '';

  const rev = Core.buildItemReverseCommands(st, o, {});
  assert.equal(rev.commands.length, 1, '只有 IT-3 生成命令（IT-2 已 out 应跳过）');
  assert.equal(rev.skipped.length, 1);
  assert.equal(rev.skipped[0].itemCode, 'IT-2');

  // 只有 IT-3 的反向命令回执 APPLIED → 豁免 IT-2 后应能关单
  const r = Core.applyItemReverseResult(st, o,
    [{ ...rev.commands[0], phase: 'APPLIED' }],
    { now: T1, exemptOpIds: ['BH-2-IT-2'] });
  assert.equal(r.ok, true, JSON.stringify(r.pending || r.error));
  assert.equal(o.status, '已取消');
  assert.deepEqual(o.reverseInfo.itemCodes, ['IT-3']);
  assert.deepEqual(o.reverseInfo.skipped.map(s => s.itemCode), ['IT-2'], '豁免件必须如实记入 reverseInfo.skipped');
});

test('T17-5b 豁免不声明时行为不变（回归）：缺回执的件仍报 pending、不关单', () => {
  const st = mkState();
  const o = executedInbound(st);
  const it = st.items.find(x => x.code === 'IT-3');
  it.status = 'out'; it.container = '';
  const rev = Core.buildItemReverseCommands(st, o, {});
  assert.equal(rev.commands.length, 0);
  const r = Core.applyItemReverseResult(st, o, [], {});
  assert.equal(r.ok, false, '未传 exemptOpIds 时维持旧行为：该件被报 pending，工单不关');
  assert.equal(r.pending.length, 1);
  assert.equal(o.status, '已执行');
});
