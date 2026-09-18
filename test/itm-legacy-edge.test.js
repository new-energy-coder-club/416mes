'use strict';
/* 临时审核脚本：物品「在飞书表中但没有任何位置」的边界行为。
 * 只读审核用，不改业务代码；跑完即可删除。
 * 生产布景：WP-001 = 飞书物品表导入的旧物品（status=unknown, container='', loc='W01-G01'）。
 */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const U = require('../lib/unique-items');
const Scan = require('../lib/item-scan');
const { parseHTML } = require('linkedom');
const UI = require('../lib/item-ui');

const ADMIN = { id: 'admin-1', roles: ['admin', 'operator'] };
const OPERATOR = { id: 'op-1', roles: ['operator'] };

function state() {
  return {
    locations: [
      { code: 'W01-G01', status: 'active' },
      { code: 'W02-G01', status: 'active' }
    ],
    containers: [
      { code: 'C-A', loc: 'W01-G01', status: 'active', version: 1, lastOpId: '' },
      { code: 'C-D', loc: 'W02-G01', status: 'active', version: 1, lastOpId: '' },
      { code: 'C-B', loc: '', status: 'active', version: 1, lastOpId: '' },        // 已启用但未定位
      { code: 'C-OLD', loc: 'W02-G01', status: 'unknown', version: 0, lastOpId: '' }, // 旧容器：待核实 + 旧loc
      { code: 'C-NEW', loc: '', status: 'unknown', version: 0, lastOpId: '' }        // 新容器：待核实无loc
    ],
    items: [
      { code: 'WP-001', name: '电烙铁', spec: '60W', loc: 'W01-G01', status: 'unknown', container: '', version: 0, lastOpId: '' }, // 生产实物
      { code: 'WP-NEW', name: '新建档', status: 'pending', container: '', version: 1, lastOpId: '' },                            // registerItem 产物
      { code: 'WP-OUT', name: '已出库', status: 'out', container: '', version: 2, lastOpId: '' }
    ],
    itemOperations: []
  };
}
function scanOf(st, kind) { let n = 0; const s = Scan.create({ getState: () => st, id: () => 'id-' + (++n) }); s.add(kind); return s; }
function outcome(fn) { try { const r = fn(); return { ok: true, result: r }; } catch (e) { return { ok: false, error: e.message, code: e.code || '' }; } }

/* ---------- A. 扫码层（lib/item-scan.js accept）---------- */
test('A1 receive: pending物品(表中无位置) 正常放行，三码完成', () => {
  const st = state(), s = scanOf(st, 'receive');
  s.accept('LOC:W01-G01'); s.accept('CTN:C-A');
  const r = outcome(() => s.accept('ITM:WP-NEW'));
  assert.equal(r.ok, true); assert.equal(r.result.complete, true);
  const q = s.request();
  assert.equal(q.kind, 'receive'); assert.deepEqual(q.target, { loc: 'W01-G01', container: 'C-A' });
});
test('A2 receive: 目标容器未定位(loc空) 在CTN步被拒', () => {
  const st = state(), s = scanOf(st, 'receive');
  s.accept('LOC:W01-G01');
  const r = outcome(() => s.accept('CTN:C-B'));
  assert.equal(r.ok, false); assert.match(r.error, /容器与库位归属不符/);
});
test('A3 receive: unknown旧物品(WP-001) 在ITM步被拒', () => {
  const st = state(), s = scanOf(st, 'receive');
  s.accept('LOC:W01-G01'); s.accept('CTN:C-A');
  const r = outcome(() => s.accept('ITM:WP-001'));
  assert.equal(r.ok, false); assert.match(r.error, /尚待核实|不能重复入库|不允许入库/);   // 修复后拆分文案
});
test('A4 verifyLegacy: WP-001 扫旧loc(W01-G01) 扫码层全通过', () => {
  const st = state(), s = scanOf(st, 'verifyLegacy');
  s.accept('LOC:W01-G01'); s.accept('CTN:C-A');
  const r = outcome(() => s.accept('ITM:WP-001'));
  assert.equal(r.ok, true); assert.equal(r.result.complete, true);
});
test('A5 verifyLegacy: WP-001 实物在W02-G01 扫码层也放行(冲突留给plan)', () => {
  const st = state(), s = scanOf(st, 'verifyLegacy');
  s.accept('LOC:W02-G01'); s.accept('CTN:C-D');
  const r = outcome(() => s.accept('ITM:WP-001'));
  assert.equal(r.ok, true); assert.equal(r.result.complete, true);
});
test('A6 issue: WP-001(unknown) 在ITM步被拒', () => {
  const st = state(), s = scanOf(st, 'issue');
  s.accept('LOC:W01-G01'); s.accept('CTN:C-A');
  const r = outcome(() => s.accept('ITM:WP-001'));
  assert.equal(r.ok, false); assert.match(r.error, /状态或来源容器不符/);
});
test('A7 receive: 完全未建档裸码 WP-999 → NOT_FOUND 原始英文错误', () => {
  const st = state(), s = scanOf(st, 'receive');
  s.accept('LOC:W01-G01'); s.accept('CTN:C-A');
  const r = outcome(() => s.accept('WP-999'));
  assert.equal(r.ok, false); assert.equal(r.error, 'items: WP-999');
});
test('A8 placeContainer: unknown容器被拒「容器未启用」；active未定位容器可定位；已定位被拒', () => {
  const st = state();
  const s1 = scanOf(st, 'placeContainer'); s1.accept('LOC:W01-G01');
  assert.match(outcome(() => s1.accept('CTN:C-NEW')).error, /容器未启用/);
  const s2 = scanOf(st, 'placeContainer'); s2.accept('LOC:W01-G01');
  assert.equal(outcome(() => s2.accept('CTN:C-B')).ok, true);
  const s3 = scanOf(st, 'placeContainer'); s3.accept('LOC:W02-G01');
  assert.match(outcome(() => s3.accept('CTN:C-A')).error, /容器已有库位/);
});

/* ---------- B. 领域层（lib/unique-items.js plan）---------- */
const baseReq = (kind, extra) => ({ schemaVersion: 1, opId: 'op-' + kind, kind, expected: {}, ...extra });
test('B1 plan receive WP-NEW(pending,无位置) → 允许', () => {
  const st = state();
  const p = U.plan(st, baseReq('receive', { itemCode: 'WP-NEW', target: { loc: 'W01-G01', container: 'C-A' }, expected: { itemVersion: 1, containerVersion: 1 } }), OPERATOR);
  assert.equal(p.after.items[0].status, 'in_stock'); assert.equal(p.after.items[0].container, 'C-A');
});
test('B2 plan receive 目标容器未定位 → CONTAINER_LOCATION_MISMATCH(英文码)', () => {
  const st = state();
  const r = outcome(() => U.plan(st, baseReq('receive', { itemCode: 'WP-NEW', target: { loc: 'W01-G01', container: 'C-B' }, expected: { itemVersion: 1, containerVersion: 1 } }), OPERATOR));
  assert.equal(r.error, 'CONTAINER_LOCATION_MISMATCH');
});
test('B3 plan verifyLegacy WP-001 目标=旧loc W01-G01 + admin → 允许', () => {
  const st = state();
  const p = U.plan(st, baseReq('verifyLegacy', { itemCode: 'WP-001', target: { loc: 'W01-G01', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 1 } }), ADMIN);
  assert.equal(p.after.items[0].status, 'in_stock');
});
test('B4 plan verifyLegacy WP-001 实物在W02-G01(≠旧loc) → LEGACY_LOCATION_CONFLICT 卡死', () => {
  const st = state();
  const r = outcome(() => U.plan(st, baseReq('verifyLegacy', { itemCode: 'WP-001', target: { loc: 'W02-G01', container: 'C-D' }, expected: { itemVersion: 0, containerVersion: 1 } }), ADMIN));
  assert.equal(r.error, 'LEGACY_LOCATION_CONFLICT');
});
test('B5 plan verifyLegacy 非admin操作员 → FORBIDDEN(与loc无关先被权限拦)', () => {
  const st = state();
  const r = outcome(() => U.plan(st, baseReq('verifyLegacy', { itemCode: 'WP-001', target: { loc: 'W01-G01', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 1 } }), OPERATOR));
  assert.equal(r.error, 'FORBIDDEN');
});
test('B6 plan receive/issue WP-001(unknown) → INVALID_TRANSITION', () => {
  const st = state();
  assert.equal(outcome(() => U.plan(st, baseReq('receive', { itemCode: 'WP-001', target: { loc: 'W01-G01', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 1 } }), OPERATOR)).error, 'INVALID_TRANSITION');
  assert.equal(outcome(() => U.plan(st, baseReq('issue', { itemCode: 'WP-001', source: { loc: 'W01-G01', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 1 } }), OPERATOR)).error, 'INVALID_TRANSITION');
});
test('B7 plan activateContainer C-OLD(旧loc=W02-G01) 目标W01-G01 → LEGACY_LOCATION_CONFLICT；目标=旧loc才放行', () => {
  const st = state();
  assert.equal(outcome(() => U.plan(st, baseReq('activateContainer', { containerCode: 'C-OLD', target: { loc: 'W01-G01' }, expected: { containerVersion: 0 } }), ADMIN)).error, 'LEGACY_LOCATION_CONFLICT');
  const p = U.plan(st, baseReq('activateContainer', { containerCode: 'C-OLD', target: { loc: 'W02-G01' }, expected: { containerVersion: 0 } }), ADMIN);
  assert.equal(p.after.containers[0].status, 'active');
});
test('B8 plan activateContainer C-NEW(无旧loc) → 允许', () => {
  const st = state();
  const p = U.plan(st, baseReq('activateContainer', { containerCode: 'C-NEW', target: { loc: 'W01-G01' }, expected: { containerVersion: 0 } }), ADMIN);
  assert.equal(p.after.containers[0].loc, 'W01-G01');
});
test('B9 修复后：verifyLegacy 冲突可用 confirmLegacyLocOverride 放行，unknown 也可 retire（有出口）', () => {
  const st = state();
  // 覆盖开关：实物现场确认后放行，before 留旧值可审计
  const ok = U.plan(st, baseReq('verifyLegacy', { itemCode: 'WP-001', target: { loc: 'W02-G01', container: 'C-D' }, expected: { itemVersion: 0, containerVersion: 1 }, confirmLegacyLocOverride: true }), ADMIN);
  assert.equal(ok.after.items[0].status, 'in_stock');
  assert.equal(ok.before.items[0].loc, 'W01-G01');
  // 不带覆盖仍拒绝
  assert.equal(outcome(() => U.plan(state(), baseReq('verifyLegacy', { itemCode: 'WP-001', target: { loc: 'W02-G01', container: 'C-D' }, expected: { itemVersion: 0, containerVersion: 1 } }), ADMIN)).error, 'LEGACY_LOCATION_CONFLICT');
  // unknown 允许退役（最终出口）
  const retired = U.plan(state(), baseReq('retire', { itemCode: 'WP-001', expected: { itemVersion: 0 } }), ADMIN);
  assert.equal(retired.after.items[0].status, 'retired');
});

/* ---------- C. UI 层（lib/item-ui.js acceptGuided / describeWorkHit）---------- */
function setupUI(st) {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const { document } = parseHTML(html);
  let n = 0;
  const page = UI.mount({ document, getState: () => st, getPersistence: () => null, getCommands: async () => [], id: () => 'ui-' + (++n) });
  return { document, page };
}
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
test('C1 UI receive扫WP-001 → 给出「切换旧物品核实」引导按钮', async () => {
  const st = state(), { document: d, page } = setupUI(st);
  await page.accept('LOC:W01-G01'); await page.accept('CTN:C-A');
  d.getElementById('itmCode').value = 'ITM:WP-001'; d.getElementById('itmScanBtn').click(); await tick();
  assert.match(d.getElementById('itmStatus').textContent, /尚待核实|重复入库/);
  const btn = d.getElementById('itmStatus').querySelector('button');
  assert.ok(btn, '应有引导按钮'); assert.match(btn.textContent, /旧物品核实/);
  btn.click(); await tick();
  assert.equal(page.scan.row().kind, 'verifyLegacy');
});
test('C2 修复后：UI receive扫未建档WP-999 → 中文提示 + 建档引导按钮并带入该码', async () => {
  const st = state(), { document: d, page } = setupUI(st);
  await page.accept('LOC:W01-G01'); await page.accept('CTN:C-A');
  d.getElementById('itmCode').value = 'ITM:WP-999'; d.getElementById('itmScanBtn').click(); await tick();
  assert.match(d.getElementById('itmStatus').textContent, /未建档|未找到对应档案/);
  const btn = d.getElementById('itmStatus').querySelector('button');
  assert.ok(btn, '修复后应有建档引导按钮');
  btn.click(); await tick();
  assert.equal(d.getElementById('itmRegisterCode').value, 'WP-999');
});
test('C3 修复后：建档可沿用扫到的实物码 WP-999', async () => {
  const st = state(), { document: d } = setupUI(st);
  let queued = null;
  const p = { enqueue: async r => { queued = r; }, saveDraft: async () => {}, recover: async () => ({ drafts: [], commands: [] }) };
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const { document: d2 } = parseHTML(html);
  let n = 0;
  UI.mount({ document: d2, getState: () => st, getPersistence: () => p, getCommands: async () => [], id: () => 'gen-' + (++n) });
  // itmRegisterType 默认第一选项即 registerItem（linkedom 不允许 set select.value）
  d2.getElementById('itmRegisterCode').value = 'WP-999';   // 修复后：沿用扫到的实物码
  d2.getElementById('itmRegisterName').value = '现场扫到的未知码';
  d2.getElementById('itmRegister').click(); await tick();
  assert.equal(queued.kind, 'registerItem');
  assert.equal(queued.entity.code, 'WP-999', '修复后应沿用扫到的实物码');
});
