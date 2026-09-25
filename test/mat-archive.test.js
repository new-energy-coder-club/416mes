'use strict';
/* G3 物料台账只读归档 + MAT 数量账功能封存 —— 页面层测试。
 *
 * 覆盖（对应 G3 验收范围）：
 *   范围1：台账页无编辑控件 / 无新增 / 删除入口；「历史台账 · 只读」横幅存在；
 *          存量物料数据照常渲染（不删数据）。
 *   范围2：scanMat 无低库存/负库存预警徽标与 warn 态（纯查询：名称/库位/规格）；
 *          renderLedger 无预警底色（row-low/row-neg）。
 *   范围3：页面层无闲鱼 MAT 同步入口。
 *   范围4：页面源码无 fsPushStock 调用点与函数本体；旧 MAT 单执行/冲销 handler 已删；
 *          mes-core 数量账函数上方有 G3 封存横幅（函数本体保留，安全测试不动）。
 *   范围5：页面层无库存流水表/物料台账表的 stock 推送（fsPushStock 已删，自然达成）；
 *          DOWN 同步（fsMerge/pullState）保持不动。
 *
 * 静态断言为主（与 ledger-identity / p4-conflict-paths 同款思路：钉线上真代码）；
 * scanMat 行为断言走 vm + linkedom 真实 DOM（复用 itemized-ui-helper 的抽取模式）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const REPO = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const CORE = fs.readFileSync(path.join(REPO, 'mes-core.js'), 'utf8');
/** 剥掉注释后的代码，避免把历史说明当成真实调用 */
const CODE = HTML.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function fnSrc(name) {
  const i = HTML.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '找不到 function ' + name);
  const j = HTML.indexOf('\n}', i);
  assert.ok(j > i, '找不到 function ' + name + ' 的结尾');
  return HTML.slice(i, j);
}

/** 台账页签 markup 区块 */
function ledgerSection() {
  const a = HTML.indexOf('id="tab-ledger"');
  assert.ok(a > 0, '找不到台账页签');
  return HTML.slice(a, HTML.indexOf('</section>', a));
}

/* ================= 范围1：台账页只读历史视图 ================= */

test('G3-1 页签名改为「物料台账·历史」，页头有只读归档横幅', () => {
  assert.match(HTML, /data-tab="ledger"[^>]*>物料台账·历史</, '页签名必须是「物料台账·历史」');
  const sec = ledgerSection();
  assert.ok(sec.includes('id="ledgerArchiveBanner"'), '缺少「历史台账 · 只读」横幅');
  assert.match(sec, /历史台账 · 只读/, '横幅文案必须含「历史台账 · 只读」');
  assert.match(sec, /数量账已停用，新物品请到『物品』页建档/, '横幅必须指路到物品页');
});

test('G3-1 台账页无编辑控件：无新增/删除/自动编号入口，表头无勾选列', () => {
  const sec = ledgerSection();
  for (const id of ['btnAddMat', 'btnDelMat', 'btnAutoCode', 'matCheckAll']) {
    assert.ok(!sec.includes('id="' + id + '"'), '台账页仍残留 #' + id);
  }
  assert.ok(!/class="matSel"/.test(sec), '不得残留行勾选框 .matSel');
  // 搜索与列折叠是纯展示辅助，必须保留
  assert.ok(sec.includes('id="matSearch"'), '搜索框必须保留（纯查询）');
  assert.ok(sec.includes('id="btnColsMore"'), '「显示全部列」必须保留（纯呈现）');
});

/* 阶段B：契约修正 —— 「台账只读」与「显示预警」是两件事。
   原断言把预警底色一并禁掉，导致需求书 §3.1「低于阈值黄底提示」无法实现。
   现在改为：仍然禁止任何写入口（input/select/change/applyStockChange/fsPush*），
   但允许（且要求）有预警着色与徽标。 */
test('G3-1 renderLedger 只读：无任何写入口', () => {
  const s = fnSrc('renderLedger');
  assert.ok(!/<input/.test(s), 'renderLedger 不得再渲染 input 单元格');
  assert.ok(!/<select/.test(s), 'renderLedger 不得再渲染 select 单元格');
  assert.ok(!/addEventListener\('change'/.test(s), '不得再挂单元格 change 写处理器');
  assert.ok(!/cell-qty-risk/.test(s), '库存数量高风险写入口样式必须移除');
  assert.ok(!/applyManualAdjust|applyStockChange|fsPushStock|fsPushRecord/.test(s), '渲染函数里不得有写调用');
  // 存量数据照常渲染：物料字段逐列输出
  assert.ok(/MAT_COLS\.map/.test(s), '仍按 MAT_COLS 列渲染存量物料数据');
});

/* v3.12.0（方向A「标注身份」）**有意变更**上一版 G3-1 的「必须有低库存/负库存预警」断言：
   该预警基于 `m.qty` —— 而数量账自 G3 起已归档、**永不再更新**（线上实测 qty 全为 0，
   流水停在 13 天前）。对一个不再被写入的字段弹「无库存 / 低于安全库存」并给整行染红黄底，
   只会误导现场（东西好端端在，页面却喊缺货）。
   用户拍板「方向A」——保留数据与审计能力，但把身份讲清楚。
   故现在的契约是：**数值照显 + 中性「归档」徽标 + 不再撒告警**。 */
test('v3.12.0 台账 qty 列标注归档态，不再对已停用字段撒告警', () => {
  const s = fnSrc('renderLedger');
  assert.match(s, /mat-warn--archived/, 'qty 列必须有「归档」中性徽标');
  assert.ok(!/row-neg/.test(s), '不得再按 qty 给行染负库存红底（该字段已归档）');
  assert.ok(!/row-low/.test(s), '不得再按 qty 给行染低库存黄底');
  assert.ok(!/⚠ 负库存|⚠ 低于安全库存|○ 无库存/.test(s), '不得再对归档字段报库存告警');
  assert.match(s, /历史归档/, '汇总行必须说明本页处于历史归档态');
});

test('G3-1 台账编辑/新增/删除处理器全部移除，flashQty 一并删除', () => {
  assert.ok(!/getElementById\('btnAddMat'\)/.test(CODE), '新增物料处理器必须删除');
  assert.ok(!/getElementById\('btnDelMat'\)/.test(CODE), '删除勾选行处理器必须删除');
  assert.ok(!/getElementById\('btnAutoCode'\)/.test(CODE), '自动编号处理器必须删除');
  assert.ok(!/getElementById\('matCheckAll'\)/.test(CODE), '全选勾选处理器必须删除');
  assert.ok(HTML.indexOf('function flashQty(') < 0, 'flashQty（库存改后闪烁）必须删除');
});

/* ================= 范围2：安全库存预警移除 ================= */

test('G3-2 scanMat 源码：无低库存/负库存徽标与 warn 态，保留纯查询（名称/库位/规格）', () => {
  /* 剥掉注释：G3 封存说明文字里本身含「低库存/负库存」字样 */
  const s = fnSrc('scanMat').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!/低于安全库存/.test(s), 'scanMat 不得再渲染「低于安全库存」徽标');
  assert.ok(!/负库存/.test(s), 'scanMat 不得再渲染「负库存」徽标');
  assert.ok(!/badge--danger|badge--doing/.test(s), 'scanMat 不得再渲染预警徽标');
  assert.ok(!/minQty/.test(s), 'scanMat 不得再读 minQty 做预警');
  // 命中分支必须是 ok 态（warn 只允许留在「未找到但有历史线索」的 miss 分支）
  assert.match(s, /kind: 'ok',[\s\S]{0,80}statusText: '已找到 · 只读查询/, '命中物料必须是 ok 纯查询态');
  assert.match(s, /只读查询（不改库存）/, '纯查询结论必须保留');
  assert.match(s, /当前库位/, '库位查询必须保留');
  assert.match(s, /规格/, '规格查询必须保留');
});

test('G3-2 首页运营看板无低库存/负库存预警卡片与「库存预警」瓦片', () => {
  const homeRaw = fs.readFileSync(path.join(REPO, 'home.html'), 'utf8');
  const home = homeRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.ok(!home.includes('lowList'), '首页不得再渲染低库存列表（lowList）');
  assert.ok(!/库存预警/.test(home), '首页不得再有「库存预警」瓦片');
  assert.ok(!/负库存/.test(home), '首页不得再有「负库存」预警项');
  assert.ok(!/minQty/.test(home), '首页不得再读 minQty 做预警');
});

test('G3-2 minQty 字段保留在数据层（不删字段）', () => {
  // 数据层补默认值与 Excel 列映射仍保留 minQty（UI 不预警，字段不删）
  assert.match(CODE, /if \(m\.minQty == null\) m\.minQty = 0;/, 'load() 仍补 minQty 默认值');
  assert.match(HTML, /minQty: '安全库存'/, 'Excel 列映射仍保留 minQty 字段');
});

/* ================= 范围3：闲鱼 MAT 同步移除 ================= */

test('G3-3 页面层无闲鱼同步入口；xianyu-sync.mjs 保留并标注已停用', () => {
  assert.ok(!/mergeXianyu/.test(CODE), '页面层不得再调用 mergeXianyu');
  assert.ok(!/xianyu-sync/.test(HTML), 'index.html 不得再引用 xianyu-sync');
  const xy = fs.readFileSync(path.join(REPO, 'xianyu-sync.mjs'), 'utf8');
  assert.match(xy, /G3 已停用/, 'xianyu-sync.mjs 必须标注「G3 已停用」');
  assert.match(xy, /闲鱼挂的是分类级商品，与单件物品不同层/, '停用说明必须写明原因');
});

/* ================= 范围4：MAT 写路径封存 ================= */

test('G3-4 页面源码无 fsPushStock 调用点与函数本体', () => {
  assert.ok(HTML.indexOf('function fsPushStock(') < 0, 'fsPushStock 函数本体必须已删除');
  const sites = [...CODE.matchAll(/fsPushStock\(([^\n]*?)\);/g)].map(m => m[1]);
  assert.deepEqual(sites, [], '页面层不得残留任何 fsPushStock 调用点');
  // fsPushRecord 是通用推送（物品也在用），必须保留
  assert.ok(HTML.indexOf('function fsPushRecord(') > 0, 'fsPushRecord（通用推送）必须保留');
});

test('G3-4 旧 MAT 单执行/冲销的页面 handler 已删：scanWip 只剩只读历史卡', () => {
  /* 剥掉注释：G3 封存说明文字里本身含 execQty / fsPushStock 字样 */
  const s = fnSrc('scanWip').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!/fsPushStock/.test(s), 'scanWip 不得再有库存直写');
  assert.ok(!/CORE\.executeOrder/.test(s), 'scanWip 不得再调用 executeOrder');
  assert.ok(!/execQty/.test(s), 'scanWip 不得再有 execQty 输入框');
  assert.match(s, /物料工单（历史）· 数量执行已停用/, '旧 MAT 单必须给出「数量执行已停用」结论');
  assert.match(s, /数量工单已封存/, '旧单必须引导取消后按物品化流程重建');
  /* 阶段B：详情页不再有旧的同步冲销死代码（doReverse/showReversePreview/reversePanel 均不得复活），
     但**新的**物品化冲销入口（btnWipReverse → wipReversePreview → wipReverseRun）是有意重开的：
     误执行的工单必须能退回。约束从「不许有」改成「只许走物品操作协议」。 */
  const d = fnSrc('showWipDetail').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!/doReverse|showReversePreview|reversePanel/.test(d), '旧的同步冲销死代码不得复活');
  assert.match(d, /btnWipReverse/, '新的物品化冲销入口必须接线');
  assert.ok(!/fsPushStock/.test(d), '详情页不得库存直写');
  /* 反向命令只能经 itmPersistence 入队 */
  const run = fnSrc('wipReverseRun').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!/fsPushStock|applyStockChange/.test(run), '冲销路径不得库存直写');
  assert.match(run, /itmPersistence\.enqueue/, '反向命令必须走物品操作协议入队');
});

test('G3-4 mes-core 数量账函数保留且上方有统一封存横幅（函数本体不删）', () => {
  for (const fn of ['applyStockChange', 'executeOrder', 'reverseOrder', 'updateOrderPlan',
    'applyStocktake', 'applyManualAdjust', 'ledgerRepairPlan', 'replayAudit']) {
    assert.ok(CORE.indexOf('function ' + fn + '(') > 0, 'mes-core 必须保留 ' + fn);
    const i = CORE.indexOf('function ' + fn + '(');
    const above = CORE.slice(Math.max(0, i - 700), i);
    assert.match(above, /G3 封存/, fn + ' 上方必须有 G3 封存横幅');
    assert.match(above, /新功能禁止调用/, fn + ' 封存横幅必须含「新功能禁止调用」');
  }
  // 导出表仍导出这些函数（回放审计等历史能力可用）
  for (const fn of ['applyStockChange', 'executeOrder', 'reverseOrder', 'applyStocktake', 'replayAudit']) {
    assert.match(CORE, new RegExp('\\b' + fn + ': ' + fn + '\\b'), fn + ' 仍须导出');
  }
});

/* ================= 范围5：飞书写路径封存 / DOWN 同步不动 ================= */

test('G3-5 页面层不再有库存流水表推送；DOWN 同步（fsMerge/pullState）保持不动', () => {
  // 写路径：fsPushStock 已删（范围4），不再有 stock 推送
  assert.ok(!/op: 'stock'/.test(CODE), '页面层不得再产生 op:stock 推送条目');
  // DOWN 同步保持不动：fsMerge / pullState / applyRemoteChanges 仍在页面层接线
  assert.ok(HTML.indexOf('function fsMerge(') > 0, 'fsMerge（DOWN 同步）必须保留');
  assert.ok((CODE.match(/fsMerge\(/g) || []).length >= 3, 'fsMerge 调用点（导入合并/云端拉取等）必须仍接线');
  // 飞书后台脚本不动
  for (const f of ['feishu-sync.mjs', 'feishu-import.mjs', 'nec-sync.mjs']) {
    assert.ok(fs.existsSync(path.join(REPO, f)), f + ' 必须保留');
  }
});

/* ================= scanMat 行为级断言（vm + linkedom 真实现场） ================= */

/* 花括号配对抽取（fnSrc 按首个换行+} 截断会被 scanMat 字符串里的 '\\n}' 骗到；
   与 itemized-ui-helper.cjs 同款配对逻辑） */
function fnSrcBalanced(name) {
  const start = HTML.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '找不到函数 ' + name);
  const brace = HTML.indexOf('{', start);
  let depth = 0, quote = '', esc = false, regex = false, cls = false, prev = '';
  for (let i = brace; i < HTML.length; i++) {
    const ch = HTML[i];
    if (regex) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '[') cls = true;
      else if (ch === ']') cls = false;
      else if (ch === '/' && !cls) regex = false;
      continue;
    }
    if (quote) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && '(=,:[!&|?{};\n'.includes(prev)) { regex = true; cls = false; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return HTML.slice(start, i + 1);
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error('函数未闭合 ' + name);
}

test('G3-2 行为：scanMat 命中低库存物料也只给纯查询卡（无徽标、无 warn 态）', () => {
  const { document } = parseHTML(HTML);
  const state = {
    materials: [{ code: 'MAT-LOW', name: '低库存件', spec: 'S-1', qty: 1, minQty: 5, cost: 3, loc: 'B-01-01' }],
    locations: [], containers: [], scanLog: [], operator: '测试员'
  };
  const calls = { logs: [] };
  const context = vm.createContext({
    document, state, CORE: require('../mes-core.js'), console,
    findMat: c => state.materials.find(m => m.code === c),
    renderScanCard: undefined,
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    locationCard: () => '',
    ctxSetMaterial: () => {}, addScan: () => {},
    log: m => calls.logs.push(String(m))
  });
  // 从真源码抽 scanMat + renderScanCard（保持真实现，不复印）
  const src = [fnSrcBalanced('scanStatus'), fnSrcBalanced('renderScanCard'), fnSrcBalanced('scanMat')].join('\n;\n');
  vm.runInContext(src, context);
  const box = document.createElement('div');
  context.scanMat('MAT-LOW', box);
  const html = box.innerHTML;
  assert.match(html, /已找到 · 只读查询（不改库存）/, '命中物料必须是纯查询结论');
  assert.ok(!/低于安全库存|负库存/.test(html), '结果卡不得出现任何预警徽标文案');
  assert.ok(!/badge--/.test(html), '结果卡不得出现徽标元素');
  assert.ok(!/scan-status--warn/.test(html), '命中卡不得是 warn 态');
  assert.match(html, /低库存件/, '名称必须展示');
  assert.match(html, /B-01-01/, '库位必须展示');
  assert.match(html, /S-1/, '规格必须展示');
  assert.ok(calls.logs.some(l => /查询物料 MAT-LOW/.test(l) && !/低库存/.test(l)), '日志不得再标「低库存」');
});
