'use strict';
/* 容器短链 v3.13.35 · P0（W2/D7）：裸容器码 / 裸库位码自动识别 + 多表同码歧义卡
 *
 * 背景：handleScan 无前缀自动识别此前只认 WIP/NEC/items/manuals，裸容器码（A4SH-001 形）
 * 会掉进 looksLikeTruncatedCode 分支被判「可能没扫全」——与系统自家提示文案矛盾。
 * 本次：识别链补 containers/locations；同码命中多表（物料↔容器、容器↔库位等）时
 * 显式歧义卡不猜（镜像 WIP/NEC 歧义卡口径）。断言真实路由（scanWhere/scanMat 调用计数），
 * 非字符串存在性。
 */
const test = require('node:test');
const { setup, assert, vm } = require('./itemized-ui-helper.cjs');

/* 给 vm 上下文装路由计数桩（helper 默认 scanWhere/scanManual 是空桩不计数） */
function withRouteCounters(env) {
  const calls = env.calls;
  env.context.scanWhere = (prefix, code, box) => { calls.routeWhere = calls.routeWhere || []; calls.routeWhere.push(prefix + code); };
  env.context.scanManual = () => { calls.routeManual = (calls.routeManual || 0) + 1; };
  env.context.scanNec = () => { calls.routeNec = (calls.routeNec || 0) + 1; };
  return calls;
}

test('W2-1 唯一命中的裸容器码 → 自动识别为 CTN:（不再误判「可能没扫全」）', () => {
  const env = setup();
  const calls = withRouteCounters(env);
  env.state.containers.push({ code: 'A4SH-001', loc: 'L-1', status: 'active', version: 1 });
  vm.runInContext("handleScan('A4SH-001')", env.context);
  assert.deepEqual(calls.routeWhere, ['CTN:A4SH-001'], '裸容器码应路由到 scanWhere(CTN:)');
  assert.equal(calls.scanMat, 0, '绝不能落 MAT: 兜底');
  assert.equal(calls.scanItem, 0, '也不能猜成物品');
});

test('W2-2 唯一命中的裸库位码 → 自动识别为 LOC:', () => {
  const env = setup();
  const calls = withRouteCounters(env);
  env.state.locations.push({ code: 'C-03-02-04', status: 'active' });
  vm.runInContext("handleScan('C-03-02-04')", env.context);
  assert.deepEqual(calls.routeWhere, ['LOC:C-03-02-04'], '裸库位码应路由到 scanWhere(LOC:)');
});

test('W2-3 物料与容器同码 → 歧义卡停止操作，不猜（不路由任何表）', () => {
  const env = setup();
  const calls = withRouteCounters(env);
  env.state.containers.push({ code: 'XK-001', loc: 'L-1', status: 'active', version: 1 });
  env.state.materials.push({ code: 'XK-001', qty: 1, name: '形同码物料' });
  vm.runInContext("handleScan('XK-001')", env.context);
  const html = env.document.getElementById('scanResult').innerHTML;
  assert.match(html, /这个码有歧义，已停止操作/, '必须显式歧义卡');
  assert.match(html, /容器/, '列出命中类型：容器');
  assert.match(html, /物料/, '列出命中类型：物料');
  assert.match(html, /CTN:XK-001/, '给出去歧义的显式写法');
  assert.equal(calls.routeWhere, undefined, '不猜：不得路由');
  assert.equal(calls.scanMat, 0, '不猜：不得落 MAT: 兜底');
});

test('W2-4 容器与库位同码 → 歧义卡停止操作', () => {
  const env = setup();
  const calls = withRouteCounters(env);
  env.state.containers.push({ code: 'KK-9', loc: 'L-1', status: 'active', version: 1 });
  env.state.locations.push({ code: 'KK-9', status: 'active' });
  vm.runInContext("handleScan('KK-9')", env.context);
  const html = env.document.getElementById('scanResult').innerHTML;
  assert.match(html, /这个码有歧义，已停止操作/);
  assert.match(html, /容器/);
  assert.match(html, /库位/);
  assert.equal(calls.routeWhere, undefined, '容器/库位双命中不猜');
});

test('W2-5 物品与容器同码 → 歧义卡停止操作（ITM/CTN 互斥）', () => {
  const env = setup();
  const calls = withRouteCounters(env);
  env.state.containers.push({ code: 'IT-1', loc: 'L-1', status: 'active', version: 1 });
  vm.runInContext("handleScan('IT-1')", env.context);
  const html = env.document.getElementById('scanResult').innerHTML;
  assert.match(html, /这个码有歧义，已停止操作/);
  assert.match(html, /物品/);
  assert.match(html, /容器/);
  assert.equal(calls.routeWhere, undefined);
  assert.equal(calls.scanItem, 0, '不猜：不得走物品只读查询');
});

test('W2-6 WIP/NEC 同号 → 原歧义卡行为不变（P6-2 回归）', () => {
  const env = setup();
  const calls = withRouteCounters(env);
  env.state.workorders.push({ code: 'OLD-1', type: 'LL', items: [] });
  env.state.necOrders.push({ code: 'OLD-1' });
  vm.runInContext("handleScan('OLD-1')", env.context);
  const html = env.document.getElementById('scanResult').innerHTML;
  assert.match(html, /这个码有歧义，已停止操作/, '原 WIP/NEC 歧义卡保留');
  assert.match(html, /仓库工单/, '原卡文案（仓库工单与 NEC 任务）');
  assert.match(html, /WIP:OLD-1/, '原卡去歧义写法');
  assert.equal(calls.routeNec, undefined, '不猜：不得进 NEC');
  assert.equal(calls.routeWhere, undefined);
});

test('W2-7 带前缀 CTN:/LOC: 不受歧义卡影响（显式指定永远放行）', () => {
  const env = setup();
  const calls = withRouteCounters(env);
  env.state.containers.push({ code: 'XK-001', loc: 'L-1', status: 'active', version: 1 });
  env.state.materials.push({ code: 'XK-001', qty: 1, name: '形同码物料' });
  vm.runInContext("handleScan('CTN:XK-001')", env.context);
  assert.deepEqual(calls.routeWhere, ['CTN:XK-001'], '显式前缀即用户决定，直接路由');
});

/* ---------- 盘点 × 容器短链（v3.13.35 §3.5 补锁） ---------- */
test('盘点模式扫 /c/ 容器短链 → 归一 CTN: → scanWhere 只读查询 + 「不计入盘点」提示', () => {
  const test = require('node:test');
  const env = setup();
  env.mock.window.CtnLink = require('../lib/ctn-link');
  const calls = withRouteCounters(env);
  env.state.containers.push({ code: 'A4SH-001', loc: 'L-1', status: 'active', version: 1 });
  env.state.stocktake = { scanned: [] };   // 激活盘点模式（stocktakeActive 口径）
  const C = require('../lib/ctn-link');
  env.context.handleScan(C.linkFor('A4SH-001'));
  const html = env.document.getElementById('scanResult').innerHTML;
  assert.deepEqual(calls.routeWhere, ['CTN:A4SH-001'], '/c/ 短链必须归一为 CTN: 走 scanWhere');
  assert.match(html, /盘点模式仅统计物品/, '必须补「不计入盘点」提示');
});
