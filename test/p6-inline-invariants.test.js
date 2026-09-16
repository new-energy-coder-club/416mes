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

test('P6-6 补：inventree 库位树必须按「类型」选根，不能把模块区/站点塞进货架区', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'inventree-sync.mjs'), 'utf8');
  // 真实库位码：货架 B-01-01-01 / 工位 W01-G01 / 站点 X-11B-1403 / 模块区 M-01
  assert.ok(/KIND_TO_ROOT = \{[^}]*'货架': 'shelf'[^}]*'工位': 'workstation'[^}]*'模块区': 'zone'[^}]*'站点': 'site'/.test(src),
    'KIND_TO_ROOT 必须按真实类型映射（模块区/站点要各有根）');
  assert.ok(/LOC_ROOTS = \{[^}]*zone: '模块区'[^}]*site: '站点区'/.test(src), 'LOC_ROOTS 要含模块区/站点区');
  // 不能再用「非工位就是货架」的二分法
  assert.ok(!/if \(l\.kind === '工位' \|\| \/\^W\\d\/\.test\(l\.code\)\) \{\s*parent = cfg\.loc_root_ids\.workstation; prefix = parts\[0\];[\s\S]{0,400}\} else \{\s*parent = cfg\.loc_root_ids\.shelf;/.test(src),
    '还是「工位 / 其它→货架」的二分法 —— 模块区和站点会被塞进货架区');
  assert.ok(/unknownKinds/.test(src) && /missingRoots/.test(src), '未知类型/缺根必须告警，不能静默');
});
