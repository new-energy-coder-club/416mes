/**
 * P6 旁路模块的**内联代码**不变量（脚本部分见 p6-bypass-scripts.test.js）
 *
 * 这一组盯的是两个「会真的动库存/打错标签」的缺陷：
 *   · NEC 工单与仓库工单共用 `<类型><日期><3位>` 编码空间，两边都有 LL，
 *     而扫码自动识别是「先找仓库工单」→ 扫 NEC 领料标签会命中同号仓库工单并弹出「执行」
 *   · 模块区同时出现在「库位」和「模块区卡」两个页签，两套标签尺寸
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function fnSrc(name) {
  const i = HTML.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '找不到 function ' + name);
  const j = HTML.indexOf('\n}', i);
  assert.ok(j > i, '找不到 function ' + name + ' 的结尾');
  return HTML.slice(i, j);
}

test('P6-2 NEC 工单码必须脱离仓库工单的编码空间', () => {
  assert.ok(/const NEC_CODE_PREFIX = 'NEC-';/.test(HTML), '缺少 NEC 编码前缀常量');
  // 建单处必须真的用上前缀（只在常量里定义没用）
  const i = HTML.indexOf("document.getElementById('btnNecCreate')");
  assert.ok(i > 0, '找不到 NEC 建单入口');
  const body = HTML.slice(i, HTML.indexOf('save(); renderNec();', i));
  assert.ok(/code:\s*NEC_CODE_PREFIX\s*\+/.test(body),
    'NEC 建单没有加前缀 → 与仓库工单同号，扫错标签会真的扣库存');
});

test('P6-2 扫码遇到「仓库工单与 NEC 工单同号」必须停下，不能替人猜', () => {
  const i = HTML.indexOf('function handleScan');
  assert.ok(i > 0, '找不到 handleScan');
  const body = HTML.slice(i, HTML.indexOf('scanMat(code, box);', i) + 200);
  assert.ok(/asWip && asNec/.test(body), '缺少歧义判定（同时匹配两种工单）');
  assert.ok(/asWip && asNec[\s\S]{0,700}?return;/.test(body), '歧义时必须直接 return，绝不能继续往下走到执行');
  // 不允许再出现「先 WIP 后 NEC，命中即走」的老写法
  assert.ok(!/if \(state\.workorders\.some\(w => w\.code === raw\)\) prefix = 'WIP:';/.test(HTML),
    '还是老写法：先判 WIP 命中即用 → 同号时必然选中仓库工单');
});

test('P6-2 导入备份时计数器要从实际单号回填（否则生成的号已被占用）', () => {
  const a = HTML.indexOf('function mergePackage(');
  const src = HTML.slice(a, a + 6000);
  assert.ok(/bumpFromCodes\(state\.workorders/.test(src), '工单计数器没有从单号回填');
  assert.ok(/necSerials\[m\[1\]\]/.test(src), 'NEC 计数器没有从单号回填');
  assert.ok(/\(\?:NEC-\)\?/.test(src), 'NEC 单号正则要同时认新旧两种格式');
});

test('P6-6 模块区不能同时出现在「库位」和「模块区卡」两个页签', () => {
  const r = fnSrc('recordsOf');
  assert.ok(/t === 'loc'\) return state\.locations\.filter\(l => l\.kind !== '模块区'\)/.test(r),
    '「库位」页签没有排除模块区 → 同一个码出现在两个页签、两套标签尺寸');
  assert.ok(/t === 'zone'\) return state\.locations\.filter\(l => l\.kind === '模块区'\)/.test(r),
    '「模块区卡」页签的筛选不见了');
});

test('P6-6 页签与纸张必须一起记住并恢复（区卡只在 A4 可见）', () => {
  assert.ok(/localStorage\.setItem\('mes416_label_type', curType\)/.test(HTML), '切换页签时没有记住');
  assert.ok(/localStorage\.getItem\('mes416_label_type'\)/.test(HTML), '启动时没有恢复页签');
  // 恢复模块区页签时必须把纸张一起切回 A4，否则得到空白打印
  const i = HTML.indexOf('restoreLabelType');
  assert.ok(i > 0, '缺少恢复函数');
  const body = HTML.slice(i, i + 600);
  assert.ok(/curType === 'zone'\) setPaper\('a4', true\)/.test(body),
    '恢复模块区页签时没有一起把纸张切回 A4 → 区卡是 display:none，打出来是白纸');
  // 点页签时也要联动
  assert.ok(/if \(curType === 'zone'\) setPaper\('a4'\);/.test(HTML), '点击模块区页签时没有联动纸张');
});

test('P6-6 打印前要有守卫：区卡在标签纸模式下是隐藏的，不能直接打出白纸', () => {
  const i = HTML.indexOf("document.getElementById('btnPrint')");
  assert.ok(i > 0, '找不到打印入口');
  const body = HTML.slice(i, HTML.indexOf('window.print()', i) + 20);
  assert.ok(/curType === 'zone' && !document\.body\.classList\.contains\('a4paper'\)/.test(body),
    '缺少「区卡 + 标签纸」的拦截');
  assert.ok(/已自动切到 A4/.test(body), '拦截后要说明发生了什么');
  // 拦截必须发生在 window.print() 之前
  assert.ok(body.indexOf("contains('a4paper')") < body.lastIndexOf('window.print()'),
    '守卫必须在 window.print() 之前生效');
});


/* ================= B9：工单详情白屏（阶段七之后的真机反馈） ================= */

test('B9【关键】工单不存在时不得先把列表视图切走（否则整页空白，只能 F5）', () => {
  const s = fnSrc('showWipDetail');
  const guard = s.indexOf('if (!w)');
  const addCls = s.indexOf("classList.add('wip-detail-open')");
  assert.ok(guard >= 0, 'showWipDetail 里必须存在「找不到工单」的判断');
  assert.ok(addCls > guard,
    'classList.add(\'wip-detail-open\') 必须在存在性判断**之后** —— ' +
    '原来先切视图再 find，找不到就 return，于是列表被隐藏、详情面板从未显示 = 整页空白');
  assert.ok(/backToWipList\(\)/.test(s.slice(guard, guard + 260)),
    '找不到工单时必须回退到列表（只 return 会把列表留在隐藏态）');
  assert.ok(/ctxClear\(\)/.test(s.slice(guard, guard + 260)),
    '「当前对象」条不能继续指向一个不存在的工单号（截图里的幽灵 LL20260912001）');
});

test('B9 renderWip 的兜底必须能恢复列表视图（只藏面板不够）', () => {
  const r = fnSrc('renderWip');
  assert.ok(/classList\.remove\('wip-detail-open'\)/.test(r),
    'renderWip 的兜底只把详情面板 display:none，却没摘 .wip-detail-open —— ' +
    '列表仍被 CSS 隐藏，结果是空白。日志/同步替换掉工单时就会走到这条路径');
});

test('B9 删除工单后不得留下白屏与幽灵「当前对象」', () => {
  const i = HTML.indexOf("getElementById('btnWipDelete')");
  assert.ok(i > 0, '找不到 btnWipDelete 处理器');
  const body = HTML.slice(i, i + 1200);
  assert.ok(/backToWipList\(\)/.test(body),
    '删完工单没有回到列表视图（原来只写 wipDetailCode=\'\' + panel.display=\'none\'，类还留着 → 白屏）');
  assert.ok(/ctxClear\(\)/.test(body), '「当前对象」仍会指向已删除的工单');
});

test('B10 新建工单必须有重入闸门，且取号占号要在 await 之后', () => {
  // 重入闸门：必须在第一个 await 之前禁用按钮
  const i = HTML.indexOf("document.getElementById('btnGenWip')");
  assert.ok(i > 0, '找不到 btnGenWip 处理器');
  const body = HTML.slice(i, i + 3000);
  const dis = body.indexOf('disabled = true');
  const aw = body.indexOf('await fsNextWorkorderSerial');
  /* ⚠️ 只断言「有 disabled = true」是不够的 —— 变异测试证明：删掉前面那句
     `if (_gb.disabled) return;`（真正防并发的那句）时，仅靠 disabled=true 的断言仍然通过。
     必须同时断言「进入时先检查并提前返回」。 */
  assert.ok(/\.disabled\)\s*return/.test(body),
    'btnGenWip 缺少「已在执行中就提前返回」这句 —— 只 disable 不 return 挡不住并发（变异测试证实）');
  assert.ok(dis >= 0, 'btnGenWip 没有重入闸门 —— 连点会并发取到同一个号并建出多条同号工单');
  assert.ok(dis < aw, '重入闸门必须在第一次 await 之前，否则并发已经发生');
  assert.ok(/finally/.test(body), '必须 try/finally：有 alert 提前返回的分支，否则按钮会永久禁用');

  // 取号占号：await 之后必须重读并同步占号
  const s = fnSrc('fsNextWorkorderSerial');
  assert.ok(/state\.serials\[key\] = next/.test(s), '占号必须在取号函数内部同步完成（不能只在调用处事后覆盖）');
  const catchIdx = s.indexOf('catch');
  assert.ok(catchIdx > 0 && /state\.serials\[key\]/.test(s.slice(catchIdx)),
    'await/catch 之后必须重新读 state.serials[key] —— 原实现只在 await 之前读一次快照，这正是 6 连击同号的成因');
});

test('阶段0：本地重复工单收敛入口不得调用飞书删除，且处理后必须重新核对', () => {
  const core = fnSrc('fsPruneStaleConflicts'); // 先确认 fnSrc 仍能抓函数，避免测试框架本身失效
  assert.ok(core.length > 20);
  const i = HTML.indexOf("data-collapse-wip");
  assert.ok(i > 0, '对齐面板缺少本地重复工单收敛入口');
  const end = HTML.indexOf("  const dj = document.getElementById('btnDelJournal');", i);
  const body = HTML.slice(i, end > i ? end : i + 3500);
  assert.ok(/collapseIdenticalWorkorderDuplicates/.test(body), '必须调用纯本地收敛函数');
  assert.ok(/__localDupJournal/.test(body), '必须写本地回退凭据');
  assert.ok(/await runReconcile\(\)/.test(body), '处理后必须立即重新核对，否则数字看起来没变');
  assert.ok(!/\bfsPushDelete\s*\(/.test(body), '本地去重绝不能调用 fsPushDelete，否则会删除飞书唯一正确记录');
});

test('阶段0：同号重复未收敛前，详情/扫码执行/普通删除都必须阻断', () => {
  const detail = fnSrc('showWipDetail');
  const scan = fnSrc('scanWip');
  assert.ok(/workorderLocalDuplicate\(code\)/.test(detail), '详情必须阻断同号重复');
  assert.ok(/workorderLocalDuplicate\(code\)/.test(scan), '扫码执行必须阻断同号重复，避免取第一行计划扣错库存');
  const i = HTML.indexOf("getElementById('btnWipDelete')");
  const body = HTML.slice(i, i + 1500);
  assert.ok(/workorderLocalDuplicate\(w\.code\)/.test(body), '普通删除必须阻断重复组，避免按业务键删飞书唯一行');
});

test('阶段0：本地重复去重提供安全撤销入口，且撤销后重新核对', () => {
  assert.ok(/id="btnUndoLocalDup"/.test(HTML), '缺少本地去重撤销入口');
  const i = HTML.indexOf("id=\"btnUndoLocalDup\"");
  const end = HTML.indexOf("  const dj = document.getElementById('btnDelJournal');", i);
  const body = HTML.slice(i, end > i ? end : i + 9000);
  assert.ok(/restoreWorkorderDuplicateCollapse/.test(body), '撤销必须走带哈希保护的纯函数');
  assert.ok(/state\.__localDupJournal\.shift/.test(body), '成功撤销后必须消费凭据');
  assert.ok(/await runReconcile\(\)/.test(body), '撤销后必须重新核对');
});

test('B10 本地校验失败时只回收尚未被后续使用的占号', () => {
  const rel = fnSrc('fsReleaseWorkorderSerial');
  assert.ok(/state\.serials\[seqInfo\.key\].*!== seqInfo\.next/.test(rel),
    '回收前必须确认计数器仍等于本次占号，否则会把并发建单的新号倒退');
  assert.ok(/Math\.max\(Number\(seqInfo\.local\).*Number\(seqInfo\.remote\)/s.test(rel),
    '回收最多退到本次 local/remote 的最大值，不能低于飞书已有号');
  const i = HTML.indexOf('const r = CORE.createOrder');
  const body = HTML.slice(i, i + 500);
  assert.ok(/if \(!r\.ok\)[\s\S]*fsReleaseWorkorderSerial\(seqInfo\)/.test(body),
    'createOrder 本地校验失败时应回收本次占号，避免无谓跳号');
});
