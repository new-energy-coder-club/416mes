'use strict';
/* E2（定稿 §五/§6.7.1、§6.7.3）：qrPayload 单点构造 + 短链面板纯函数单测。
   纯函数定义在 index.html 内联脚本里，这里按 align-recovery 的方式提取源码、
   new Function 注入依赖（window.ItemLink / TYPES）后跑真实逻辑。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ItemLink = require('../lib/item-link');

function fnSrc(name) {
  const start = HTML.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '找不到函数 ' + name);
  const brace = HTML.indexOf('{', start);
  let depth = 0, quote = '', esc = false;
  for (let i = brace; i < HTML.length; i++) {
    const ch = HTML[i];
    if (quote) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++; else if (ch === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error('函数未闭合 ' + name);
}
const TYPES = {
  loc: { prefix: 'LOC:' }, ctn: { prefix: 'CTN:' }, mat: { prefix: 'MAT:' }, itm: { prefix: 'ITM:' },
  man: { prefix: 'MAN:' }, wip: { prefix: 'WIP:' }, nec: { prefix: 'NEC:' }, zone: { prefix: 'LOC:' }
};
function loadFn(name, extraWindow) {
  const win = Object.assign({ ItemLink }, extraWindow || {});
  const deps = { shortlinksCsvText: ['csvEscCell'], shortlinksCopyText: [], shortlinkRows: [], qrPayload: [], labelAttrs: [], csvEscCell: [] };
  const src = (deps[name] || []).map(fnSrc).join('') + fnSrc(name);
  return new Function('window', 'TYPES', src + '; return ' + name + ';')(win, TYPES);
}

const LINK_001 = 'https://mes.newenergycoder.club/i/KW4QYSBD';   // test/item-link.test.js 锁值

/* ---------- qrPayload 单点构造（§6.3.1） ---------- */
test('qrPayload：itm 规范码 → 42 字符大写短链', () => {
  const qrPayload = loadFn('qrPayload');
  assert.equal(qrPayload('itm', 'WP-001'), LINK_001);
  assert.equal(qrPayload('itm', 'WP-TS-001'), 'https://mes.newenergycoder.club/i/5W4QY7BQ');
  const link = qrPayload('itm', 'WP-001');
  assert.equal(link.length, 42, '印刷版短链全长必须 42 字符（QR V3-M 零余量，不可再加字符）');
  assert.match(link, /\/i\/[0-9A-HJKMNP-TV-Z]{8}$/, '短码部分必须是 8 位大写 Crockford');
});
test('qrPayload：ItemLink 缺失时 itm 回退旧 ITM: 格式，页面不崩', () => {
  const qrPayload = new Function('window', 'TYPES', fnSrc('qrPayload') + '; return qrPayload;')({}, TYPES);
  assert.equal(qrPayload('itm', 'WP-001'), 'ITM:WP-001');
});
test('qrPayload：WP-随机串等非规范码回退 ITM:<原码>（旧标签永久可读）', () => {
  const qrPayload = loadFn('qrPayload');
  assert.equal(qrPayload('itm', 'WP-a1b2c3d4'), 'ITM:WP-a1b2c3d4');
  assert.equal(qrPayload('itm', 'WP-DEMO-001'), 'ITM:WP-DEMO-001');
});
test('qrPayload：非 itm 类型一律走 TYPES 前缀（短链短路不截获旧前缀码）', () => {
  const qrPayload = loadFn('qrPayload');
  assert.equal(qrPayload('loc', 'A4SH-001'), 'LOC:A4SH-001');
  assert.equal(qrPayload('mat', 'M-001'), 'MAT:M-001');
  assert.equal(qrPayload('ctn', 'C-01'), 'CTN:C-01');
  assert.equal(qrPayload('wip', 'LL20260916001'), 'WIP:LL20260916001');
});

/* ---------- shortlinkRows（面板数据源，§6.2） ---------- */
test('shortlinkRows：规范码给短码+短链，非规范码留空且 ok=false（不静默跳过）', () => {
  const shortlinkRows = loadFn('shortlinkRows');
  const rows = shortlinkRows([
    { code: 'WP-001', name: '齿轮', materialCode: 'M-001' },
    { code: 'WP-a1b2c3d4', name: '历史随机码', materialCode: '' },
    { code: 'WP-TS-002', name: 'TS 件', materialCode: 'M-TS' }
  ]);
  assert.equal(rows.length, 3, '非规范码行必须保留在面板里标状态，不得过滤');
  assert.deepEqual(rows[0], { code: 'WP-001', name: '齿轮', mat: 'M-001', short: 'KW4QYSBD', link: LINK_001, ok: true });
  assert.equal(rows[1].short, '');
  assert.equal(rows[1].link, '');
  assert.equal(rows[1].ok, false);
  assert.equal(rows[2].short, ItemLink.fromItemCode('WP-TS-002'));
  assert.equal(rows[2].link, ItemLink.linkFor('WP-TS-002'));
});
test('shortlinkRows：ItemLink 缺失时全部回退 ok=false，不抛异常', () => {
  const shortlinkRows = new Function('window', 'TYPES', fnSrc('shortlinkRows') + '; return shortlinkRows;')({}, TYPES);
  const rows = shortlinkRows([{ code: 'WP-001', name: 'x' }]);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].link, '');
});

/* ---------- CSV（§6.6、§6.7.3） ---------- */
test('shortlinksCsvText：BOM + 固定 5 列表头 + 行数 === 选择集 + 顺序保持', () => {
  const shortlinkRows = loadFn('shortlinkRows');
  const shortlinksCsvText = loadFn('shortlinksCsvText');
  const rows = shortlinkRows([
    { code: 'WP-001', name: '齿轮', materialCode: 'M-001' },
    { code: 'WP-TS-002', name: 'TS 件', materialCode: '' }
  ]);
  const csv = shortlinksCsvText(rows);
  assert.equal(csv.charCodeAt(0), 0xFEFF, '必须以 UTF-8 BOM 开头（Excel 直开不乱码）');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], '物品码,名称,关联物料,短码,短链接', '表头固定 5 列');
  assert.equal(lines.length - 1 /* 末尾 CRLF 产生的空串 */, 1 + rows.length, '数据行数 === 选择集大小');
  assert.equal(lines[1], 'WP-001,齿轮,M-001,KW4QYSBD,' + LINK_001, '顺序 = 传入顺序（调用方保证下标升序）');
  assert.ok(lines[2].startsWith('WP-TS-002,'), '第二行顺序保持');
});
test('shortlinksCsvText：RFC4180 转义 —— 含逗号/引号/换行的字段加引号且引号双写', () => {
  const shortlinksCsvText = loadFn('shortlinksCsvText');
  const csv = shortlinksCsvText([
    { code: 'WP-001', name: '齿轮,大', mat: 'M-"特"', short: 'KW4QYSBD', link: LINK_001 },
    { code: 'WP-a1b2', name: '换\n行', mat: '', short: '', link: '' }
  ]);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[1], 'WP-001,"齿轮,大","M-""特""",KW4QYSBD,' + LINK_001);
  /* 非规范码行：短码/短链接留空但行保留 */
  assert.ok(lines[2].startsWith('WP-a1b2,'), '非规范码行必须保留');
  assert.ok(lines[2].endsWith(',,'), '非规范码行短码/短链接留空');
});
test('csvEscCell：普通字段不加引号', () => {
  const csvEscCell = loadFn('csvEscCell');
  assert.equal(csvEscCell('WP-001'), 'WP-001');
  assert.equal(csvEscCell(''), '');
  assert.equal(csvEscCell(null), '');
  assert.equal(csvEscCell('a,b'), '"a,b"');
  assert.equal(csvEscCell('a"b'), '"a""b"');
});

/* ---------- 复制全部（§6.6、§6.7.3） ---------- */
test('shortlinksCopyText：每行恰好 42 字符完整短链、LF 分隔、无表头无引号', () => {
  const shortlinkRows = loadFn('shortlinkRows');
  const shortlinksCopyText = loadFn('shortlinksCopyText');
  const rows = shortlinkRows([
    { code: 'WP-001', name: '齿轮' },
    { code: 'WP-a1b2c3d4', name: '随机码（无短链，复制时跳过）' },
    { code: 'WP-TS-002', name: 'TS 件' }
  ]);
  const text = shortlinksCopyText(rows);
  const lines = text.split('\n');
  assert.equal(lines.length, 2, '无短链的行不产生空行（逐条粘贴进乐写不能有空行）');
  lines.forEach(l => {
    assert.equal(l.length, 42, '每行恰好 42 字符');
    assert.ok(l.startsWith('https://mes.newenergycoder.club/i/'), '每行都是完整短链 URL');
    assert.ok(!/["',]/.test(l), '无表头无引号无分隔符');
  });
  assert.equal(lines[0], LINK_001, '顺序与面板表格一致');
});

/* ---------- labelAttrs 人读区（§6.2、§6.7.1） ---------- */
test('labelAttrs(itm)：右栏第 4 条为「短码 XXXX」，非规范码显「—」', () => {
  const labelAttrs = new Function('window', 'TYPES', fnSrc('labelAttrs') + '; return labelAttrs;')({ ItemLink }, TYPES);
  const attrs = labelAttrs('itm', { code: 'WP-001', name: '齿轮', spec: 'S', loc: 'A-01' });
  assert.equal(attrs.length, 4, '右栏 4 行硬约束（名称/规格/库位/短码）');
  assert.deepEqual(attrs[3], ['短码', 'KW4QYSBD']);
  const legacy = labelAttrs('itm', { code: 'WP-a1b2c3d4', name: '旧件' });
  assert.deepEqual(legacy[3], ['短码', '—'], 'WP-随机串无短码显「—」，不得抛异常');
  const noIL = new Function('window', 'TYPES', fnSrc('labelAttrs') + '; return labelAttrs;')({}, TYPES);
  assert.deepEqual(noIL('itm', { code: 'WP-001', name: 'x' })[3], ['短码', '—'], 'ItemLink 缺失也不崩');
});
