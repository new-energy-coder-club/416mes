'use strict';
/**
 * 内联脚本的「调用了但没定义」静态检查。
 *
 * 为什么需要：改 index.html 靠脚本做局部替换时，**脚本中途断言失败会导致一条都不写盘**，
 * 但人是看着"改完了"的。实际踩过两次：
 *   · 声称做了 IDB 导出，功能根本没进去（只在报告里）
 *   · 在轮询 catch 里加了 fsProbeFailed(...) 调用，而函数定义那半没写进去
 *     → 每次轮询失败都抛 ReferenceError，页面上完全看不出来
 * `node --check` 只查语法，查不出"引用了不存在的函数"。这条把该缺口补上。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

/**
 * 取 index.html 里的**应用主逻辑**内联脚本。
 * 不能按长度挑最长的 —— 页面里还内联了整份 xlsx 库（单行数百 KB），
 * 按长度会把库当成应用逻辑，检查结果全是第三方函数名（实测踩过：
 * 报出 saveAs / set_readable）。改用应用特有标记定位。
 */
function mainScript() {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const parts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const app = parts.filter(p => p.includes('const APP_VERSION') && p.includes('416MES 应用逻辑'));
  assert.equal(app.length, 1, '应恰好找到一段应用主逻辑内联脚本，实测 ' + app.length + ' 段');
  return app[0];
}

/** 本项目里"应该是本脚本自己定义"的前缀 */
const LOCAL_PREFIXES = ['fs', 'render', 'merge', 'inv', 'cloud', 'drop', 'auto', 'new', 'table', 'push', 'pending', 'data', 'queue', 'conflict', 'set', 'load', 'save', 'apply', 'reset'];
/** 明显来自浏览器/库的全局名，不在检查范围 */
const EXTERNAL = new Set(['fetch', 'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'requestIdleCallback', 'structuredClone', 'parseInt', 'parseFloat', 'isFinite', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'format', 'fill', 'filter', 'find', 'forEach', 'map',
  'concat', 'slice', 'splice', 'sort', 'test', 'match', 'replace', 'reduce', 'push', 'pop', 'shift',
  'some', 'every', 'includes', 'indexOf', 'join', 'split', 'trim', 'then', 'catch', 'finally',
  'select', 'setItem', 'getItem', 'stringify', 'parse', 'keys', 'values', 'entries', 'assign',
  'startsWith', 'endsWith', 'padStart', 'toFixed', 'toISOString', 'getTime', 'random', 'now',
  'signal', 'abort', 'has', 'add', 'delete', 'get', 'set', 'transaction', 'open', 'close',
  'showModal', 'focus', 'blur', 'click', 'remove', 'appendChild', 'insertBefore', 'querySelector',
  'querySelectorAll', 'getElementById', 'addEventListener', 'removeEventListener', 'preventDefault',
  'writeFile', 'book_new', 'book_append_sheet', 'aoa_to_sheet', 'sheet_to_json', 'read']);

test('index.html 内联脚本：不得调用未定义的本地函数（node --check 查不出这类）', () => {
  const src = mainScript();
  assert.ok(src && src.length > 10000, '没取到主内联脚本');

  // 收集定义：function 声明、const/let/var 赋值、以及参数里的解构
  const defined = new Set();
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
    m[1].split(',').forEach(p => { const n = p.split(':').pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n); });
  }

  // 收集调用：形如 name( 且不是 obj.name( 、不是 new name(
  const called = new Map();
  for (const m of src.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!LOCAL_PREFIXES.some(p => name.startsWith(p))) continue;
    if (EXTERNAL.has(name)) continue;
    if (defined.has(name)) continue;
    called.set(name, (called.get(name) || 0) + 1);
  }

  const missing = [...called.keys()];
  assert.deepEqual(missing, [],
    '这些本地函数被调用了但脚本里没有定义（局部替换脚本中途失败时的典型症状）：\n  ' + missing.join('\n  '));
});

test('index.html 内联脚本：不得调用未定义的大写工具函数（T/N/D/DT 等）', () => {
  const src = mainScript();
  const defined = new Set();
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  // mes-core.js / lib/*.js 暴露的全局
  ['CORE', 'OUTBOX', 'STORE', 'CHECKPOINT', 'INC', 'TWM', 'XLSX', 'MesCore'].forEach(n => defined.add(n));
  const suspicious = [];
  for (const m of src.matchAll(/(^|[^\w$.])([A-Z]{1,4})\s*\(/g)) {
    const n = m[2];
    if (['T', 'N', 'D', 'DT'].indexOf(n) < 0) continue;
    if (!defined.has(n)) suspicious.push(n);
  }
  assert.deepEqual([...new Set(suspicious)], [], '调用了未定义的短工具函数：' + suspicious.join(', '));
});

test('B4 账本修数：按钮、函数、纯逻辑三处必须齐全且接线正确', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const h = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/id="btnLedgerRepair"/.test(h), '缺少账本修数按钮');
  assert.ok(/async function fsLedgerRepair\(/.test(h), '缺少 fsLedgerRepair 实现');
  assert.ok(/getElementById\('btnLedgerRepair'\)\.addEventListener\('click'/.test(h), '按钮没接线');
  // 必须走纯函数算方案，而不是在 UI 里各算一遍
  assert.ok(/CORE\.ledgerRepairPlan\(state\)/.test(h), '必须用 CORE.ledgerRepairPlan 算方案');
  // 两道安全闸：闸门开启时拒绝、执行前要确认
  assert.ok(/if \(fsBulkHold\(\)\)/.test(h), '批量对账闸门开启时必须拒绝修数');
  assert.ok(/if \(!confirm\(lines\.join/.test(h), '执行前必须二次确认');
  // delta 绝不能被改（只能改 balance）
  assert.ok(/balance: bySeq\[t\.seq\]/.test(h) && !/delta: bySeq/.test(h), '只能改余量列，不能动 delta');
});
