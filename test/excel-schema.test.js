/**
 * Excel 双向模板一致性 + PIN 码不外泄 —— 静态检查
 *
 * 为什么需要这组断言（每一条都对应一个真实踩过的坑）：
 *  1. 模板的列结构和导出的列结构**必须逐列相同**。文档里写着「列结构即双向模板，
 *     导出什么样、导入就什么样」，但实际漂移过：导出有「模块区」，模板没有；
 *     导出有「执行数量/执行批次/冲销记录/取消记录」，模板没有。漂移的后果不是报错，
 *     而是**静默丢列** —— 用户照模板填的表导回来，那几列的数据全是空。
 *  2. PIN 码是登录凭据，**任何导出物里都不许出现明文**。旧代码 `m.pin || ''`
 *     把 4 位 PIN 明文写进 Excel；导入侧又无条件覆盖，于是「导出→导入」一次往返
 *     或任何人在表里删掉那一列，全员 PIN 被清空、被锁在门外。
 *
 * 这里用文本解析 index.html 而不是跑浏览器：导入/导出逻辑嵌在 4000 行内联脚本里，
 * 而这两条约束都是**结构约束**，静态检查足够且能在 CI 里秒级跑完。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** 截取 index.html 中两个标记之间的源码（从 from 到 to，不含 to） */
function slice(from, to) {
  const a = HTML.indexOf(from);
  const b = HTML.indexOf(to);
  assert.ok(a >= 0, '找不到起点标记：' + from);
  assert.ok(b > a, '找不到终点标记：' + to);
  return HTML.slice(a, b);
}

/**
 * 从一个 book_append_sheet 调用块里取出表头（第一行）与 sheet 名。
 * 表头恒为 aoa_to_sheet([ 之后的第一个内联数组字面量；sheet 名恒为该块最后
 * 一个 `'名字');`。
 */
function sheetsIn(src) {
  const out = {};
  const re = /aoa_to_sheet\(\[\s*\n\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index);
    // sheet 名恒为 `..., '名字');`（前有逗号+空格）。**不能**用宽松的 /'([^']+)'\)\);
    // ——导出行里的 join('; ') 也会命中，于是标签页被命名成「; 」。
    const nm = rest.match(/, '([^']{1,16})'\);/);
    if (!nm) continue;
    const headers = m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    // 填表说明 sheet 只有一行说明文字，也走同一条路径，无害
    out[nm[1]] = headers;
  }
  return out;
}

const EXPORT_SRC = slice("document.getElementById('btnExport').addEventListener", "document.getElementById('btnImport')");
const TEMPLATE_SRC = slice("document.getElementById('btnTemplate').addEventListener", "/* ---------- 全量 JSON 备份");

test('导出与模板：每张表的列结构逐列相同', () => {
  const exp = sheetsIn(EXPORT_SRC);
  const tpl = sheetsIn(TEMPLATE_SRC);
  assert.ok(Object.keys(exp).length >= 8, '导出的 sheet 数量异常：' + JSON.stringify(Object.keys(exp)));
  assert.ok(Object.keys(tpl).length >= 7, '模板的 sheet 数量异常：' + JSON.stringify(Object.keys(tpl)));
  // 「库存流水」只导出供查阅、导入时忽略（见模板「填表说明」第 6 条），模板里没有它是设计如此
  const EXPORT_ONLY = new Set(['库存流水']);
  for (const [name, eh] of Object.entries(exp)) {
    if (EXPORT_ONLY.has(name)) continue;
    const th = tpl[name];
    assert.ok(th, '模板缺少 sheet：' + name);
    assert.deepStrictEqual(th, eh, 'sheet「' + name + '」模板列结构与导出不一致');
  }
  // 反向：模板里除「填表说明」外不应有多余 sheet
  for (const name of Object.keys(tpl)) {
    if (name === '填表说明') continue;
    assert.ok(exp[name], '模板多出一个导出里没有的 sheet：' + name);
  }
});

test('PIN 码：导出人员表只写已设置/未设置，绝不写明文', () => {
  assert.ok(/m\.pin \? '已设置' : '未设置'/.test(EXPORT_SRC), '导出未按约定掩码 PIN');
  assert.ok(!/m\.pin \|\| ''/.test(EXPORT_SRC), '导出仍在写 PIN 明文（m.pin || ）');
  assert.ok(!/\bm\.pin\s*\]/.test(EXPORT_SRC), '导出仍在直接输出 m.pin');
  assert.ok(/人员/.test(EXPORT_SRC), '找不到人员 sheet');
});

test('PIN 码：导入保持原值，只有 4 位数字/清空 才改动', () => {
  const imp = slice("document.getElementById('fileImport').addEventListener", "document.getElementById('btnTemplate')");
  assert.ok(/pinIdx/.test(imp), '导入没有 PIN 列定位逻辑');
  assert.ok(/\^\\d\{4\}\$/.test(imp), '导入缺少「4 位数字才设置」的校验');
  assert.ok(/oldPin/.test(imp), '导入没有保留既有 PIN 的兜底');
  assert.ok(!/pin: String\(pcol\(/.test(imp), '导入仍在无条件覆盖 pin');
});

test('PIN 码：JSON 备份默认不含，且用「删键」而不是写空串', () => {
  const bk = slice("document.getElementById('btnBackupJson').addEventListener", "/* ---------- 通用合并");
  assert.ok(/withPin/.test(bk), '备份没有 PIN 选择');
  assert.ok(/delete c\.pin/.test(bk), '备份「不含 PIN」应当是删除该键（写空串会变成要求清空）');
});
