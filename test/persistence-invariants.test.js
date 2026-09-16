/**
 * P2「持久化可信」的静态不变量检查
 *
 * 为什么用静态检查：这些逻辑全部内联在 index.html 的 4000 行脚本里，没有模块边界
 * 可以 require。而本阶段的每一条都是**曾被违反过**的具体缺陷，逐条钉死即可；
 * 真正的端到端验证（IndexedDB 落后于 localStorage 时谁赢）在浏览器里做，
 * 不在这里假装跑通。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** 取某个 function 名之后的整段源码（到下一个顶层 `function ` 或 `\n}` 为止，粗略但够用） */
function fnSrc(name) {
  const i = HTML.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '找不到 function ' + name);
  const j = HTML.indexOf('\n}', i);
  assert.ok(j > i, '找不到 function ' + name + ' 的结尾');
  return HTML.slice(i, j);
}

test('save()：localStorage 写失败不能再被吞掉', () => {
  const saveSrc = fnSrc('save');
  assert.ok(!/catch \(e\) \{ \}/.test(saveSrc), 'save() 里仍有 `catch (e) { }` —— 配额错误会被静默吞掉');
  assert.ok(/onLocalStorageFailure\(e\)/.test(saveSrc), 'save() 没有把 LS 写失败交给 onLocalStorageFailure');
  assert.ok(/function onLocalStorageFailure/.test(HTML), '缺少 onLocalStorageFailure');
  assert.ok(/QuotaExceededError/.test(HTML), '没有识别配额错误');
  assert.ok(/showPersistentNotice/.test(HTML), '没有用户可见的告警横幅');
});

test('修订号与「IDB 落后」标记：两边都要维护', () => {
  const w = fnSrc('writeStateToLs');
  assert.ok(/__rev = \(Number\(state\.__rev\) \|\| 0\) \+ 1/.test(w), 'writeStateToLs 没有推进 __rev');
  assert.ok(/LS_DIRTY_KEY/.test(w), 'writeStateToLs 没有维护「IDB 落后」标记');
  const s = fnSrc('save');
  assert.ok(/if \(willFlushToIdb\) _idbPending = true;/.test(s),
    '_idbPending 必须在写 LS **之前**置上，否则标记落不进 LS');
  // 顺序断言：_idbPending 赋值要在 writeStateToLs() 调用之前
  assert.ok(s.indexOf('_idbPending = true') < s.indexOf('writeStateToLs()'),
    '顺序错了：先写 LS 再置 _idbPending，标记就写不进 LS');
  const p = fnSrc('persistStateToIdb');
  assert.ok(/myRev/.test(p), 'persistStateToIdb 没有记录本次落盘的修订号');
  assert.ok(/removeItem\(LS_DIRTY_KEY\)/.test(p), 'IDB 落盘成功后没有清掉「IDB 落后」标记');
});

test('启动时必须在 LS 与 IDB 之间判新，且走同一套迁移', () => {
  const i = fnSrc('initLocalStore');
  assert.ok(/LS_DIRTY_KEY/.test(i), 'initLocalStore 没有读「IDB 落后」标记 → 会无条件用 IDB 覆盖 LS');
  // 必须断言**真的拿它做了分支**：只断言 /idbBehind/ 出现过是不够的 ——
  // 变异测试证明过这一点（把条件改成 `if (idbState)` 仍然能骗过弱断言）。
  assert.ok(/if \(idbState && !idbBehind\)/.test(i), 'IDB 命中分支没有真的检查 idbBehind');
  assert.ok(/if \(idbState && idbBehind\)/.test(i), '缺少「IDB 落后 → 以 LS 为准」的分支');
  assert.ok(/migrateState\(state\)/.test(i), 'IDB 路径没有调 migrateState（旧实现调的是残缺的 hydrateState）');
  // 只允许在注释里提到它（历史说明），不允许真调用：先剥掉注释再找
  const code = HTML.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.ok(!/hydrateState\s*\(/.test(code), '仍有代码调用已删除的 hydrateState');
  assert.ok(/idbState\.__base/.test(i), '以 LS 为准时没有继承 IDB 里的 __base → 三方合并会退回无基线');
  assert.ok(/Math\.max\(Number\(idbState\.__rev\)/.test(i), '__rev 在切换后没有保持单调');
});

test('关页/切后台要同步落盘（IDB 异步来不及）', () => {
  assert.ok(/addEventListener\('pagehide'/.test(HTML), '缺少 pagehide 落盘');
  assert.ok(/visibilitychange/.test(HTML) && /flushStateOnHide/.test(HTML), '缺少 visibilitychange 落盘');
});

test('log()：去抖 save + 封顶，且不再是每行一次全量落盘', () => {
  const l = fnSrc('log');
  assert.ok(!/unshift\(line\); save\(\)/.test(l), 'log() 仍然每写一行就同步 save()');
  assert.ok(/_logTimer/.test(l), 'log() 没有去抖');
  assert.ok(/SCAN_LOG_MAX/.test(l), 'log() 没有封顶 → 长期使用会顶到 5MB 墙');
  assert.ok(/SCAN_LOG_MAX = 500/.test(HTML), 'SCAN_LOG_MAX 常量缺失');
  assert.ok(/renderScanLog/.test(HTML), '缺少 renderScanLog');
});

test('入队绝不抛：三级降级都要在', () => {
  const e = fnSrc('fsEnqueue');
  assert.ok(/WRITE_FAIL_KEY/.test(e), 'fsEnqueue 缺少最后的失败日记（连 LS 都写不进时的兜底）');
  assert.ok(/fsOutbox\(\)\.append\(item\)/.test(e), 'fsEnqueue 缺少 localStorage 降级');
  // 关键结构断言：函数体里不该有裸露的 `await ob.append(item)` 直接暴露在函数顶层
  const body = e.slice(e.indexOf('async function'));
  assert.ok(!/\n  await ob\.append\(item\);\n/.test(body), 'fsEnqueue 顶层仍有未保护的 await ob.append');
});

test('fsPush 不把异常抛给 fire-and-forget 的调用方', () => {
  const p = fnSrc('fsPush');
  assert.ok(/await fsSerialize/.test(p), 'fsPush 不再调 fsSerialize？');
  const iSerialize = p.indexOf('await fsSerialize');
  const iCatch = p.indexOf('同步调度异常');
  assert.ok(iCatch > iSerialize, 'fsPush 没有为 fsSerialize 的调度异常兜底');
  assert.ok(/同步调度异常/.test(p), '缺少调度异常的处理');
});

test('离线队列迁移后要删 LS 源，否则每次启动重复推送', () => {
  const m = fnSrc('migrateOutboxToIdb');
  assert.ok(/fsOutbox\(\)\.removeById\(item\.id\)/.test(m), '迁移后没删 LS 源 → 队列一空就会重搬再推一遍');
  assert.ok(/fsDrainLegacyOutboxToIdb/.test(HTML), '缺少冲刷前搬运 LS 残留的函数');
  const f = fnSrc('fsFlushQueueInner');
  assert.ok(/fsDrainLegacyOutboxToIdb\(\)/.test(f), '冲刷前没有搬 LS 残留 → 那些条目永远不会被重试');
});

test('推送成功要把业务键记进 __syncedKeys；删除成功要摘掉', () => {
  assert.ok(/state\.__syncedKeys\[item\.table\] = \[\.\.\.seen\]/.test(HTML), 'upsert 成功后没有更新 __syncedKeys');
  assert.ok(/filter\(k => !gone\.has\(String\(k\)\)\)/.test(HTML), 'delete 成功后没有从 __syncedKeys 摘掉');
});

test('手工改库存：必须先本地算账落盘，再 await 网络', () => {
  const i = HTML.indexOf("const r = CORE.applyManualAdjust(state, m.code, v, { reason: reason || '（未填）' });");
  assert.ok(i > 0, '找不到手工改数量的处理块');
  const pushIdx = HTML.indexOf("await fsPushRecord('materials', [m]);", i);
  assert.ok(pushIdx > i, 'applyManualAdjust 必须在 await fsPushRecord 之前（否则网络挂住时改动只在内存里）');
  const region = HTML.slice(i, pushIdx);
  assert.ok(/save\(\); renderLedger\(\); renderTxns\(\);/.test(region), '算账之后、网络之前没有落盘渲染');
});
