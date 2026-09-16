/**
 * P4「批量冲突主路径」静态不变量检查
 *
 * 内联在 index.html 里的接线无法直接 require，所以逐条钉死结构与顺序。
 * 每一条都对应一个**具体的失效方式**，不是泛泛的"存在性检查"。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CODE = HTML.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function fnSrc(name) {
  const i = HTML.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '找不到 function ' + name);
  const j = HTML.indexOf('\n}', i);
  assert.ok(j > i, '找不到 function ' + name + ' 的结尾');
  return HTML.slice(i, j);
}

test('P4-1 物料 upsert 绝不能带绝对 qty —— 入队前与提交前两道都要有', () => {
  // 剥除本体
  const strip = fnSrc('fsStripMaterialQty');
  assert.ok(/item\.op !== 'upsert' \|\| item\.table !== 'materials'/.test(strip), 'fsStripMaterialQty 没有限定物料 upsert');
  assert.ok(/delete c\.qty/.test(strip), '没有真的删掉 qty');
  assert.ok(/hasOwnProperty\.call\(r, 'qty'\)/.test(strip), '要只在真有 qty 时才算剥掉（否则计数虚高）');

  // 第一道：fsPush 里必须在 fsEnqueue **之前** —— 队列条目可能躺很久，里面的 qty 到冲刷时早过期了
  const p = fnSrc('fsPush');
  assert.ok(/fsStripMaterialQty\(item\)/.test(p), 'fsPush 没有调用剥除');
  assert.ok(p.indexOf('fsStripMaterialQty(item)') < p.indexOf('await fsEnqueue(item)'),
    '剥除必须发生在 fsEnqueue 之前（否则队列里会存下过期的绝对 qty）');

  // 第二道：fsExecItem 里必须有 —— 队列里的历史条目（以及从 localStorage 搬来的）
  // 根本没经过 fsPush，会绕过第一道直接 POST
  const ex = fnSrc('fsExecItem');
  assert.ok(/fsStripMaterialQty\(item\)/.test(ex),
    'fsExecItem 没有剥除 → 队列里的历史条目仍会把绝对 qty 写进飞书（审计发现的真实旁路）');
  assert.ok(ex.indexOf('fsStripMaterialQty(item)') < ex.indexOf("fsPost('/api/feishu/upsert'"),
    '提交前的剥除必须在 fsPost 之前');
});

test('P4-1 裁决要把 qty 的改动作为库存直写提交，而不是靠 upsert 落地', () => {
  const g = fnSrc('fsResolveGroup');
  assert.ok(/r\.stockWrites/.test(g), 'fsResolveGroup 没有处理 applyMerge 产出的 stockWrites');
  assert.ok(/fsPushStock\(w\.matCode/.test(g), 'stockWrites 必须走库存直写（不然账本里没有流水）');
  assert.ok(/needsStocktake/.test(g), '缺基线的情况必须提示走盘点，而不是硬猜');
  assert.ok(/strippedQty/.test(g), '被拦下的绝对 qty 要如实报出来');
});

test('P4-2 写入闸门必须在 fsPush 上，不能只拦队列冲刷', () => {
  const p = fnSrc('fsPush');
  const iHold = p.indexOf('if (fsBulkHold()) return;');
  const iEnqueue = p.indexOf('await fsEnqueue(item)');
  assert.ok(iHold > 0, 'fsPush 没有检查批量对账模式 —— 扫码/手工调整走的是直写，只拦 flush 等于没停');
  assert.ok(iHold > iEnqueue, '闸门必须在入队之后：条目得先落盘，否则进闸门就等于把操作丢在内存里');
  const f = fnSrc('fsFlushQueueInner');
  assert.ok(/if \(fsBulkHold\(\)\) return 0;/.test(f), '队列冲刷也要拦（否则两个入口只堵了一个）');
  // 真正会写飞书的两个入口都必须在 CODE 里出现闸门（允许出现 2 次以上）
  assert.ok((CODE.match(/fsBulkHold\(\)/g) || []).length >= 2, '闸门检查少于 2 处，说明有写入口漏了');
});

test('P4-2 闸门状态必须落在 state 里（刷新不能绕过）', () => {
  const e = fnSrc('fsEnterBulkHold');
  assert.ok(/state\.__bulkHold = \{/.test(e), '闸门状态没写进 state → 刷新一次就自动恢复了写入');
  assert.ok(/save\(\)/.test(e), '进入闸门后没有立即落盘');
  const x = fnSrc('fsExitBulkHold');
  assert.ok(/delete state\.__bulkHold/.test(x), '退出闸门没有清掉状态');
  assert.ok(/save\(\)/.test(x), '退出闸门后没有落盘');
});

test('P4-2 冲突量超阈值要自动进入闸门，且带防误触下限', () => {
  const s = fnSrc('fsSetConflicts');
  assert.ok(/fsEnterBulkHold\(/.test(s), '超阈值时没有自动进入批量对账模式');
  assert.ok(/BULK_HOLD_COUNT/.test(s) && /BULK_HOLD_RATIO/.test(s), '两个阈值都要用上');
  assert.ok(/BULK_HOLD_MIN/.test(s), '缺少比例阈值的最小条数下限（26 行的表里 3 条冲突不该把人锁住）');
});

test('P4-3 预览必须零写入，且用不抛错的 POST 拿到 problems 明细', () => {
  const p = fnSrc('fsPreviewGroup');
  assert.ok(/dryRun: true/.test(p), '预览没有走 dryRun');
  assert.ok(/fsPostRaw\(/.test(p), '预览必须用 fsPostRaw（fsPost 在 ok:false 时抛错，拿不到 problems 明细）');
  assert.ok(!/fsPushStock\(|fsPushRecord\(|fsPush\(/.test(p), '预览函数里出现了真实写入调用，必须为零网络写');
  assert.ok(/\/api\/feishu\/stock/.test(p) && /\/api\/feishu\/upsert/.test(p), 'qty 走 stock、其余走 upsert');
  assert.ok(/CAP = 20/.test(p), '缺少样例上限（5000 条逐条看是不可用）');
  // 必须用真跑一遍 applyMerge 来算本地结果，而不是另写一套推演逻辑
  assert.ok(/TWM\.applyMerge\(shadow/.test(p),
    '预览没有复用 applyMerge —— 另写一套推演逻辑会产生「预览和实际不一致」，比没有预览更坏');
});

test('P4-3/P4-2 面板要有预览按钮与恢复写入按钮', () => {
  assert.ok(/data-pv="/.test(HTML), '冲突面板没有预览按钮');
  assert.ok(/btnExitBulkHold/.test(HTML), '批量对账模式没有「恢复写入」入口 → 进了闸门出不来');
  assert.ok(/fsPreviewText/.test(HTML), '缺少预览的文字渲染');
  // 旧的「qty 绝对值会覆盖，确认吗」提示已经过时（现在是 delta + 账本），不该留着误导人
  assert.ok(!/用绝对值批量覆盖会丢掉本地并发期间的变动/.test(HTML),
    '还留着过时的「绝对值覆盖」确认框 —— 现在 qty 走 delta + 库存直写，那段提示已经不成立');
});

test('P4-1 闸门不能把「远端单方改动」的 qty 一起拦掉', () => {
  const t = require('../lib/three-way-merge.js');
  // planMerge 对「本地没动、远端改了」的写入必须打来源标记
  const p = t.planMerge({ materials: [{ code: 'M', qty: 5 }] }, { materials: [{ code: 'M', qty: 5 }] }, { materials: [{ code: 'M', qty: 9 }] });
  const w = p.writes.find(x => x.key === 'M' && x.kind === 'update');
  assert.ok(w, '本地没动、远端改了 → 应该有一条自动快进写入');
  assert.equal(w.from, 'remote-ff', '必须标记来源，否则会被 applyMerge 的 qty 闸门误拦');

  // 带标记的落地；不带标记的（人为构造，模拟绕过账本的写法）被剥掉
  const st1 = { materials: [{ code: 'M', qty: 5 }] };
  t.applyMerge(st1, { writes: [w], conflicts: [] }, {});
  assert.equal(st1.materials[0].qty, 9, '带来源标记的远端值必须能落地');

  const st2 = { materials: [{ code: 'M', qty: 5 }] };
  const r2 = t.applyMerge(st2, { writes: [{ table: 'materials', key: 'M', kind: 'update', fields: { qty: 99 } }], conflicts: [] }, {});
  assert.equal(st2.materials[0].qty, 5, '没有来源标记的「更新型 qty」必须被剥掉');
  assert.deepEqual(r2.strippedQty, [{ key: 'M', qty: 99 }]);
});

test('P4-2 闸门期间不许推送「待推送」列表（否则面板谎称已一致）', () => {
  const p = fnSrc('pushPending');
  assert.ok(/if \(fsBulkHold\(\)\)/.test(p), 'pushPending 没有闸门');
  // 关键：必须 **return 0**。autoPushPending 只在返回值非零时才把条目从
  // 「待推送」里摘掉；这里若假装推成功，面板就会显示已一致而飞书一条都没收到。
  assert.ok(/fsBulkHold\(\)\)[\s\S]{0,200}return 0;/.test(p),
    'pushPending 在闸门期间必须返回 0，否则 autoPushPending 会清空「待推送」列表');
});

test('B5【阶段二实测】已自行收敛的陈旧冲突必须被丢弃，不能让人裁决不存在的差异', () => {
  const p = fnSrc('fsPruneStaleConflicts');
  assert.ok(/TWM\._eq\(c\.local, c\.remote\)/.test(p), '要丢掉「快照里两边本来就一样」的');
  assert.ok(/TWM\._eq\(rec\[c\.field\], c\.remote\)/.test(p),
    '要丢掉「当前本地值已经等于飞书值」的（写入在飞时记下的临时冲突）');
  assert.ok(/丢弃 \d+ 条|丢弃 ' \+ dropped\.length/.test(p), '丢弃要有日志说明，不能静默');
  const set = fnSrc('fsSetConflicts');
  assert.ok(/fsPruneStaleConflicts\(list/.test(set), 'fsSetConflicts 必须走这道过滤');
});
