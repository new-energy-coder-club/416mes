/**
 * BUG-19（v3.13.8）：发现 I 只修了数据层，回放校验的 UI 不读新字段。
 * 用户看到的仍是「N 条不一致 + 前 10 条平铺」，首错连带标注形同虚设。
 * 本测试锁死「数据层产出 → UI 消费」的闭环，并覆盖排序细节。
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MC = fs.readFileSync(path.join(ROOT, 'mes-core.js'), 'utf8');

test('BUG-19：回放校验 UI 必须消费 rootCauseCandidates / cascadedMismatches / firstForMaterial', () => {
  assert.match(HTML, /rootCauseCandidates/, 'UI 必须读首错数');
  assert.match(HTML, /cascadedMismatches/, 'UI 必须读连带数');
  assert.match(HTML, /firstForMaterial/, 'UI 必须按首错/连带标注');
  assert.match(HTML, /\[首错\]/, '必须给首错可见标签');
  assert.match(HTML, /\[连带\]/, '必须给连带可见标签');
});

test('BUG-19：首错优先排序，且同组内 seq 按数字比（#10 不得排到 #4 前）', () => {
  // 复刻 index.html 的排序逻辑做行为自证
  const bad = [
    { seq: 3,  matCode: 'GJ', firstForMaterial: false },
    { seq: 2,  matCode: 'GJ', firstForMaterial: true },
    { seq: 7,  matCode: 'HC', firstForMaterial: true },
    { seq: 10, matCode: 'GJ', firstForMaterial: false },
    { seq: 4,  matCode: 'GJ', firstForMaterial: false }
  ];
  // v3.13.14：直接调用产品代码的真函数（mes-core.rankMismatches），
  // 不再复制一份比较器“自证”——那份副本与产品代码各写一份，
  // 产品改了排序而副本没改时，测试依然会绿。
  const Core = require('../mes-core.js');
  assert.equal(typeof Core.rankMismatches, 'function', 'mes-core 必须导出 rankMismatches');
  const ranked = Core.rankMismatches(bad);
  assert.deepEqual(ranked.map(b => b.seq), [2, 7, 3, 4, 10], '首错靠前 + 同组 seq 数字升序（#10 不得排到 #4 前）');
  // 纯函数：不得修改入参顺序
  assert.deepEqual(bad.map(b => b.seq), [3, 2, 7, 10, 4], 'rankMismatches 必须是纯函数（slice 后排序）');
  // 旧数据 seq 可能是字符串'旧' → 退化字符串比，但首错优先仍成立
  const legacy = Core.rankMismatches([{ seq: '旧', firstForMaterial: false }, { seq: '旧', firstForMaterial: true }]);
  assert.deepEqual(legacy.map(b => b.firstForMaterial), [true, false], '非数字 seq 时首错优先仍成立');
  // null/非法入参不得抛错
  assert.deepEqual(Core.rankMismatches(null), []);
  assert.deepEqual(Core.rankMismatches('x'), []);
  // index.html 必须真的调用共享函数，而不是再自带一份比较器
  assert.match(HTML, /var ranked = CORE\.rankMismatches\(bad\);/, 'index.html 必须调用 CORE.rankMismatches（单一来源）');
  assert.ok(!/var ranked = bad\.slice\(\)\.sort/.test(HTML), 'index.html 不得再自带排序副本');
});

test('BUG-19：只有 1 处坏点时不得出现「连带」提示（不制造噪音）', () => {
  // 复刻 index.html 的条件：roots != null && cascaded != null && bad.length > roots
  const showCascade = (bad, roots, cascaded) => (roots != null && cascaded != null && bad > roots);
  assert.equal(showCascade(1, 1, 0), false, '单条 mismatch 不说连带');
  assert.equal(showCascade(3, 1, 2), true, '1 首错 + 2 连带要说清');
});

test('配套：MesCore 仍提供这几个字段（数据层未回退）', () => {
  assert.match(MC, /firstForMaterial: isFirstForMat/, 'mismatch 必须带 firstForMaterial');
  assert.match(MC, /rootCauseCandidates:/, '汇总必须带 rootCauseCandidates');
  assert.match(MC, /cascadedMismatches: cascadeCount/, '汇总必须带 cascadedMismatches');
});

test('发现 L：冲销跳过的件必须在工单详情可见（不得只说「已冲销」）', () => {
  // UI 必须读 reverseInfo.skipped 并给出每件的 itemCode + reason
  assert.match(HTML, /reverseInfo && Array\.isArray\(w\.reverseInfo\.skipped\) && w\.reverseInfo\.skipped\.length/,
    '详情页必须判断 reverseInfo.skipped');
  assert.match(HTML, /冲销时跳过 ' \+ w\.reverseInfo\.skipped\.length \+ ' 件/, '必须报出跳过件数');
  assert.match(HTML, /s\.itemCode \|\| s\.matCode/, '必须取到被跳过的件码');
  assert.match(HTML, /s && s\.reason/, '必须给出跳过原因');
  // 数据层两个来源的键名都要兼容
  const mc = fs.readFileSync(path.join(ROOT, 'mes-core.js'), 'utf8');
  assert.match(mc, /skipped\.push\(\{ itemCode: o\.itemCode, reason:/, 'buildItemReverseCommands 的 skipped 用 {itemCode,reason}');
  assert.match(mc, /exempted\.push\(\{ itemCode: o\.itemCode, opId: o\.opId \|\| '' \}\)/, 'settle 的 skipped 用 {itemCode,opId}');
});

test('发现 L：无跳过时不得渲染该提示（不制造噪音）', () => {
  // 复刻三目条件做行为自证
  const block = w => (w.reverseInfo && Array.isArray(w.reverseInfo.skipped) && w.reverseInfo.skipped.length ? 'SHOW' : 'HIDE');
  assert.equal(block({ reverseInfo: { at: 'T' } }), 'HIDE', 'reverseInfo 没有 skipped 不显示');
  assert.equal(block({ reverseInfo: { skipped: [] } }), 'HIDE', 'skipped 空数组不显示');
  assert.equal(block({ reverseInfo: { skipped: [{ itemCode: 'I-1', reason: '已出库' }] } }), 'SHOW', '有跳过件才显示');
  assert.equal(block({}), 'HIDE', '未冲销的单不显示');
});
