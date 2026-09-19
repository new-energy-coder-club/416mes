/**
 * P5「可收场 + 导入一致」静态不变量检查
 *
 * 说明一处取舍：我试过在这里做「未声明标识符」的通用检查，但仓库里没有可用的 JS 解析器
 * （acorn/espree 都没装，也不该为了一个测试去加依赖），手写正则版会产出 70+ 条误报
 * （对象键、字符串内容、参数全都算进去）。所以改成**针对性**检查：只盯
 * 「sheet 局部变量」这一小组名字 —— 它们不是全局、也不可能是对象键，
 * 一旦被改名而漏改一处引用就会立刻报出来。这次真的踩到了（ppl → ppl0 漏了一处，
 * 语法检查查不出，只有运行时导入「人员」表才会 ReferenceError）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function region(startMarker, endMarker) {
  const a = HTML.indexOf(startMarker);
  const b = HTML.indexOf(endMarker, a);
  assert.ok(a >= 0, '找不到起点：' + startMarker);
  assert.ok(b > a, '找不到终点：' + endMarker);
  return { src: HTML.slice(a, b), at: a };
}

const IMPORT = region("document.getElementById('fileImport').addEventListener", "/* ---------- Excel 双向模板");
const IMP = IMPORT.src;

function declaredIn(src) {
  const set = new Set();
  for (const m of src.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  return set;
}

/* ================= P5-4 / P5-5：导入 ================= */

test('P5-4 每个 sheet 的业务键列都要在预检阶段校验，且校验发生在任何改动之前', () => {
  assert.ok(/const KEYCOLS = \[/.test(IMP), '缺少 KEYCOLS 业务键清单');
  const iKeys = IMP.indexOf('const KEYCOLS');
  const iSnap = IMP.indexOf('takeImportSnapshot()');
  /* G2：物料台账 sheet 已停用（跳过+警告），第一处改动落在库位表 */
  const iFirstMutate = IMP.indexOf('state.locations = dropNoKey');
  assert.ok(iFirstMutate > 0, '找不到第一处 state 改动标记（state.locations = dropNoKey）');
  assert.ok(iKeys < iSnap, '业务键校验必须在拍快照之前');
  assert.ok(iKeys < iFirstMutate, '业务键校验必须在第一次改动 state 之前（要「一个字都不改」地拒绝）');
  assert.ok(iSnap < iFirstMutate, '快照必须在第一次改动之前拍');
  // 拒绝时必须真的 return，不能继续往下走
  assert.ok(/keyProblems\.length\)[\s\S]{0,600}?return;/.test(IMP), '发现业务键问题后没有 return，会继续导入');
  // G2：物料台账不再参与业务键预检（整张跳过），其余八张表都要在清单里
  const kcBlock = IMP.slice(IMP.indexOf('const KEYCOLS'), IMP.indexOf('const keyColInfo'));
  assert.ok(!kcBlock.includes("['物料台账'"), 'KEYCOLS 仍含已停用的物料台账（KNOWN_SHEETS 保留它是为了给出「已停用」而不是「未知 sheet」提示）');
  for (const s of ['库位', '容器', '人员', '物品', '手册', '工单记录', 'NEC工单', '库存流水']) {
    assert.ok(IMP.includes("['" + s + "'"), 'KEYCOLS 缺 ' + s);
  }
});

test('G2 物料台账 sheet：跳过并明确警告，本机物料一个字都不改', () => {
  assert.ok(/sheet\('物料台账'\)/.test(IMP), '导入里找不到物料台账 sheet 的探测');
  assert.ok(/物料台账」Excel 模板已停用/.test(IMP), '缺少「物料台账已停用」的警告文案');
  assert.ok(/importWarnings\.push\('「物料台账」/.test(IMP), '停用警告没有进 importWarnings（用户会看不到）');
  assert.ok(!/state\.materials = dropNoKey/.test(IMP), '物料台账仍在被 Excel 整表替换');
  assert.ok(!/if \(!ms\) throw/.test(IMP), '缺物料台账 sheet 仍在抛错中止导入');
  // 警告必须随结果弹出，不能只收不示
  assert.ok(/if \(importWarnings\.length\) msg \+=/.test(IMP), 'importWarnings 没有并入结果提示');
});

test('P5-4 空业务键的行必须被丢弃并告警，且每张表都要过这道滤网', () => {
  const iDef = IMP.indexOf('const dropNoKey =');
  assert.ok(iDef > 0, '缺少 dropNoKey');
  const after = IMP.slice(iDef);
  for (const [label, needle] of [
    /* G2：物料台账已停用（跳过），不再过 dropNoKey —— 它在 KEYCOLS/滤网里都已被显式移除 */
    ['库位', "dropNoKey(bodyRows(ls, codeIdx('库位', '库位码')), r => lcol(r, '库位码', 0)"],
    ['容器', "dropNoKey(bodyRows(cs, codeIdx('容器', '容器码')), r => ccol(r, '容器码', 0)"],
    ['工单记录', "dropNoKey(bodyRows(ws, codeIdx('工单记录', '工单号')), r => wcol(r, '工单号', 0)"],
    ['人员', "dropNoKey(bodyRows(ppl0, codeIdx('人员', '编号')), r => pcol(r, '编号', 0)"],
    ['物品', "dropNoKey(bodyRows(is2, codeIdx('物品', '物品码')), r => icol(r, '物品码', 0)"],
    ['手册', "dropNoKey(bodyRows(ms2, codeIdx('手册', '手册码')), r => mcol(r, '手册码', 0)"],
    /* 2.49.5：NEC 导入表头优先「工单号」（导出/模板口径），旧手抄「编码」「编号」兜底 */
    ['NEC工单', "dropNoKey(bodyRows(ns, codeIdx('NEC工单', '工单号', '编码', '编号')), codeVal, '工单号', 'NEC工单：')"]
  ]) {
    assert.ok(after.includes(needle), label + ' 没有过 dropNoKey 滤网');
  }
});

test('P5-5 导入必须整体快照 + 失败回滚（整表替换不允许留半成品）', () => {
  assert.ok(/const IMPACT_KEYS = \[/.test(IMP), '缺少 IMPACT_KEYS');
  assert.ok(/const takeImportSnapshot = /.test(IMP), '缺少拍快照的函数');
  assert.ok(/const rollbackImport = /.test(IMP), '缺少回滚函数');
  // 回滚必须覆盖 transactions / txnSeq —— recordTransaction 会就地改它们
  assert.ok(/IMPACT_KEYS = \[[^\]]*'transactions'[^\]]*\]/.test(IMP.replace(/\n/g, ' ')), 'IMPACT_KEYS 没包含 transactions');
  assert.ok(/IMPACT_KEYS = \[[^\]]*'txnSeq'[^\]]*\]/.test(IMP.replace(/\n/g, ' ')), 'IMPACT_KEYS 没包含 txnSeq');
  // catch 里必须回滚并重新渲染（否则屏幕显示旧值、内存是新值，两边不一致）
  const iCatch = IMP.lastIndexOf('} catch (err) {');
  assert.ok(iCatch > 0, '找不到导入的 catch');
  const catchBody = IMP.slice(iCatch);
  assert.ok(/rollbackImport\(\)/.test(catchBody), '导入失败时没有回滚');
  assert.ok(/save\(\)/.test(catchBody) && /renderLedger\(\)/.test(catchBody), '回滚后没有落盘并重画');
});

test('P5-5 导入用到的 sheet 局部变量必须都已声明（改名的漏网引用会 ReferenceError）', () => {
  // 这一组名字只可能是本地的 sheet 变量：不是全局、也不可能是对象键
  const LOCALS = ['ms', 'ms2', 'msRows', 'ls', 'cs', 'ws', 'ns', 'ppl', 'ppl0', 'pplRows', 'is2', 'txs', 'hIdx', 'importSnapshot', 'importWarnings'];
  const declared = declaredIn(IMP);
  const bad = [];
  for (const name of LOCALS) {
    const used = new RegExp('(?<![.\\w$])' + name + '(?![\\w$])');
    if (used.test(IMP) && !declared.has(name)) bad.push(name);
  }
  assert.deepStrictEqual(bad, [], '这些变量被使用了但没有声明（很可能是改名后的漏网引用）：' + bad.join('、'));
});

/* ================= P5-6：默认值不能覆盖成 0 ================= */

test('P5-6 mergePackage 不能因为备份里没有 minQty 就把本机安全库存清零', () => {
  const a = HTML.indexOf('function mergePackage(');
  assert.ok(a > 0, '找不到 mergePackage');
  // 必须剥掉注释再查：解释这条反模式的注释里就有那段代码，不剥会误报
  //（第一版就误报了，测试自己踩的坑）
  const src = HTML.slice(a, a + 4000)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.ok(!/Object\.assign\(old,\s*\{\s*minQty:\s*0\s*\},\s*m\)/.test(src),
    'mergePackage 仍在用 Object.assign(old, {minQty:0}, m)：备份里没有该键时会把本机安全库存清零');
  assert.ok(/Object\.assign\(old, m\);\s*\n\s*if \(old\.minQty == null\) old\.minQty = 0;/.test(src),
    '应当是「先合并、再只在确实没有值时补默认值」');
});

/* ================= P5-1：离线队列能收场 ================= */

test('P5-1「待人工处理」的条目不能再被自动重试', () => {
  const flush = region('async function fsFlushQueueInner', 'async function fsBoot').src;
  assert.ok(/item\.status === 'needs_attention'\)\s*\{\s*held\+\+;\s*continue;/.test(flush),
    '冲刷没有跳过 needs_attention → 会无限重试一个已知不会成功的请求，还占着串行链');
  const push = region('async function fsPush(item)', '/* G3：fsPushStock').src;
  assert.ok(/needs_attention/.test(push), 'fsPush 里再次触发同一条目时没有检查它是否已判待人工');
});

test('P5-1 队列有人能收场的入口：角标可点、面板可重试/放弃，且 fsGiveUpItem 真被调用', () => {
  assert.ok(/fsOpenQueuePanel/.test(HTML), '缺少队列面板函数');
  assert.ok(/addEventListener\('click', \(\) => fsOpenQueuePanel\(\)\)/.test(HTML),
    '顶部角标没有点击接线（旧实现是个不可点击的 span）');
  assert.ok(/data-qretry/.test(HTML), '面板没有「重试」按钮');
  assert.ok(/data-qgiveup/.test(HTML), '面板没有「放弃并导出」按钮');
  // fsGiveUpItem 以前一个调用者都没有 —— 必须真的被面板调用
  const calls = (HTML.match(/fsGiveUpItem\(/g) || []).length;
  assert.ok(calls >= 2, 'fsGiveUpItem 除了定义之外必须至少有一个调用点，实际 ' + calls);
  assert.ok(/async function fsQueueRetry/.test(HTML), '缺少把条目恢复为待提交的函数');
  assert.ok(/id="queueBox"/.test(HTML), '缺少队列面板容器');
});

/* ================= P5-2：来历不明不变量 ================= */

test('P5-2「来历不明」必须被检测并报警，且不能在没基线时误报', () => {
  assert.ok(/async function fsAuditIdentity/.test(HTML), '缺少身份巡检函数');
  const src = region('async function fsAuditIdentity', 'function identityHtml').src;
  assert.ok(/__syncedKeys/.test(src), '身份判定必须基于 __syncedKeys（已确认）');
  assert.ok(/fsOutboxAsync/.test(src), '身份判定必须读离线队列（未决）');
  assert.ok(/skip: true/.test(src), '没有基线时必须跳过判定 —— 否则全新设备上每一条都会「来历不明」');
  assert.ok(/queueReadable/.test(src), '队列读不到时不能把「未决」误算成「来历不明」');
  assert.ok(/identityHtml/.test(HTML) && /renderAlignBox/.test(HTML), '身份结果没有接到「对齐」面板上');
  assert.ok(/来历不明/.test(HTML), '没有任何用户可见的报警文案');
});

test('P5-4 必需列（库存数量）的检查不能被「业务键命中」短路', () => {
  const src = region('const keyColInfo =', 'const keyProblems').src;
  // 必须先把 idx 找完、再统一查 required；不能在 for 循环里 return
  assert.ok(/let idx = -1;/.test(src), 'keyColInfo 没有先算出业务键下标');
  assert.ok(!/for \(const nm of names\) \{ const i = hdr\.indexOf\(nm\); if \(i >= 0\) return/.test(src),
    '找到业务键就立刻 return —— 必需列永远查不到（「库存数量被改名」这种文件会直接过关，把全场库存清零）');
  assert.ok(/const missingReq = \(required \|\| \[\]\)\.filter/.test(src), '缺少必需列检查');
  // 必需列检查必须在业务键判断之前生效
  assert.ok(src.indexOf('if (missingReq.length)') < src.indexOf('if (idx < 0) return { present: false'),
    '必需列检查必须在「业务键缺失」判断之前');
});

test('B8【关键】导入的快照/回滚声明必须在 try 之外，否则 catch 里够不着（回滚形同虚设）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const onload = src.indexOf('rd.onload = ev => {');
  assert.ok(onload > 0, '找不到 rd.onload 导入处理器');
  const win = src.slice(onload, onload + 4000);
  const iDecl = win.indexOf('const rollbackImport');
  const iTry = win.indexOf('try {');
  assert.ok(iDecl > 0, '找不到 const rollbackImport');
  assert.ok(iTry > 0, '找不到 try {');
  assert.ok(iDecl < iTry,
    'const rollbackImport 写在 try 块内 —— const 是块级作用域，catch 里的 rollbackImport() ' +
    '会抛 "rollbackImport is not defined"，回滚从来没生效过（实测故障注入抓到过）');
  assert.ok(win.indexOf('const takeImportSnapshot') < iTry, 'takeImportSnapshot 同样必须提到 try 之外');
  // catch 里确实调用了它（否则提出来也没意义）
  const iCatch = src.indexOf('rollbackImport(); save();', onload);
  assert.ok(iCatch > iTry, 'catch 里应当调用 rollbackImport()');
});
