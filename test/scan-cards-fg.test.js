'use strict';
/* BUG-F/G 修复回归（全链路实测报告 v3.1.1 发现）
 *
 * BUG-F：扫码台 LOC/CTN 查询卡只统计旧数量账（物料）——有在库物品的库位/容器
 *        也显示「该位置为空」，CTN 卡还不显示所在库位。
 * BUG-G：扫码台 ITM 查询卡「库位 —」——物品位置应由容器归属派生
 *        （与「查询」tab/盘点卡同一逻辑）。
 *
 * 与 mat-archive.test.js 同款 harness：从 index.html 真源码花括号配对抽取
 * scanWhere / scanItem / renderScanCard / scanStatus，vm + linkedom 真实现场断言。 */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseHTML } = require('linkedom');
const CORE = require('../mes-core.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

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

const ITEM_STATUS_ZH = { pending: '待入库', in_stock: '在库', out: '已出库', unknown: '待核实', retired: '已退役' };

function setup(state) {
  const { document } = parseHTML(HTML);
  const calls = { logs: [] };
  const context = vm.createContext({
    document, state, CORE, console,
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    itemStatusToText: st => ITEM_STATUS_ZH[st] || (st || '待核实'),
    addScan: () => {},
    log: m => calls.logs.push(String(m))
  });
  const src = [fnSrcBalanced('scanStatus'), fnSrcBalanced('renderScanCard'), fnSrcBalanced('scanWhere'), fnSrcBalanced('scanItem')].join('\n;\n');
  vm.runInContext(src, context);
  return { document, context, calls };
}

const BASE_STATE = {
  materials: [],
  locations: [{ code: 'L-1', kind: '货架', desc: 'B区 1号货架', status: 'active' }],
  containers: [{ code: 'C-1', type: '盒', loc: 'L-1', status: 'active' }],
  items: [
    { code: 'WP-TS-001', name: '示波器', spec: '100MHz', status: 'in_stock', container: 'C-1', loc: '' },
    { code: 'WP-QT-001', name: '杂项盒', spec: '通用', status: 'out', container: '', loc: '' }
  ],
  scanLog: [], operator: '测试员'
};

test('BUG-G：ITM 查询卡按容器派生位置（在库），不再显示「库位 —」', () => {
  const { document, context } = setup(structuredClone(BASE_STATE));
  const box = document.createElement('div');
  context.scanItem('WP-TS-001', box);
  const html = box.innerHTML;
  assert.match(html, /在库/, '必须显示物品状态');
  assert.match(html, /C-1 → L-1/, '必须派生「容器 → 库位」');
  assert.match(html, /B区 1号货架/, '库位说明必须随派生位置展示');
  assert.ok(!/>库位</.test(html) || !/库位<[^>]*>[^<]*—/.test(html), '不得再出现「库位 —」');
});

test('BUG-G：出库物品显示「—（已出库）」而非空库位', () => {
  const { document, context } = setup(structuredClone(BASE_STATE));
  const box = document.createElement('div');
  context.scanItem('WP-QT-001', box);
  const html = box.innerHTML;
  assert.match(html, /已出库/);
  assert.match(html, /—（已出库）/);
});

test('BUG-F：LOC 卡展示容器与在库物品（无物料也不得说「该位置为空」）', () => {
  const { document, context } = setup(structuredClone(BASE_STATE));
  const box = document.createElement('div');
  context.scanWhere('LOC:', 'L-1', box);
  const html = box.innerHTML;
  assert.match(html, /容器 1 个/);
  assert.match(html, /在库物品 1 件/);
  assert.match(html, /WP-TS-001/, '在库物品清单必须列出物品码');
  assert.match(html, /示波器/);
  assert.match(html, /C-1/, 'LOC 卡必须列出容器码');
  assert.ok(!/该位置为空/.test(html), '有容器/在库物品时不得显示「该位置为空」');
});

test('BUG-F：CTN 卡显示所在库位与内含物品', () => {
  const { document, context } = setup(structuredClone(BASE_STATE));
  const box = document.createElement('div');
  context.scanWhere('CTN:', 'C-1', box);
  const html = box.innerHTML;
  assert.match(html, /在 L-1/, '状态行必须带所在库位');
  assert.match(html, /所在库位/);
  assert.match(html, /在库物品 1 件/);
  assert.match(html, /WP-TS-001/);
  assert.ok(!/该位置为空/.test(html));
});

test('BUG-F 回归守卫：真正全空的库位仍显示「该位置为空」', () => {
  const st = structuredClone(BASE_STATE);
  st.containers = []; st.items = [];
  const { document, context } = setup(st);
  const box = document.createElement('div');
  context.scanWhere('LOC:', 'L-1', box);
  assert.match(box.innerHTML, /该位置为空/);
});
