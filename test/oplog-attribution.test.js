/**
 * v3.12.0 操作记录页 + 操作人/设备 attribution —— 回归测试
 *
 * 背景（用户实测）：
 *   「各种物品出入库的操作流程无法在项目中体现」
 *   根因：state.itemOperations 是五处操作记录里唯一没有页面视图的；
 *        且它的 operator 恒为假身份 'trial-unverified'、device 恒为 ''。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'lib', 'item-client.js'), 'utf8');
const OP = fs.readFileSync(path.join(ROOT, 'lib', 'item-operation.js'), 'utf8');
const PERSIST = fs.readFileSync(path.join(ROOT, 'lib', 'item-persistence.js'), 'utf8');

/* ============ 一、操作人 attribution（header 声明式身份） ============ */

test('A1 服务端支持 X-416mes-Operator 声明式身份（试运行模式）', () => {
  assert.match(OP, /OPERATOR_HEADER = 'x-416mes-operator'/, '必须定义 operator header 名');
  assert.match(OP, /function declaredOperator\(req\)/, '必须有 declaredOperator');
  assert.match(OP, /const op = declaredOperator\(req\);\s*\n\s*return \{ id: op \|\| 'trial-unverified'/, '试运行模式必须用声明身份，缺省回落 trial-unverified');
});

test('A2 客户端提交时带上当前操作人 header', () => {
  assert.match(CLIENT, /'X-416mes-Operator':operatorHeader\(\)/, 'headers() 必须带 X-416mes-Operator');
  assert.match(CLIENT, /const operatorHeader=\(\)=>\{/, '必须有 operatorHeader()');
  assert.match(CLIENT, /st\.operator/, '必须从 state.operator 取当前操作人');
});

test('A3 operator 绝不能进入 request 主体（否则破坏 opId 幂等重放）', () => {
  /* requestHash = hash(frozen)，frozen 是整个 request。
     若 operator 进了 request，客户端超时后同 opId 重提会因 payload 不同被拒。 */
  assert.ok(!/request\s*=\s*\{[^}]*\boperator\b/.test(CLIENT),
    'item-client 不得把 operator 放进 request 主体');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'lib', 'item-ui.js'), 'utf8');
  const reqLines = uiSrc.match(/request=\{[^;]*\};?/g) || [];
  for (const l of reqLines) {
    assert.ok(!/\boperator\s*:/.test(l), 'item-ui 构造 request 时不得塞 operator：' + l.slice(0, 80));
  }
});

test('A4 声明身份有字符白名单（防 CR/LF 注入日志）', () => {
  assert.match(OP, /decodeURIComponent\(v\)/, '必须先 percent-decode 还原客户端传来的身份');
  assert.match(OP, /replace\(\/\[\\r\\n\\t\]\/g, ''\)/, '必须剔除 CR/LF/TAB 控制字符');
  assert.match(OP, /OPERATOR_MAX = 80/, '必须有长度上限');
});

/* ⚠️ v3.12.0 实测抳出的真 bug（ego-browser 全量测试发现）：
   HTTP header 只能是 ByteString（码点 ≤ 255），中文姓名直接写进 header 会让整个 fetch 抛
     "String contains non ISO-8859-1 code point"
   而该 header 是每条命令都带的 → **中文名操作人一步都走不下去**。
   修法：客户端 encodeURIComponent 后再发，服务端 decodeURIComponent 还原。 */
test('A7 中文操作人必须 percent-encode 后才进 header（否则 fetch 直接抛错）', () => {
  assert.match(CLIENT, /encodeURIComponent\(safe\)/, '客户端必须对身份做 percent-encoding');
  assert.ok(!/return safe;\s*\}/.test(CLIENT), '客户端不得把原始中文直接当 header 值返回');
  /* 回归：中文经编码后必须能构造 header，且服务端能还原 */
  const nm = '卢王淳';
  const enc = encodeURIComponent(nm);
  assert.doesNotThrow(() => new Headers({ 'X-416mes-Operator': enc }), 'percent-encoded 身份必须能构造 header');
  assert.equal(decodeURIComponent(enc), nm, '服务端必须能还原回原文');
});

/* ============ 二、device attribution ============ */

test('A5 enqueue 总闸补 device（服务端一直在读 frozen.device）', () => {
  assert.match(PERSIST, /if \(frozen && !frozen\.device\)/, 'enqueue 必须补 device');
  assert.match(PERSIST, /st\.deviceId/, 'device 来源应为 state.deviceId');
  assert.match(OP, /device: String\(frozen\.device \|\| ''\)/, '服务端必须仍从 frozen.device 读（通路不变）');
});

test('A6 device 不进域层判定（补它是安全的）', () => {
  const U = fs.readFileSync(path.join(ROOT, 'lib', 'unique-items.js'), 'utf8');
  assert.ok(!/\bdevice\b/.test(U), 'unique-items 不得读 device —— 这正是它能安全进 request 的原因');
});

/* ============ 三、操作记录页 ============ */

test('P1 导航里有「操作记录」页签，且在现场作业组内', () => {
  assert.match(HTML, /<button data-tab="oplog"[^>]*>操作记录<\/button>/, '必须有 oplog 页签');
  const nav = HTML.slice(HTML.indexOf('<nav class="tabs"'), HTML.indexOf('</nav>'));
  const iField = nav.indexOf('现场作业');
  const iOplog = nav.indexOf('data-tab="oplog"');
  const iNextGroup = nav.indexOf('nav-group', iField + 4);
  assert.ok(iOplog > iField, 'oplog 必须在「现场作业」组标签之后');
  assert.ok(iNextGroup < 0 || iOplog < iNextGroup, 'oplog 必须在下一个分组之前（即属于现场作业组）');
});

test('P2 页面有用途行 + 库存影响徽标（与其余 10 页签一致）', () => {
  const sec = HTML.slice(HTML.indexOf('id="tab-oplog"'), HTML.indexOf('</section>', HTML.indexOf('id="tab-oplog"')));
  assert.match(sec, /class="page-purpose"/, '必须有 page-purpose');
  assert.match(sec, /impact--none/, '操作记录只读，必须是「不改库存」徽标');
});

test('P3 只读：页面不含任何写入口', () => {
  const sec = HTML.slice(HTML.indexOf('id="tab-oplog"'), HTML.indexOf('</section>', HTML.indexOf('id="tab-oplog"')));
  /* 允许 search/date/select/button（筛选与导出），但不允许会改数据的动作按钮文案 */
  assert.ok(!/提交|执行|删除|作废|建档|启用/.test(sec.replace(/清除筛选|导出 CSV|追溯/g, '')),
    '只读页不得出现写动作按钮');
});

test('P4 数据源是 itemOperations，字段全取自既有列（不新增飞书列）', () => {
  assert.match(HTML, /state\.itemOperations/, '必须读 state.itemOperations');
  assert.match(HTML, /function renderOpLog\(\)/, '必须有 renderOpLog');
  const fn = HTML.slice(HTML.indexOf('function renderOpLog()'), HTML.indexOf('function renderOpLogTrace'));
  for (const f of ['opTime(o)', 'o.operator', 'o.kind', 'o.itemCode', 'o.containerCode', 'o.phase', 'o.device', 'o.code']) {
    assert.ok(fn.includes(f), 'renderOpLog 必须使用既有字段：' + f);
  }
});

test('P5 切到该页签时会重渲染（数据可能刚同步下来）', () => {
  assert.match(HTML, /if \(b\.dataset\.tab === 'oplog'\) renderOpLog\(\);/, 'tab 切换必须触发 renderOpLog');
});

test('P6 按物品追位置变化链：读 before/after 快照', () => {
  assert.match(HTML, /function opSnapshotPos\(snap, itemCode\)/, '必须有快照位置解析');
  assert.match(HTML, /o\.before/, '追溯必须读 before 快照');
  assert.match(HTML, /o\.after/, '追溯必须读 after 快照');
  const fn = HTML.slice(HTML.indexOf('function renderOpLogTrace'), HTML.indexOf('let opLogFilter'));
  assert.ok(/opPosText\(b\)[\s\S]{0,200}opPosText\(a\)/.test(fn), '必须展示 before → after');
});

test('P7 筛选维度齐全：类型 / 阶段 / 时间区间 / 关键词 / 操作人', () => {
  assert.match(HTML, /id="opLogKind"/, '类型筛选');
  assert.match(HTML, /id="opLogPhase"/, '阶段筛选');
  assert.match(HTML, /id="opLogFrom"/, '起始日期');
  assert.match(HTML, /id="opLogTo"/, '结束日期');
  assert.match(HTML, /id="opLogSearch"/, '关键词筛选');
  const fn = HTML.slice(HTML.indexOf('function opLogFiltered()'), HTML.indexOf('function renderOpLog()'));
  assert.match(fn, /o\.operator/, '筛选必须覆盖操作人');
  assert.match(fn, /o\.itemCode/, '筛选必须覆盖物品码');
});

test('P8 状态区计数已注册（不再出现空字符串）', () => {
  assert.match(HTML, /oplog: '操作记录 ' \+ \(\(state\.itemOperations \|\| \[\]\)\.length\)/, 'counts 必须有 oplog 键');
});
