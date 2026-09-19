'use strict';
/* G2 Excel 物品化 + G1 遗留（updateOrderPlan 拒物品化单）+ 物品码 x数字 校验
 *
 * 页面导入处理器嵌在 4000 行内联脚本里、还挂着 FileReader —— 不整体跑；
 * 双形态单元格读写逻辑已抽成顶层命名函数（G2 Excel 块），这里按源码抽取进 vm 跑真代码。
 * 结构约束（sheet 顺序/列头/停用警告）走静态文本断言，与 excel-schema.test.js 同款思路。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CORE = require('../mes-core.js');
const ItemLink = require('../lib/item-link.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/* G2 Excel 工具块：从标记到 btnExport 接线之间的整段顶层声明 */
const G2X_BLOCK = (() => {
  const a = HTML.indexOf('/* ---------- G2 Excel 物品化');
  const b = HTML.indexOf("document.getElementById('btnExport').addEventListener");
  assert.ok(a >= 0 && b > a, 'G2 Excel 工具块抽取失败');
  return HTML.slice(a, b);
})();

function mkCtx() {
  const context = vm.createContext({ CORE, window: { ItemLink } });
  vm.runInContext(G2X_BLOCK, context);
  return context;
}
const j = v => JSON.parse(JSON.stringify(v));   // vm realm 数组/对象 → 当前 realm（deepEqual 原型检查）

const EXPORT_SRC = HTML.slice(
  HTML.indexOf("document.getElementById('btnExport').addEventListener"),
  HTML.indexOf("document.getElementById('btnImport')"));
const IMPORT_SRC = HTML.slice(
  HTML.indexOf("document.getElementById('fileImport').addEventListener"),
  HTML.indexOf("document.getElementById('btnTemplate')"));
const TEMPLATE_SRC = HTML.slice(
  HTML.indexOf("document.getElementById('btnTemplate').addEventListener"),
  HTML.indexOf('/* ---------- 全量 JSON 备份'));

/* ================= 结构：导出/模板/导入 ================= */

test('G2 导出：物料台账 sheet 已删；物品提为第一个 sheet 并扩列（状态/容器码/短码）', () => {
  assert.ok(!EXPORT_SRC.includes("'物料台账'"), '导出仍含物料台账 sheet');
  const first = EXPORT_SRC.indexOf("'物品'");
  assert.ok(first > 0, '导出缺物品 sheet');
  for (const nm of ["'库位'", "'容器'", "'人员'", "'手册'", "'工单记录'", "'NEC工单'", "'库存流水'"]) {
    assert.ok(EXPORT_SRC.indexOf(nm) > first, '物品必须是第一个 sheet，' + nm + ' 排在它前面了');
  }
  const hdr = EXPORT_SRC.match(/\['物品码', '名称', '规格型号', '状态', '容器码', '库位码', '短码'\]/);
  assert.ok(hdr, '物品 sheet 表头不是 物品码/名称/规格型号/状态/容器码/库位码/短码');
  assert.ok(/itemShortCodeText\(i\.code\)/.test(EXPORT_SRC), '短码列没有用 item-link.js 现算');
  assert.ok(/itemStatusToText\(i\.status\)/.test(EXPORT_SRC), '状态列没有转成中文标签');
});

test('G2 模板：物料台账 sheet 已删，物品 sheet 与导出同列序，填表说明写明停用与双形态', () => {
  assert.ok(!TEMPLATE_SRC.includes("'物料台账'"), '模板仍含物料台账 sheet');
  assert.ok(TEMPLATE_SRC.match(/\['物品码', '名称', '规格型号', '状态', '容器码', '库位码', '短码'\]/), '模板物品表头与导出不一致');
  assert.ok(TEMPLATE_SRC.includes('物料台账」Excel 模板已停用'), '填表说明没写物料台账停用');
  assert.ok(TEMPLATE_SRC.includes('x数字'), '填表说明没写物品码 x数字 禁令');
  assert.ok(TEMPLATE_SRC.includes('物品码逗号列表'), '填表说明没写工单明细双形态');
});

test('G2 导出「工单记录」：明细/执行数量列走双形态单元格函数', () => {
  assert.ok(/wipDetailCellText\(w\)/.test(EXPORT_SRC), '明细列没走 wipDetailCellText');
  assert.ok(/wipExecCellText\(w\)/.test(EXPORT_SRC), '执行数量列没走 wipExecCellText');
});

test('G2 导入：物料台账跳过警告在 KNOWN_SHEETS 内（不算未知 sheet）；物品双格式 + x数字 校验 + 全字段 upsert 接线', () => {
  assert.ok(/KNOWN_SHEETS = \['物料台账'/.test(IMPORT_SRC), '物料台账应保留在 KNOWN_SHEETS（否则会报成「未知 sheet」而不是「已停用」）');
  assert.ok(/物料台账」Excel 模板已停用/.test(IMPORT_SRC), '缺停用警告');
  assert.ok(/itemsFullFormat = iHdr\.indexOf\('状态'\) >= 0 && iHdr\.indexOf\('容器码'\) >= 0/.test(IMPORT_SRC),
    '物品 sheet 缺新格式（状态/容器码 表头）判别');
  assert.ok(/CORE\.badItemCodeSuffix\(c\)/.test(IMPORT_SRC), '物品导入缺 x数字 结尾校验');
  assert.ok(/itemFullRestore/.test(IMPORT_SRC), '缺新格式全字段 upsert 的暂存');
  assert.ok(/status: fullRow\.status \|\| 'unknown', container: fullRow\.container/.test(IMPORT_SRC),
    '全字段 upsert 必须含 status/container（ordinaryFields 会剥掉它们）');
  assert.ok(/parseWipDetailCell\(wItems\(r\)\)/.test(IMPORT_SRC), '工单明细没走双形态解析');
  assert.ok(/parseWipExecCell\(wcol\(r, '执行数量', 6\)\)/.test(IMPORT_SRC), '工单执行数量没走双形态解析');
  assert.ok(/execItems: execParsed\.execItems/.test(IMPORT_SRC), '导入没有把物品码列落到 execItems');
});

/* ================= 双形态单元格函数（跑真代码） ================= */

test('G2 wipDetailCellText：itemized 单 → 物品码逗号列表；旧 MAT 单 → 物料码x数量', () => {
  const c = mkCtx();
  const st = { workorders: [], items: [{ code: 'WP-TS-001' }, { code: 'WP-TS-002' }] };
  const r = CORE.createOrder(st, { type: 'LL', code: 'LL1', items: [{ itemCodes: ['WP-TS-001', 'WP-TS-002'] }] });
  assert.ok(r.ok);
  assert.equal(c.wipDetailCellText(r.order), 'WP-TS-001, WP-TS-002');
  const old = { code: 'LL2', items: [{ matCode: 'GJ-SD-001', qty: 2 }, { matCode: 'QT-9', qty: 1 }] };
  assert.equal(c.wipDetailCellText(old), 'GJ-SD-001x2; QT-9x1');
});

test('G2 wipExecCellText：itemized 单导出已扫码列表；旧 MAT 单维持 物料码=数量', () => {
  const c = mkCtx();
  const it = { itemized: true, items: [{ itemCodes: ['WP-1', 'WP-2'] }], execItems: ['WP-1'] };
  assert.equal(c.wipExecCellText(it), 'WP-1');
  const old = { items: [{ matCode: 'A', qty: 2 }], execQty: [{ matCode: 'A', qty: 1 }] };
  assert.equal(c.wipExecCellText(old), 'A=1');
});

test('G2 parseWipDetailCell：与 feishu-api DOWN 同口径（x数量 → 旧行；否则 → 物品码行），逗号/分号都认', () => {
  const c = mkCtx();
  assert.deepEqual(j(c.parseWipDetailCell('GJ-SD-001x2; QT-9x1')),
    [{ matCode: 'GJ-SD-001', qty: 2 }, { matCode: 'QT-9', qty: 1 }]);
  assert.deepEqual(j(c.parseWipDetailCell('WP-TS-001, WP-TS-002')), [{ itemCodes: ['WP-TS-001', 'WP-TS-002'] }]);
  assert.deepEqual(j(c.parseWipDetailCell('WP-TS-001；WP-TS-002')), [{ itemCodes: ['WP-TS-001', 'WP-TS-002'] }], '中文分号也要认');
  /* 混排：同一单元格两种 token 都合法（与 DOWN 一致），物品码集中成一行 */
  assert.deepEqual(j(c.parseWipDetailCell('GJ-SD-001x2; WP-TS-001')),
    [{ matCode: 'GJ-SD-001', qty: 2 }, { itemCodes: ['WP-TS-001'] }]);
  assert.deepEqual(j(c.parseWipDetailCell('')), []);
  /* 这正是「物品码不得以 x数字 结尾」的原因：WP-Xx3 会被误读成 {matCode:'WP-X', qty:3} */
  assert.deepEqual(j(c.parseWipDetailCell('WP-Xx3')), [{ matCode: 'WP-X', qty: 3 }]);
});

test('G2 parseWipExecCell：=数量 → execQty；否则 → execItems（与 DOWN.execqty 同口径）', () => {
  const c = mkCtx();
  assert.deepEqual(j(c.parseWipExecCell('A=2; B=1')), { execQty: [{ matCode: 'A', qty: 2 }, { matCode: 'B', qty: 1 }], execItems: [] });
  assert.deepEqual(j(c.parseWipExecCell('WP-1, WP-2')), { execQty: [], execItems: ['WP-1', 'WP-2'] });
  assert.deepEqual(j(c.parseWipExecCell('')), { execQty: [], execItems: [] });
});

test('G2 明细/执行数量 导出→导入 往返不丢形态', () => {
  const c = mkCtx();
  const st = { workorders: [], items: [{ code: 'WP-TS-001' }, { code: 'WP-TS-002' }] };
  const r = CORE.createOrder(st, { type: 'LL', code: 'LL1', items: [{ itemCodes: ['WP-TS-001', 'WP-TS-002'] }] });
  r.order.execItems = ['WP-TS-001'];
  const detailBack = c.parseWipDetailCell(c.wipDetailCellText(r.order));
  assert.deepEqual(j(detailBack), [{ itemCodes: ['WP-TS-001', 'WP-TS-002'] }]);
  const execBack = c.parseWipExecCell(c.wipExecCellText(r.order));
  assert.deepEqual(j(execBack.execItems), ['WP-TS-001']);
  const old = { code: 'LL2', items: [{ matCode: 'GJ-SD-001', qty: 2 }], execQty: [{ matCode: 'GJ-SD-001', qty: 1 }] };
  assert.deepEqual(j(c.parseWipDetailCell(c.wipDetailCellText(old))), [{ matCode: 'GJ-SD-001', qty: 2 }]);
  assert.deepEqual(j(c.parseWipExecCell(c.wipExecCellText(old)).execQty), [{ matCode: 'GJ-SD-001', qty: 1 }]);
});

test('G2 itemStatusFromText：中英文状态都认，乱写返回 null（调用方告警）', () => {
  const c = mkCtx();
  assert.equal(c.itemStatusFromText('在库'), 'in_stock');
  assert.equal(c.itemStatusFromText('待入库'), 'pending');
  assert.equal(c.itemStatusFromText('已出库'), 'out');
  assert.equal(c.itemStatusFromText('待核实'), 'unknown');
  assert.equal(c.itemStatusFromText('已退役'), 'retired');
  assert.equal(c.itemStatusFromText('in_stock'), 'in_stock');
  assert.equal(c.itemStatusFromText('乱写'), null);
  assert.equal(c.itemStatusFromText(''), '');
  assert.equal(c.itemStatusToText('in_stock'), '在库');
});

test('G2 itemShortCodeText：WP 数字格式出 8 位短码；遗留码留空', () => {
  const c = mkCtx();
  assert.equal(c.itemShortCodeText('WP-TS-001'), ItemLink.fromItemCode('WP-TS-001'));
  assert.equal(c.itemShortCodeText('WP-001'), ItemLink.fromItemCode('WP-001'));
  assert.equal(c.itemShortCodeText('IT-1'), '', '非 WP 数字格式的遗留码出不了短码，必须留空而不是报错');
  assert.equal(c.itemShortCodeText('WP-DEMO-001'), '');
});

/* ================= mes-core：物品码 x数字 校验 + updateOrderPlan 拒绝物品化单 ================= */

function mkCoreState() {
  return {
    materials: [{ code: 'MAT-A', qty: 10, name: '角钢' }],
    items: [{ code: 'WP-TS-001' }, { code: 'WP-TS-002' }, { code: 'WP-BADx3' }],
    workorders: [], transactions: [], serials: {}, operator: '测试员'
  };
}

test('G2 createOrder 物品化分支：物品码以「x数字」结尾 → 中文报错拒绝', () => {
  const s = mkCoreState();
  const r = CORE.createOrder(s, { type: 'LL', code: 'LL1', items: [{ itemCodes: ['WP-TS-001', 'WP-BADx3'] }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('WP-BADx3') && e.includes('x数字')), '报错要点名违规码并说明原因：' + JSON.stringify(r.errors));
  assert.equal(s.workorders.length, 0, '被拒的单不能落进 state');
  /* × 也要拦 */
  const r2 = CORE.createOrder(s, { type: 'LL', code: 'LL2', items: [{ itemCodes: ['WP-BAD×3'] }] });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some(e => e.includes('x数字')));
});

test('G2 createOrder 物品化分支：正常物品码不受影响', () => {
  const s = mkCoreState();
  const r = CORE.createOrder(s, { type: 'LL', code: 'LL1', items: [{ itemCodes: ['WP-TS-001', 'WP-TS-002'] }] });
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('G2 badItemCodeSuffix：只拦「x数字」结尾，不误伤正常码', () => {
  assert.equal(CORE.badItemCodeSuffix('WP-BADx3'), true);
  assert.equal(CORE.badItemCodeSuffix('WP-BAD×12'), true);
  assert.equal(CORE.badItemCodeSuffix('WP-TS-001'), false);
  assert.equal(CORE.badItemCodeSuffix('BOX-1'), false, 'x 后面不是数字不拦');
  assert.equal(CORE.badItemCodeSuffix('X3'), false, '大写 X 不在 DOWN 分流正则 /[x×]\\d+$/ 内，不算歧义');
});

test('G2 updateOrderPlan：物品化工单直接拒绝（取消重建），旧 MAT 单不受影响', () => {
  const s = mkCoreState();
  const r = CORE.createOrder(s, { type: 'LL', code: 'LL-IT', items: [{ itemCodes: ['WP-TS-001'] }] });
  assert.ok(r.ok);
  const up = CORE.updateOrderPlan(s, r.order, { date: '2026-09-20' });
  assert.equal(up.ok, false, '物品化单连改日期都要拒绝（计划=物品码清单，取消重建）');
  assert.match(up.error, /物品化工单/);
  assert.match(up.error, /取消/);
  assert.ok(!r.order.planEdits, '被拒的修改不能留 planEdits 痕');
  /* 旧 MAT 单照常改计划 */
  const r2 = CORE.createOrder(s, { type: 'LL', code: 'LL-MAT', items: [{ matCode: 'MAT-A', qty: 2 }] });
  assert.ok(r2.ok);
  const up2 = CORE.updateOrderPlan(s, r2.order, { items: [{ matCode: 'MAT-A', qty: 5 }] });
  assert.ok(up2.ok, JSON.stringify(up2.error || up2.errors));
  assert.equal(r2.order.items[0].qty, 5);
});
