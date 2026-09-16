/**
 * P3「数据身份与账本」静态不变量检查
 *
 * 这些逻辑全部内联在 index.html 里，没有模块边界可以 require；而本阶段每条都对应
 * 一个**曾经真实存在**的正确性缺口，所以逐条钉死。真正的行为验证在 mes-core /
 * feishu-api 的单元测试与浏览器端到端里，这里只防「改回去了」。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
/** 剥掉注释后的代码，避免把历史说明当成真实调用 */
const CODE = HTML.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function fnSrc(name) {
  const i = HTML.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '找不到 function ' + name);
  const j = HTML.indexOf('\n}', i);
  assert.ok(j > i, '找不到 function ' + name + ' 的结尾');
  return HTML.slice(i, j);
}

test('P3-1 每一条库存写入都要把本地 seq 交给服务端回写', () => {
  const push = fnSrc('fsPushStock');
  // 必须断言**真的取自 localTxn**：只断言 /localSeq:/ 会被 `localSeq: undefined` 骗过
  // （变异测试证实过这一点）。
  assert.ok(/localSeq: \(localTxn && localTxn\.seq != null\) \? localTxn\.seq : undefined/.test(push),
    'fsPushStock 没有把 localTxn.seq 真正传成 localSeq → 服务端分配的新流水号无处回写');

  // 4 个业务调用点（手工调整 / 冲销 / 盘点 / 工单执行）都必须把 txn 传进去
  const calls = (CODE.match(/fsPushStock\([^;\n]*?\.txn\)/g) || []);
  assert.equal(calls.length, 4, '应有 4 个调用点传 txn，实际 ' + calls.length + '：' + JSON.stringify(calls));
});

test('P3-1 fsExecItem 必须把服务端 seq 回写，并把新号记进基线', () => {
  const ex = fnSrc('fsExecItem');
  assert.ok(/CORE\.reconcileTxnSeq\(state, \{ localSeq: item\.localSeq, serverSeq: d\.seq/.test(ex),
    'fsExecItem 没有用服务端返回的 d.seq 调 reconcileTxnSeq');
  assert.ok(/__syncedKeys\.transactions/.test(ex), '回写后的新流水号没有记进 __syncedKeys → 会被当成「本地新建」');
  assert.ok(/d\.seq != null && item\.localSeq != null/.test(ex), '缺少「两个号都在才回写」的前置判断');
  // 回写本身失败不能拖垮写入
  assert.ok(/流水号回写失败（不影响本次写入）/.test(ex), '回写必须包在 try/catch 里，失败不能影响写入');
});

test('P3-2 全量拉取必须报告完整性，且不完整时不许抛错打断同步', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'lib', 'feishu-api.js'), 'utf8');
  assert.ok(/async function listRecordsEx/.test(api), '缺少 listRecordsEx（报告完整性的读表函数）');
  assert.ok(/complete: expected === null \? null : out\.length === expected/.test(api), 'listRecordsEx 没有比较收到数与 total');
  const ps = api.slice(api.indexOf('async function pullState'), api.indexOf('async function pullState') + 2200);
  assert.ok(/state\.completeness\[key\]/.test(ps), 'pullState 没有把完整性交出去');
  assert.ok(/listRecordsEx\(token, tableId\)/.test(ps), 'pullState 仍在用不带完整性信息的 listRecords');
  assert.ok(!/throw new Error\('全量拉取不完整/.test(ps),
    'pullState 不完整时不能抛错：分页期间有人新建一行就会让计数不符，抛错会把「少判几次删除」降级成「完全同步不了」');
});

test('P3-2 生产调用方必须显式关闭全量路径的删除权，并把待核删并进人工确认', () => {
  const fm = fnSrc('fsMerge');
  assert.ok(/allowDelete: false/.test(fm), 'fsMerge 没有显式关闭 allowDelete');
  assert.ok(/pendingDelete/.test(fm), 'fsMerge 没有处理 pendingDelete');
  assert.ok(/_censusPending\[tbl\]/.test(fm), 'pendingDelete 没有并进「待人工删除」列表（否则会静默丢）');
  assert.ok(/complete:/.test(fm), 'fsMerge 没有把完整性透给 mergeRemote');
});

test('P3-3 冲突池必须落在 conflicts store，不能借用 baselines', () => {
  assert.ok(/localStore\.put\('conflicts'/.test(CODE), '冲突池没有写进 conflicts store');
  const persist = fnSrc('fsPersistConflicts');
  assert.ok(!/baselines/.test(persist),
    '冲突池绝不能借用 baselines：persistStateToIdb 每次流水条数变化都会 replaceAll 掉它');
  assert.ok(/localStore\.del\('conflicts'/.test(persist), '空池子要把陈旧记录删掉');
  // 所有会改冲突池的入口都要落盘
  assert.ok(/fsPersistConflicts\(\)/.test(fnSrc('fsSetConflicts')), 'fsSetConflicts 没有落盘');
  assert.ok(/fsPersistConflicts\(\)/.test(fnSrc('fsUndoConflictApply')), '回滚后没有落盘（刷新会冒出个失效的回滚按钮）');
  // 启动时两条恢复分支都要捞回来
  const init = fnSrc('initLocalStore');
  assert.equal((init.match(/await fsLoadConflicts\(\)/g) || []).length, 2, 'initLocalStore 的两条分支都要恢复冲突池');
});

test('P3-3 删除必须留凭据，而且要能查能导出（不能又变成只写不读）', () => {
  assert.ok(/localStore\.put\('deletionJournal'/.test(CODE), '删除没有写 deletionJournal');
  assert.ok(/async function fsShowDeletionJournal/.test(HTML), '删除凭据没有读取入口（那和没存一样）');
  assert.ok(/btnDelJournal/.test(HTML), '删除凭据没有接到界面上');
  // 三条删除路径都要记
  for (const src of ['census-confirm', 'census-auto', 'local-wipe']) {
    assert.ok(new RegExp("'" + src + "'").test(HTML), '删除路径 ' + src + ' 没有写凭据');
  }
  assert.ok(/DELETION_JOURNAL_MAX/.test(HTML), '删除凭据没有上限 → 会无限增长');
  const j = fnSrc('fsJournalDeletion');
  assert.ok(/没有 IndexedDB/.test(j) || /localStore\) \{/.test(j), '没有 IDB 时要如实说明「本次删除没留凭据」');
});
