'use strict';
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
    if (quote) { if (esc) esc=false; else if(ch==='\\') esc=true; else if(ch===quote) quote=''; continue; }
    if (ch==='"'||ch==="'"||ch==='`') { quote=ch; continue; }
    if(ch==='{') depth++; else if(ch==='}' && --depth===0) return HTML.slice(start,i+1);
  }
  throw new Error('函数未闭合 '+name);
}

test('阶段1：同步 UI 持久状态只能在 load() 后恢复，不能在 state=null 时读取', () => {
  assert.ok(!/let _lastReport\s*=\s*state\./.test(HTML), '脚本加载时 state 仍为 null，会中断整个应用启动');
  assert.ok(!/let _censusPending\s*=\s*CensusStatus\.pendingFromStatus\(state\./.test(HTML));
  const tail = HTML.slice(HTML.lastIndexOf('load();'));
  assert.match(tail, /load\(\);\s*restoreSyncUiState\(\)/);
});

test('阶段1：对账面板必须展示 localOnly / remoteOnly 具体键，不能只报数量', () => {
  const s = fnSrc('dataConsistencyHtml');
  assert.match(s, /localOnlyCount/);
  assert.match(s, /remoteOnlyCount/);
  assert.match(s, /仅本地/);
  assert.match(s, /仅飞书/);
});

test('阶段1：库存流水差异必须明确特殊语义，不显示普通推送/删除承诺', () => {
  const s = fnSrc('dataConsistencyHtml');
  assert.match(s, /k === 'transactions'/);
  assert.match(s, /只增审计账本/);
  assert.match(s, /不参与普通批量推送\/自动删除/);
});

test('阶段1：对账状态不能在每轮 fsRunCensus 开始时全局清空，必须按表合并持久化', () => {
  const s = fnSrc('fsRunCensus');
  assert.ok(!/_censusPending\s*=\s*\{\}/.test(s), '自动轮询一张表时全局清空 pending 会让其他表待人工项消失');
  assert.match(s, /mergeCensusTableStatus/);
  assert.match(s, /persistCensusUiState\(\)/);
});

test('阶段1：成功 reconcile 必须持久化报告，刷新后仍能看见记录级差异', () => {
  const s = fnSrc('runReconcile');
  assert.match(s, /state\.__lastReport/);
  assert.match(s, /save\(\)/);
});

test('阶段1：localOnly 必须逐键提供安全动作，transactions 无动作，remoteOnly 只读', () => {
  const s = fnSrc('dataConsistencyHtml');
  assert.match(s, /data-reconcile-push/);
  assert.match(s, /data-reconcile-del/);
  assert.match(s, /k === 'transactions'/);
  assert.match(s, /网页不提供删除飞书动作/);
});

test('阶段1：删除本地必须先写凭据、清理单键状态与 outbox，且不得调用飞书删除', () => {
  const s = fnSrc('deleteOneLocalRecord');
  assert.match(s, /await fsJournalDeletion/);
  assert.match(s, /removeRecord\(table, key\)/);
  assert.match(s, /__syncedKeys/);
  assert.match(s, /_censusPending/);
  assert.ok(!/fsPushDelete/.test(s));
});

test('阶段1：记录级推回/删除动作完成后必须重新核对', () => {
  const push = fnSrc('pushOneReconcileRecord');
  const del = fnSrc('deleteOneLocalRecord');
  assert.match(push, /await fsPushRecord/);
  assert.match(push, /await runReconcile\(\)/);
  assert.match(del, /persistCensusUiState\(\)/);
  const ui = fnSrc('renderAlignBox');
  const delPos = ui.indexOf("[data-reconcile-del]");
  assert.ok(delPos > 0 && /await runReconcile\(\)/.test(ui.slice(delPos)), '删除本地动作后必须重新核对');
});

/* ================= 阶段2：全站状态坞 ================= */

test('阶段2：四块全站面板与日志必须在 #statusDock 内，且 id 全部保留', () => {
  const dockStart = HTML.indexOf('id="statusDock"');
  const dockEnd = dockStart >= 0 ? HTML.indexOf('</details>', dockStart) : -1;
  assert.ok(dockStart > 0, '缺少全站状态坞 #statusDock');
  const dock = HTML.slice(dockStart, dockEnd);
  ['cloudGapBox', 'queueBox', 'conflictBox', 'healthBox', 'scanLogWrap', 'scanLog', 'scanLogLast']
    .forEach(id => assert.ok(dock.includes('id="' + id + '"'), '状态坞必须包含 #' + id + '（测试断言其存在）'));
  /* 老位置（#tab-ledger 内）不得再残留这些 id —— 留两份会导致 getElementById 命中错误那份 */
  const ledgerStart = HTML.indexOf('id="tab-ledger"');
  const ledgerEnd = HTML.indexOf('</section>', ledgerStart);
  const ledger = HTML.slice(ledgerStart, ledgerEnd);
  ['cloudGapBox', 'queueBox', 'conflictBox', 'healthBox'].forEach(id =>
    assert.ok(!ledger.includes('id="' + id + '"'), '#tab-ledger 不得再包含 #' + id));
  const scanSecStart = HTML.indexOf('id="tab-scan"');
  const scanSec = HTML.slice(scanSecStart, HTML.indexOf('</section>', scanSecStart));
  assert.ok(!scanSec.includes('id="scanLogWrap"'), '扫码页不得再包含 #scanLogWrap（日志已归状态坞）');
});

test('阶段2：顶栏角标必须在任何页签都能展开状态坞', () => {
  const s = fnSrc('fsOpenQueuePanel');
  assert.match(s, /statusDock/, 'fsOpenQueuePanel 必须展开 #statusDock，否则非台账页点击角标无效');
});

test('阶段2：状态坞摘要必须覆盖队列/冲突/待人工/不一致/重复，且异常自动展开', () => {
  const s = fnSrc('renderStatusDockSum');
  assert.match(s, /_conflicts\.length/);
  assert.match(s, /_censusPending/);
  assert.match(s, /localOnlyCount/);
  assert.match(s, /workorderDuplicateGroups/);
  assert.match(s, /dock\.open = true/, '出现异常时必须自动展开，不能等人自己去翻');
});

test('阶段2：切页签必须刷新状态坞摘要（任何页签都可见的前提）', () => {
  const nav = HTML.slice(HTML.indexOf("document.querySelectorAll('nav.tabs button')"), HTML.indexOf('/* ================= 排版工具'));
  assert.match(nav, /renderStatusDockSum\(\)/);
});
