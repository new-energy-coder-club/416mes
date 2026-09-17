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

test('阶段2：四块全站面板与日志必须在独立的「同步与状态」页，且 id 全部保留', () => {
  assert.match(HTML, /data-tab="sync"/, '同步与状态必须是与其它页签同级的独立页');
  const secStart = HTML.indexOf('id="tab-sync"');
  assert.ok(secStart > 0, '缺少 #tab-sync section');
  const sec = HTML.slice(secStart, HTML.indexOf('</section>', secStart));
  ['cloudGapBox', 'queueBox', 'conflictBox', 'healthBox', 'scanLogWrap', 'scanLog', 'scanLogLast']
    .forEach(id => assert.ok(sec.includes('id="' + id + '"'), '#tab-sync 必须包含 #' + id + '（测试断言其存在）'));
  /* 不得再有「每页底部都挂一条」的折叠坞：那是第一版的做法，用户反馈更吵 */
  assert.ok(!HTML.includes('id="statusDock"'), '不得再用每页底部的状态坞');
  /* 老位置（台账页 / 扫码页）不得残留这些 id —— 留两份会导致 getElementById 命中错误那份 */
  const ledgerStart = HTML.indexOf('id="tab-ledger"');
  const ledger = HTML.slice(ledgerStart, HTML.indexOf('</section>', ledgerStart));
  ['cloudGapBox', 'queueBox', 'conflictBox', 'healthBox'].forEach(id =>
    assert.ok(!ledger.includes('id="' + id + '"'), '#tab-ledger 不得再包含 #' + id));
  const scanStart = HTML.indexOf('id="tab-scan"');
  const scan = HTML.slice(scanStart, HTML.indexOf('</section>', scanStart));
  assert.ok(!scan.includes('id="scanLogWrap"'), '扫码页不得再包含 #scanLogWrap（日志已归同步页）');
});

test('阶段2：顶栏角标必须从任何页签都切到同步页再展开队列', () => {
  const s = fnSrc('fsOpenQueuePanel');
  assert.match(s, /goTab\('sync'\)/, '不切页签的话 queueBox 在隐藏 section 里，点了什么也看不到');
});

test('阶段2：状态条必须有全站同步入口，异常时变红并可直达', () => {
  assert.match(HTML, /id="sbDock"/, '状态条缺少「同步与状态」入口');
  const s = fnSrc('renderStatusDockSum');
  assert.match(s, /_conflicts\.length/);
  assert.match(s, /_censusPending/);
  assert.match(s, /localOnlyCount/);
  assert.match(s, /workorderDuplicateGroups/);
  assert.match(s, /sb-link--alert/, '异常必须在状态条上变红，否则用户不知道要去同步页');
  const wire = HTML.slice(HTML.indexOf("const entry = document.getElementById('sbDock')"), HTML.indexOf("const sr = document.getElementById('btnSyncRefresh')"));
  assert.match(wire, /goTab\('sync'\)/, '入口必须可点击直达同步页');
});

test('阶段2：进入同步页必须刷新四块面板（否则看到上次的旧内容）', () => {
  const s = fnSrc('renderSyncTab');
  assert.match(s, /renderAlignBox/);
  assert.match(s, /renderConflictPanel/);
  assert.match(s, /renderHealthPanel/);
  assert.match(s, /renderScanLog/);
  const nav = HTML.slice(HTML.indexOf("document.querySelectorAll('nav.tabs button')"), HTML.indexOf('/* ================= 排版工具'));
  assert.match(nav, /b\.dataset\.tab === 'sync'/);
});

test('阶段2：对账明细不得塞进限宽表格（长业务键会被裁掉）', () => {
  const s = fnSrc('dataConsistencyHtml');
  assert.ok(!/reconcile-detail"><td colspan/.test(s), '明细放进 max-width:520px 的表格里会把长键裁成残缺键，没法核对也没法复制');
  assert.match(s, /reconcile-table-detail/, '明细必须在表格下方整宽展开');
  const css = HTML.slice(0, HTML.indexOf('</style>'));
  assert.match(css, /\.reconcile-key-row>code\{[^}]*overflow-wrap:anywhere/, '长键必须允许换行');
});

test('阶段2：切页签必须刷新状态入口（异常在任何页都可见的前提）', () => {
  const nav = HTML.slice(HTML.indexOf("document.querySelectorAll('nav.tabs button')"), HTML.indexOf('/* ================= 排版工具'));
  assert.match(nav, /renderStatusDockSum\(\)/);
});

/* ================= 阶段3：库存流水独立页 ================= */

test('阶段3：库存流水必须有独立页签，且不得再寄生在物料台账页', () => {
  assert.match(HTML, /data-tab="txn"/, '缺少 txn 页签');
  assert.match(HTML, /id="tab-txn"/, '缺少 #tab-txn section');
  const ledgerStart = HTML.indexOf('id="tab-ledger"');
  const ledger = HTML.slice(ledgerStart, HTML.indexOf('</section>', ledgerStart));
  assert.ok(!ledger.includes('id="txnTable"'), 'txnTable 不得再留在台账页');
  /* 独立页必须保留三个工具与表格 id（有测试/深链依赖） */
  const txnSec = HTML.slice(HTML.indexOf('id="tab-txn"'), HTML.indexOf('</section>', HTML.indexOf('id="tab-txn"')));
  ['txnTable', 'txnSummary', 'btnAuditReplay', 'btnLedgerRepair', 'btnAuditExport'].forEach(id =>
    assert.ok(txnSec.includes('id="' + id + '"'), '#tab-txn 必须包含 #' + id));
});

test('阶段3：流水渲染不得再用 slice(0,50) 截断，必须有筛选与加载更多', () => {
  const s = fnSrc('renderTxns');
  assert.ok(!/slice\(0,\s*50\)/.test(s), '硬编码 50 条截断让第 51 条起网页端不可达');
  assert.match(s, /TXN_PAGE_SIZE/);
  assert.match(s, /加载更多|还有/, '必须提示还有多少条未显示');
  const f = fnSrc('txnFiltered');
  assert.match(f, /txnSearch/, '必须有关键词筛选');
  assert.match(f, /txnDateFrom/, '必须有日期范围筛选');
});

test('阶段3：旧深链 #ledger?view=transactions 必须自动跳转到 txn 页', () => {
  const s = fnSrc('applyHash');
  assert.match(s, /view.*transactions/s);
  assert.match(s, /history\.replaceState\(null, '', '#txn'\)/, '旧深链静默失效等于功能消失');
  assert.match(s, /parts\[0\] === 'txn'/, 'txn 页必须支持自己的深链筛选');
});

test('阶段3：切到 txn 页签必须重置分页并渲染，状态条必须有流水计数', () => {
  const nav = HTML.slice(HTML.indexOf("document.querySelectorAll('nav.tabs button')"), HTML.indexOf('/* ================= 排版工具'));
  assert.match(nav, /b\.dataset\.tab === 'txn'/);
  const bar = fnSrc('renderStatusBar');
  assert.match(bar, /txn:/);
});

/* ================= 流水序号高水位污染的收场 ================= */

test('孤悬大号流水：检测必须认出「连续段之后的大跳跃」', () => {
  const src = fnSrc('txnSeqPoison');
  const fn = new Function('state', 'const GAP_TOLERANCE = 1000;' + src + '; return txnSeqPoison(state);');
  const mk = (seqs, hi) => ({ transactions: seqs.map(s => ({ seq: s })), txnSeq: hi });
  /* 正常：连续号码 */
  assert.strictEqual(fn(mk([1, 2, 3], 4)).poisoned, false);
  /* 正常：小跳跃（并发预留 / 失败回滚） */
  assert.strictEqual(fn(mk([1, 2, 3, 12], 13)).poisoned, false);
  /* 真实事故形态：哨兵流水 seq=900001 还留在本地，最大 seq == 高水位，
     旧的「高水位 - 最大 seq」检测在这里差值为 0，会漏报。 */
  const bad = fn(mk([1, 2, 24, 900001], 900002));
  assert.strictEqual(bad.poisoned, true, '残留流水还在本地时也必须认出来');
  assert.strictEqual(bad.contiguousMax, 24);
  assert.strictEqual(bad.outliers.length, 1);
  assert.strictEqual(Number(bad.outliers[0].seq), 900001);
  assert.strictEqual(bad.jump, 900001 - 24 - 1);
  /* 多条孤悬 */
  assert.strictEqual(fn(mk([1, 2, 900001, 900002], 900003)).outliers.length, 2);
  /* 空流水不得误报 */
  assert.strictEqual(fn({ transactions: [], txnSeq: 1 }).poisoned, false);
});

test('清理孤悬流水必须先写凭据、只删仅本地的、并回落高水位', () => {
  const s = fnSrc('fixTxnSeqHighWater');
  assert.match(s, /fsJournalDeletion/, '删流水必须留痕');
  const jIdx = s.indexOf('fsJournalDeletion');
  const delIdx = s.indexOf('state.transactions = state.transactions.filter');
  assert.ok(jIdx > 0 && delIdx > jIdx, '凭据必须写在删除之前（写失败要能零变更放弃）');
  /* 必须是 !j || !j.ok：fsJournalDeletion 返回 {ok,count,error} 而**不抛异常**，
     只写 `j.ok === false` 或 try/catch 都会漏掉「返回 undefined / 没有 ok 字段」的情况。 */
  assert.match(s, /if \(!j \|\| !j\.ok\)/, '凭据写入失败必须放弃（且要覆盖返回 undefined 的情况）');
  /* 断言必须盯住**过滤那一行**：只搜 'localOnly' 会命中上一行的声明，
     把过滤删掉也照样通过（实测过，是个假绿）。 */
  assert.match(s, /removable = p\.outliers\.filter\([^)]*localOnly\.has/,
    '只允许删「对账认定仅本地」的，飞书里存在的可能是真实数据');
  assert.match(s, /if \(!removable\.length\)/, '没有可删的必须明确拒绝而不是静默通过');
  assert.match(s, /removeRecord\('transactions'/, '必须从 outbox 摘除，否则又被推回去');
  /* 同理：高水位赋值必须真的在这个函数体里出现且只有一处 */
  const hwLines = s.split('\n').filter(l => /state\.txnSeq\s*=/.test(l));
  assert.strictEqual(hwLines.length, 1, '高水位赋值必须有且只有一处');
  assert.match(hwLines[0], /p\.contiguousMax \+ 1/, '必须回落到连续段末尾 + 1');
  assert.ok(!/fsPushDelete/.test(s), '绝不允许删飞书的流水');
  assert.match(s, /confirm\(/, '必须二次确认');
});

test('线上核查脚本不得用「安全大数」当流水哨兵 seq（会永久污染高水位）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'feishu-crud-check.mjs'), 'utf8');
  /* 断言必须盯住**赋值那一行**：只搜 'realMaxSeq + 1' 会命中注释/日志文本，
     把 seq 改回 900001 也照样通过（实测过，是个假绿）。 */
  const assign = src.split('\n').filter(l => /CASES\.transactions\.create\.seq\s*=/.test(l));
  assert.strictEqual(assign.length, 1, '哨兵 seq 必须有且只有一处赋值');
  assert.match(assign[0], /realMaxSeq \+ 1/, '哨兵 seq 必须紧贴真实最大 seq，不能是常量大数');
  assert.ok(!/\d{4,}/.test(assign[0]), '赋值里不得出现四位以上常量（安全大数会永久污染高水位）');
  assert.ok(!/create:\s*\{\s*seq:\s*\d{4,}/.test(src), 'CASES 里也不得写死大 seq');
});

/* ================= 删除凭据失败必须真的做到「零变更」 ================= */

test('fsJournalDeletion 必须如实报告失败（不能吞掉异常只 return 0）', () => {
  const s = fnSrc('fsJournalDeletion');
  assert.match(s, /return \{ ok: false, count: 0, error: e\.message \}/,
    '旧实现把异常吞掉并 return 0，调用方的 ok 判断/try-catch 全都永远不触发，「写失败零变更」是假的');
  assert.match(s, /return \{ ok: true, count: list\.length \}/);
  assert.ok(!/\n\s+return 0;/.test(s), '不得再有裸 return 0');
});

test('所有承诺「写失败零变更」的调用点都必须检查返回值', () => {
  const cases = [
    ['deleteOneLocalRecord', /const jr = await fsJournalDeletion\([\s\S]*?if \(!jr \|\| !jr\.ok\) return \{ ok: false/],
    ['resDelete', /if \(!j \|\| !j\.ok\) \{ alert/],
    ['fixTxnSeqHighWater', /if \(!j \|\| !j\.ok\) \{ alert/]
  ];
  for (const [fn, re] of cases) {
    assert.match(fnSrc(fn), re, fn + ' 必须在凭据写失败时放弃操作');
  }
});

test('人工确认删除的日志不得无条件声称「已写入删除凭据」', () => {
  const html = HTML;
  assert.ok(!/已写入删除凭据'\)/.test(html) || /jc && jc\.ok/.test(html),
    '凭据写失败时日志仍说「已写入删除凭据」= 对用户撒谎');
});

/* ================= 阶段4：资源档案页 ================= */

test('阶段4：必须有独立的资源档案页，四段齐全，且 gen 已并入', () => {
  assert.match(HTML, /data-tab="res"/, '缺少 res 页签');
  assert.match(HTML, /id="tab-res"/, '缺少 #tab-res');
  assert.ok(!HTML.includes('id="tab-gen"'), 'gen 页必须并入资源档案，避免同一对象两个入口');
  const sec = HTML.slice(HTML.indexOf('id="tab-res"'), HTML.indexOf('</section>', HTML.indexOf('id="tab-res"')));
  ['locations', 'containers', 'items', 'manuals'].forEach(t =>
    assert.ok(sec.includes('data-restype="' + t + '"'), '资源档案缺少 ' + t + ' 段'));
  ['resTable', 'resSearch', 'btnResAdd', 'resEditorBox', 'resSummary', 'resTypeBar', 'resSyncHint']
    .forEach(id => assert.ok(sec.includes('id="' + id + '"'), '#tab-res 必须包含 #' + id));
});

test('阶段4：四张表都必须有编辑能力（原来只有「生成」没有「维护」）', () => {
  const cfg = HTML.slice(HTML.indexOf('const RES_TYPES = {'), HTML.indexOf('let resType ='));
  /* 容器：类型/规格/当前库位码；库位：类型/说明；物品：名称/规格/库位；手册：名称/版本/库位 */
  const need = {
    locations: ['kind', 'desc'],
    containers: ['type', 'spec', 'loc'],
    items: ['name', 'spec', 'loc'],
    manuals: ['name', 'ver', 'loc']
  };
  for (const [t, fields] of Object.entries(need)) {
    const i = cfg.indexOf(t + ': {');
    assert.ok(i > 0, '缺少 ' + t + ' 配置');
    const block = cfg.slice(i, cfg.indexOf('\n  },', i));
    fields.forEach(f => assert.ok(block.includes("k: '" + f + "'"), t + ' 必须可编辑 ' + f));
  }
  assert.match(fnSrc('renderRes'), /data-res-edit/, '列表必须有编辑入口');
  assert.match(fnSrc('renderRes'), /data-res-del/, '列表必须有删除入口');
  assert.match(fnSrc('renderRes'), /data-res-detail/, '列表必须有详情入口');
  assert.match(fnSrc('renderRes'), /data-res-print/, '列表必须有打印跳转');
});

test('阶段4：删除必须先写凭据、必须显示影响范围与同步状态、绝不静默删', () => {
  const s = fnSrc('resDelete');
  const jIdx = s.indexOf('fsJournalDeletion');
  const delIdx = s.indexOf('state[table] = (state[table] || []).filter');
  assert.ok(jIdx > 0 && delIdx > jIdx, '凭据必须写在删除之前');
  assert.match(s, /resImpact\(/, '必须显示影响范围');
  assert.match(s, /resSyncState\(/, '必须显示同步状态');
  assert.match(s, /confirm\(/, '必须二次确认');
  assert.match(s, /if \(!j \|\| !j\.ok\)/, '凭据写失败必须放弃');
  /* 删除后本地痕迹要清干净，否则残留的「已确认」名单会让对账反复报警 */
  assert.match(s, /__syncedKeys\[table\] = \(state\.__syncedKeys\[table\] \|\| \[\]\)\.filter/, '__syncedKeys 是数组，必须过滤');
  assert.match(s, /removeRecord\(table, key\)/, '必须从 outbox 摘除');
});

test('阶段4：编辑必须「先写本地再造同步链」，且不得 await 网络', () => {
  const s = fnSrc('resSave');
  const saveIdx = s.indexOf('save();');
  const pushIdx = s.search(/fsPushRecord\(table, \[pushed\]/);
  assert.ok(saveIdx > 0 && pushIdx > saveIdx, '本地保存必须在推送之前');
  assert.ok(!/await fsPushRecord/.test(s),
    'await 推送会让编辑器卡在网络往返上（离线时更久），用户看到「点了保存没反应」；' +
    '本地已存好，推送必须 fire-and-forget');
  assert.ok(s.indexOf('resEditing = null') < pushIdx, 'UI 收尾必须早于推送');
});

test('阶段4：__syncedKeys / _pendingPush 是数组，不得当 Set 用', () => {
  /* 真实踩过：写成 .has()/.delete() 会静默失效（数组没有这些方法），
     记录永远留在「已确认」名单里，对账反复报警。 */
  const s = fnSrc('resSyncState');
  assert.ok(!/\.has\(/.test(s), '__syncedKeys/_pendingPush 是数组，用 .has() 永远判不出来');
  assert.match(s, /\.map\(String\)\.includes\(key\)/);
  assert.ok(!/__syncedKeys\[[^\]]+\]\.delete/.test(HTML), '数组没有 .delete，写了就是死代码');
});

test('阶段4：旧深链 #gen 必须跳到资源档案', () => {
  const s = fnSrc('applyHash');
  assert.match(s, /parts\[0\] === 'gen'/, 'home.html 的建档入口仍指向 #gen，不兼容就静默失效');
  assert.match(s, /parts = \['res'\]/);
});

/* ================= 编号生成绝不允许撞已有业务键 ================= */

test('nextCode 必须支持含数字的前缀（A4SH / SC4 / K401）', () => {
  const fn = new Function('pad', fnSrc('nextCode') + '; return nextCode;')(
    (n, w) => String(n).padStart(w, '0'));
  /* 旧正则 ^([A-Z]+)-(\d+)$ 遇到 A4SH 里的 '4' 匹配失败 → 永远返回 -001，
     而 -001 已经存在 → 新增会覆盖飞书里的真实记录。 */
  assert.strictEqual(fn([{ code: 'A4SH-001' }, { code: 'A4SH-002' }], 'A4SH'), 'A4SH-003');
  assert.strictEqual(fn([{ code: 'SC4-001' }], 'SC4'), 'SC4-002');
  assert.strictEqual(fn([{ code: 'B-01-01-01' }], 'B'), 'B-001', '带分隔的多段码不应被当成同前缀流水');
  assert.strictEqual(fn([{ code: 'WP-005' }], 'WP'), 'WP-006');
  assert.strictEqual(fn([], 'SC'), 'SC-001');
  /* 不同前缀互不干扰 */
  assert.strictEqual(fn([{ code: 'SLG-009' }, { code: 'XK-003' }], 'XK'), 'XK-004');
});

test('资源档案新增必须兜底防止落到已存在的业务键上（绝不覆盖真实记录）', () => {
  const s = fnSrc('resSave');
  /* 断言要盯住整个 if 条件 —— 只搜 some(...) 的话，把条件改成 if (false) 也照样通过（实测过）。 */
  assert.match(s, /if \(\(state\[table\] \|\| \[\]\)\.some\(x => String\(x\[cfg\.key\]\) === code\)\)/,
    '必须显式检查生成的码是否已存在；飞书按业务键 upsert，撞键等于覆盖真实记录');
  assert.match(s, /do \{ code = pre \+ '-' \+ pad\(\+\+n, 3\); \} while/,
    '撞键必须换号重试，而不是照推');
});
