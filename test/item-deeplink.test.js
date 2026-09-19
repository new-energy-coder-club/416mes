'use strict';
/* D2（§六待修①②）：#item/ 深链时序复检与 hash 保值的静态结构钉死。
 * 行为级验证在 test/item-browser.browser.cjs（真 Chromium + 真 IndexedDB 恢复时序）。
 * 这里锁结构：applyHash 必须登记待复检 + 补回 hash，boot 必须在 localStoreReady 后复检。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
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

test('D2-①：#item/ 深链登记 _pendingItemCheck 待复检（applyHash 早于 localStoreReady 的误报防线）', () => {
  const s = fnSrc('applyHash');
  const itemBranch = s.slice(s.indexOf("startsWith('item/')"));
  assert.match(itemBranch, /_pendingItemCheck = itemCode/, 'items 必须接入与 ledger/wip 同款的待复检登记');
  assert.match(HTML, /let _pendingItemCheck = null/, '待复检变量必须声明');
});

test('D2-①：boot 在 localStoreReady 之后复检 #item/ 深链', () => {
  const boot = HTML.slice(HTML.indexOf('(async function boot()'));
  const awaitIdx = boot.indexOf('await localStoreReady');
  const recheckIdx = boot.indexOf('_pendingItemCheck');
  assert.ok(awaitIdx >= 0 && recheckIdx > awaitIdx, '复检必须排在 await localStoreReady 之后');
  assert.match(boot, /_pendingItemCheck = null/, '复检后必须清掉待复检项，避免重复触发');
  assert.match(boot, /itemPage\.queryScan\('ITM:' \+ c\)/, '复检必须重新定位物品详情');
  /* 用户在数据就绪前改过查询框就不覆盖他的输入 */
  assert.match(boot, /si\.value === 'ITM:' \+ c \|\| si\.value === c/);
});

test('D2-②：#item/ 落地后 history.replaceState 补回 #item/WP-xxx（goTab 会改写成 #items）', () => {
  const s = fnSrc('applyHash');
  const itemBranch = s.slice(s.indexOf("startsWith('item/')"));
  assert.match(itemBranch, /history\.replaceState\(null, '', '#item\/' \+ encodeURIComponent\(itemCode\)\)/,
    '物品码必须留在 hash 里，刷新/分享后仍能定位');
  const goTabIdx = itemBranch.indexOf("goTab('items')");
  const restoreIdx = itemBranch.indexOf("history.replaceState(null, '', '#item/'");
  assert.ok(goTabIdx >= 0 && restoreIdx > goTabIdx, '补回 hash 必须在 goTab 改写之后');
});

test('D2-②：replaceState 不触发 hashchange，无递归（回归守卫：不得改成 location.hash 赋值）', () => {
  const s = fnSrc('applyHash');
  const itemBranch = s.slice(s.indexOf("startsWith('item/')"));
  assert.ok(!/location\.hash\s*=/.test(itemBranch), '直接赋 location.hash 会触发 hashchange → applyHash 递归');
});
