/**
 * TASK-10 阶段 3：工单阻塞与严重项 —— 回归测试
 *
 * 背景（dev-docs/G-工单逻辑完善度研究.md，DSH 已复现验证）：
 *   部分执行的历史 MAT 单原本是**彻底死端**——四道门全关上：
 *   ① mes-core cancelOrder 在 anyExecuted 时 return 错误
 *   ② UI 取消按钮只在 isPending 时渲染
 *   ③ wipReverseEligible 第一行 if(!isItemizedOrder(w)) return false
 *   ④ 删除被 anyExecuted 挡住；「去扫码执行」只在 itemized 渲染
 *   而库层 CORE.reverseOrder 是好的（内部走 applyStockChange，库存与流水成对）。
 *
 * 本文件锁死修复后的行为，防回归。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const CORE = require('../mes-core.js');

const ROOT = path.resolve(__dirname, '..');

/* ---------- 构造一张「已部分执行的旧 MAT 单」 ---------- */
function mkPartialMatOrder(state, code, type) {
  CORE.createOrder(state, { type: type || 'LL', date: '2026-09-25', code, items: [{ matCode: 'M1', qty: 10 }] });
  const w = state.workorders.find(x => x.code === code);
  CORE.executeOrder(state, w, { operator: '甲', execQtyByCode: { M1: 4 } });
  return w;
}

function baseState() {
  return {
    materials: [{ code: 'M1', qty: 100 }],
    items: [], containers: [], locations: [], workorders: [], transactions: [],
    scanHistory: [], necOrders: [], members: [], itemOperations: [], txnSeq: 0, operator: '甲'
  };
}

/* ===================== 一、阻塞项：部分执行的旧 MAT 单不再死端 ===================== */

test('B1 部分执行的旧 MAT 单：四个门全都通（不再死端）', () => {
  const st = baseState();
  const w = mkPartialMatOrder(st, 'LL20260925001');
  /* 前置断言：这确实是「部分执行 + 非 itemized」的旧单 */
  assert.equal(CORE.isItemizedOrder(w), false, '必须是旧 MAT 单');
  assert.equal(CORE.isPending(w), false, '不能是未执行');
  assert.equal(CORE.isPartiallyExecuted(w), true, '必须是部分执行');
  /* ① 库层冲销可用（修复前 UI 无入口，但库层一直是好的） */
  const rev = CORE.reverseOrder(st, w, { operator: '甲', reason: '误操作' });
  assert.equal(rev.ok, true, '库层冲销必须可用');
  assert.equal(rev.applied.length, 1, '应冲销 1 个物料');
  /* ② UI 冲销按钮现在会渲染（修复前 wipReverseEligible 直接 return false） */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/function wipReverseEligible\(w\) \{[\s\S]*?\n\}/);
  assert.ok(m, '必须能取到 wipReverseEligible 源码');
  assert.ok(!/if \(!w \|\| !CORE\.isItemizedOrder\(w\)\) return false;/.test(m[0]),
    'wipReverseEligible 不得再用「非 itemized 就拒绝」把旧 MAT 单挡死');
  assert.ok(/p\.items && p\.items\.some\(it => it\.executed > 0\)/.test(m[0]),
    'wipReverseEligible 必须为旧 MAT 单提供「有已执行件就亮按钮」的判定');
});

test('B2 部分冲销留痕；重试只补剩余、绝不二次冲销（2.50.1 行为不回退）', () => {
  /* 构造：BH（入库方向）执行两件，随后把第一件的库存清 0 → 冲销第一件必失败。
     修复前的隐忧是「已冲的第二件没留痕 → 重试二次冲销」。 */
  const st = baseState();
  st.materials = [{ code: 'M1', qty: 0 }, { code: 'M2', qty: 5 }];
  CORE.createOrder(st, { type: 'BH', date: '2026-09-25', code: 'BH20260925001', items: [{ matCode: 'M1', qty: 5 }, { matCode: 'M2', qty: 5 }] });
  const w = st.workorders.find(x => x.code === 'BH20260925001');
  CORE.executeOrder(st, w, { operator: '甲', execQtyByCode: { M1: 5, M2: 5 } });
  /* 让 M2 清 0：第一件 M1 可冲（BH 反向是 -qty，M1 现有 5 够扣），第二件 M2 必失败 */
  st.materials[1].qty = 0;
  const r = CORE.reverseOrder(st, w, { operator: '甲' });
  assert.equal(r.ok, false, '未全部冲完应返回 ok=false');
  assert.equal(r.partial, true, '必须标记 partial（供 UI 提示「部分完成」）');
  assert.ok(w.reverseInfo && w.reverseInfo.partial === true, 'reverseInfo 必须落 partial 标记');
  assert.deepEqual((w.reverseInfo.items || []).map(x => x.matCode), ['M1'], '已冲的 M1 必须留痕');
  assert.equal(st.materials[0].qty, 0, 'M1 应已被冲销扣走');
  /* 重试：只应补 M2（补足库存后），M1 不得被二次冲销 */
  const m1Before = st.materials[0].qty;
  st.materials[1].qty = 5;                       // 补足库存
  const r2 = CORE.reverseOrder(st, w, { operator: '甲' });
  assert.equal(r2.ok, true, '补足后应能冲完');
  assert.equal(st.materials[0].qty, m1Before, 'M1 绝不被二次冲销（数量不变）');
  assert.deepEqual((w.reverseInfo.items || []).map(x => x.matCode).sort(), ['M1', 'M2'], '两件都进 reverseInfo');
  assert.equal(w.status, '已取消', '全部冲完才关单');
});

test('B3 旧 MAT 单冲销走 applyStockChange（库存与流水成对，不是直改库存）', () => {
  const st = baseState();
  const w = mkPartialMatOrder(st, 'LL20260925002');
  const txnBefore = st.transactions.length;
  const qtyBefore = st.materials[0].qty;
  CORE.reverseOrder(st, w, { operator: '甲' });
  assert.equal(st.materials[0].qty, qtyBefore + 4, 'LL 是出库方向，冲销应 +4 回补');
  assert.equal(st.transactions.length, txnBefore + 1, '必须写一条流水');
  /* 执行与冲销各写一条，取最后一条即冲销流水（顺序：先执行、后冲销） */
  const t = st.transactions.filter(x => x.type === '冲销').pop();
  assert.ok(t, '必须有一条类型为「冲销」的流水');
  assert.equal(t.ref, 'LL20260925002', '流水必须关联工单号');
  assert.equal(t.matCode, 'M1');
  assert.equal(t.delta, 4);
});

/* ===================== 二、迁移报表分段 ===================== */

test('R1 迁移报表按 未执行 / 部分执行 分段，不再把用户引向死路', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/function renderWipMigration\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, '必须能取到 renderWipMigration 源码');
  const src = m[0];
  assert.ok(/pendingRows/.test(src) && /partialRows/.test(src), '必须分两段收集');
  assert.ok(/CORE\.isPending\(w\) \? pendingRows\.push/.test(src) || /if \(CORE\.isPending\(w\)\) pendingRows\.push/.test(src),
    '必须按 isPending 分流');
  assert.ok(/需先冲销/.test(src), '部分执行段必须标注「需先冲销」');
});

/* ===================== 三、无 IDB 时不再白扫 ===================== */

test('I1 无 IDB 时提前禁用「提交本批」并给出说明（不再扫完才说）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/const idbUnavailable = !itmPersistence && !closed;/.test(html),
    'scanWipItemized 必须在开头就算出 idbUnavailable');
  assert.ok(/idbUnavailable \? ' disabled title="本机存储不可用，无法提交"'/.test(html),
    '提交按钮必须被 disabled');
  assert.ok(/idbUnavailable \? '<span class="wip-exec-state--bad">⚠ 本机存储不可用，无法提交/.test(html),
    '必须有用户可见的警示文案');
});

/* ===================== 四、已冲销单删除前明示审计链断裂 ===================== */

test('D1 有 reverseInfo / cancelInfo 的单，删除前必须额外确认', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/const hasAuditTrail = w\.reverseInfo \|\| w\.cancelInfo;/.test(html),
    'delete 处理器必须识别「有凭据」');
  assert.ok(/hasAuditTrail && !confirm\('⚠ 该单有冲销\/取消凭据，删除后「冲销」流水将失去对应工单号（审计链断裂）/.test(html),
    '有凭据时必须走带审计链断裂警示的确认');
  assert.ok(/if \(!hasAuditTrail && !confirm\('删除工单 '/.test(html),
    '无凭据时保持原有确认（不加重弹窗）');
});

/* ===================== 五、既有行为不回退 ===================== */

test('N1 未执行的旧 MAT 单仍可直接取消（不因放开冲销而变严）', () => {
  const st = baseState();
  CORE.createOrder(st, { type: 'LL', date: '2026-09-25', code: 'LL20260925003', items: [{ matCode: 'M1', qty: 3 }] });
  const w = st.workorders[0];
  const r = CORE.cancelOrder(st, w, { operator: '甲', reason: '不需要了' });
  assert.equal(r.ok, true, '未执行的单必须仍可取消');
  assert.equal(w.status, '已取消');
  assert.equal(r.order.cancelInfo.reason, '不需要了', '取消原因必须留痕');
});

test('N2 cancelOrder 对已执行单的错误文案改为指向冲销（不再提「导出 Excel」）', () => {
  const st = baseState();
  const w = mkPartialMatOrder(st, 'LL20260925004');
  const r = CORE.cancelOrder(st, w, { operator: '甲' });
  assert.equal(r.ok, false);
  assert.match(r.error, /请用「冲销」退回后再取消\/删除/, '必须指向冲销入口');
  assert.ok(!/导出 Excel/.test(r.error), '不得再让用户导出 Excel 人工记账');
});

test('N3 物品化工单的冲销路径不受影响（回归 v3.3.1 的三重守卫）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/function wipReverseEligible\(w\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/if \(CORE\.isCancelled\(w\) \|\| w\.reverseInfo\) return false;/.test(m),
    '已取消/已冲销仍不得再冲');
  assert.ok(/if \(!p \|\| !p\.anyExecuted\) return false;/.test(m),
    '未执行仍不得冲（应走取消）');
  assert.ok(/buildItemReverseCommands/.test(m), '物品化单仍走 buildItemReverseCommands 计划');
});
