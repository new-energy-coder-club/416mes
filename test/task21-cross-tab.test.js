/**
 * 发现 N（v3.13.10）：同一浏览器多标签页数据不同步。
 * 广播以前只发 queue-changed（刷队列角标），没有任何路径告知其他标签页
 * 「本地 state 变了」→ B 页继续显示陈旧数据，用户在 B 页操作基于旧状态。
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('发现 N：save() 之后必须广播 state-changed 给其他标签页', () => {
  assert.match(HTML, /fsBroadcast\(\{ type: 'state-changed', at: Date\.now\(\) \}\)/,
    '必须广播 state-changed');
  // 用包装而非改 save() 内部：save() 有无静默 catch 的不变量锁（persistence-invariants）
  assert.match(HTML, /var _origSave = save;/, '必须用包装法（保存原 save）');
  assert.match(HTML, /save = function \(\) \{/, '必须覆写 save');
  assert.match(HTML, /var r = _origSave\.apply\(this, arguments\);/, '必须先执行原 save 再广播');
  assert.ok(HTML.includes("setTimeout(function () { try { fsBroadcast({ type: 'state-changed', at: Date.now() }); } catch (e) { } }, 0);"),
    '广播必须异步让出热路径（setTimeout 0），且失败被 catch 吞掉不影响落盘');
  // 不变量：save() 本体仍不得有静默 catch（配额错误必须可见）
  const saveSrc = (HTML.match(/function save\(\) \{[\s\S]*?\n\}/) || [''])[0];
  assert.ok(!/catch \(e\) \{ \}/.test(saveSrc), 'save() 本体不得有静默 catch（广播的 try/catch 必须放包装层）');
});

test('发现 N：收到 state-changed 必须触发本页刷新，且防抖', () => {
  assert.match(HTML, /if \(d\.type === 'state-changed'\) scheduleCrossTabRefresh\(\);/, '必须接到刷新调度');
  assert.match(HTML, /function scheduleCrossTabRefresh\(\)/, '必须有调度函数');
  assert.match(HTML, /location\.reload\(\);/, '必须最终真正刷新页面（而非只记日志）');
  assert.ok(HTML.includes('}, 1500);'), '必须延后 1.5s 再刷新（不是立即 reload，给用户反应时间）');
});
test('发现 N：用户正在操作时不得强制刷新（否则打断输入/扫码）', () => {
  const fn = (HTML.match(/function scheduleCrossTabRefresh\(\)[\s\S]*?\n\}/) || [''])[0];
  assert.ok(fn.length > 0, '必须能取到函数体');
  assert.match(fn, /INPUT\|TEXTAREA\|SELECT/, '必须检测输入框聚焦');
  assert.match(fn, /WIP_EXEC && WIP_EXEC\.batch && WIP_EXEC\.batch\.length/, '必须检测有待提交批量');
  assert.match(fn, /已跳过自动刷新/, '跳过时必须告知用户（不能静默）');
  assert.match(fn, /location\.reload\(\)/, '非忙碌时才真正刷新');
});

test('发现 N：既有 queue-changed 广播行为不回退', () => {
  assert.match(HTML, /if \(d\.type === 'queue-changed'\) fsQueueChip\(\);/, '队列角标广播必须保留');
  assert.match(HTML, /fsBroadcast\(\{ type: 'queue-changed' \}\)/, '冲刷成功的广播点必须保留');
});

  assert.ok(HTML.includes('}, 1500);'), '必须延后 1.5s 再刷新（不是立即 reload，给用户反应时间）');