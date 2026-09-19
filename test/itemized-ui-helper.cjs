'use strict';
/* G1 工单物品化 · 页面层测试（S3 建单/列表/详情 + S4 扫码执行 + S7 迁移报表）
 *
 * 与 item-page-persistence.test.js 同款思路：index.html 的内联脚本不整体执行，
 * 而是把页面层真实函数**按源码抽取**（花括号配对），连同 linkedom 解析出的真实 DOM
 * 一起放进 vm 上下文跑。这样断言针对的是线上真代码，不是复印件。
 *
 * 覆盖：建物品化单（抽屉行/datalist/红绿提示/同码拒绝）→ 列表进度+徽标+双形态搜索
 * → 详情双形态与旧单只读裁剪 → scanWip 执行卡逐件扫码 2/3 → 重复扫拒
 * → 离线待提交（不入进度）→ 提交后补记 → 旧单迁移报表 → normalizeOrder 分流。
 */
const assert = require('node:assert/strict');  // eslint-disable-line
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const CORE = require('../mes-core.js');
const ItemLink = require('../lib/item-link.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/* 花括号配对抽取顶层函数（能正确处理字符串/模板串/正则字面量里的括号与引号） */
function fnSrc(name) {
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

const G1_BLOCK = HTML.slice(
  HTML.indexOf('/* ================= G1 物品化工单'),
  HTML.indexOf('/* 统一扫码入口：手输回车'));
assert.ok(G1_BLOCK.includes('scanWipItemized') && G1_BLOCK.includes('wipItemExecScan'), 'G1 代码块抽取失败');

/* G2 物品盘点块（stocktakeActive/stocktakeItemScan/stocktakeEnd/initItemStocktake 等），
   紧跟 handleScan 之后；末尾的 initItemStocktake() 会在 vm 装载时跑一次（刷新恢复路径）。 */
const G2_BLOCK = HTML.slice(
  HTML.indexOf('/* ================= G2 物品盘点（盘点物品化）'),
  HTML.indexOf('/* 阶段8：手机「全部」抽屉'));
assert.ok(G2_BLOCK.includes('stocktakeItemScan') && G2_BLOCK.includes('stocktakeEnd') && G2_BLOCK.includes('initItemStocktake();'), 'G2 代码块抽取失败');

const BTN_GEN = (() => {
  const start = HTML.indexOf("document.getElementById('btnGenWip').addEventListener");
  const end = HTML.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, 'btnGenWip 处理器抽取失败');
  return HTML.slice(start, end + 4);
})();

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function mkState() {
  return {
    materials: [{ code: 'MAT-A', qty: 10, name: '角钢', spec: '' }],
    locations: [{ code: 'L-1', status: 'active' }, { code: 'L-2', status: 'active' }],
    containers: [
      { code: 'CT-1', loc: 'L-1', status: 'active', version: 1 },
      { code: 'CT-2', loc: 'L-2', status: 'active', version: 1 }
    ],
    items: [
      { code: 'IT-1', name: '件1', status: 'in_stock', container: 'CT-1', version: 1 },
      { code: 'IT-2', name: '件2', status: 'in_stock', container: 'CT-1', version: 1 },
      { code: 'IT-3', name: '件3', status: 'in_stock', container: 'CT-1', version: 1 },
      { code: 'IT-P', name: '待入件', status: 'pending', container: '', version: 1 }
    ],
    workorders: [], transactions: [], serials: {}, itemOperations: [],
    necOrders: [], scanLog: [], operator: '测试员', __itmPending: {}
  };
}

/**
 * 搭一个跑真实页面代码的 vm 现场。
 * clientMode: 'applied' | 'offline' | 'rejected' —— 决定 ItemClient.submit 的行为（可随时改）。
 */
function setup(clientMode = 'applied') {
  const { document } = parseHTML(HTML);
  const state = mkState();
  const calls = { pushRecord: [], enqueue: [], alerts: [], logs: [], scanItem: 0, scanMat: 0 };
  const mock = {
    clientMode,
    enqueued: calls.enqueue,
    state,
    window: null
  };
  const persistence = {
    async enqueue(request) {
      calls.enqueue.push(request);
      state.__itmPending[request.opId] = { opId: request.opId, status: 'pending', request: JSON.parse(JSON.stringify(request)) };
    },
    async acknowledge() {}, async markUnknown() {}
  };
  const windowMock = {
    ItemLink,
    scrollY: 0, scrollTo() {},
    fetch: async () => { throw new Error('测试环境不应真的发请求'); },
    ItemClient: {
      create: () => ({
        async submit(cmd) {
          if (mock.clientMode === 'offline') throw new Error('Failed to fetch');
          if (mock.clientMode === 'rejected') return { code: cmd.id, phase: 'REJECTED', kind: cmd.request.kind, request: cmd.request, error: 'INVALID_TRANSITION' };
          return { code: cmd.id, phase: 'APPLIED', kind: cmd.request.kind, request: cmd.request };
        }
      })
    }
  };
  mock.window = windowMock;

  const context = vm.createContext({
    document, window: windowMock, state, CORE, console,
    setTimeout, clearTimeout,
    requestAnimationFrame: fn => { try { fn(); } catch (e) { } },
    itmPersistence: persistence,
    CTX: { material: null, order: null, from: null },
    WIP_TYPE_LABEL: {},
    /* ---- 页面其它部分的桩：只记录/静默，不影响被测代码 ---- */
    findMat: c => state.materials.find(m => m.code === c),
    wipTypeLabel: t => t,
    save: () => { calls.saved = (calls.saved || 0) + 1; },
    fsPushRecord: (table, rows) => calls.pushRecord.push({ table, rows: rows.map(r => r.code) }),
    fsPushStock: () => { throw new Error('物品化路径绝不应调用 fsPushStock'); },
    fsPushDelete: () => {},
    renderLedger: () => {}, renderTxns: () => {}, renderStatusBar: () => {},
    ctxSetOrder: () => {}, ctxClear: () => {}, backToWipList: () => {},
    showPlanEditor: () => {},
    wipLocalOnlyCleanupEligibility: () => ({ ok: false }),
    cleanLocalOnlyExecutedWip: async () => {},
    alert: m => calls.alerts.push(String(m)),
    confirm: () => true,
    toast: () => {}, nextStrip: () => {},
    log: m => calls.logs.push(String(m)),
    addScan: () => {},
    scanMat: () => { calls.scanMat++; }, scanWhere: () => {}, scanNec: () => {},
    scanItem: () => { calls.scanItem++; }, scanManual: () => {},
    today: () => '2026-09-19',
    pad: (n, l) => String(n).padStart(l, '0'),
    fsNextWorkorderSerial: async (type, date) => {
      const key = type + '20260919';
      state.serials[key] = 7;   // 与真实实现一致：await 之后同步占号
      return { key, next: 7, local: 6, remote: 0, warned: false };
    }
  });

  const src = [
    'let wipDetailCode = "";',
    'let _wipListScroll = 0, _wipListPageScroll = 0, _wipListFocusCode = "";',
    'const WIP_NAMES = { LL: "领料工单", BH: "补货工单", JH: "拣货工单", TL: "退料工单" };',
    'const WIP_STATUS_CLASS = { "未执行": "is-pending", "待执行": "is-pending", "部分执行": "is-active", "已执行": "is-done", "已取消": "is-cancelled" };',
    fnSrc('esc'), fnSrc('wipItemStatusLabel'), fnSrc('wipItemPosText'),
    fnSrc('refreshItemCodeDatalist'), fnSrc('wipItemCodeRow'),
    fnSrc('normalizeOrder'),
    fnSrc('wipStatusBadge'), fnSrc('wipMatchesFilter'),
    fnSrc('workorderLocalDuplicateCodes'), fnSrc('workorderLocalDuplicate'),
    fnSrc('renderWipSummary'), fnSrc('renderWip'), fnSrc('renderWipMigration'),
    fnSrc('showWipDetail'),
    fnSrc('scanStatus'), fnSrc('renderScanCard'),
    fnSrc('scanWip'),
    G1_BLOCK,
    fnSrc('handleScan'),
    G2_BLOCK,
    fnSrc('fsReleaseWorkorderSerial'),
    BTN_GEN
  ].join('\n;\n');
  vm.runInContext(src, context);
  return { context, document, state, calls, mock, persistence };
}

/** 抽屉类型下拉默认 LL（linkedom 的 select.value 不会自动取首项，要走 selected 属性） */
function chooseWipType(document, value) {
  const sel = document.getElementById('gWipType');
  for (const o of sel.options) { if (o.value === value) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
}

/** 直接走 mes-core 建一张物品化单（等价于抽屉提交后的数据层结果） */
function mkItemizedOrder(state, code, codes, opts) {
  const r = CORE.createOrder(state, Object.assign({ type: 'LL', code, date: '2026-09-19', items: [{ itemCodes: codes }] }, opts));
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.order;
}


const j = v => JSON.parse(JSON.stringify(v));   // vm realm 数组/对象 → 当前 realm（deepStrictEqual 原型检查）
module.exports = { setup, mkState, mkItemizedOrder, chooseWipType, tick, assert, CORE, vm: require('node:vm'), j };
