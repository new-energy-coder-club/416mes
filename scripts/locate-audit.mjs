#!/usr/bin/env node
/**
 * locate-audit.mjs — 验收标准 9「30S 精确定位」的可重复抽查工具
 *
 * 用法：
 *   node scripts/locate-audit.mjs <备份.json> [抽查数量] [seed]
 *   node scripts/locate-audit.mjs --seed-data            # 用内置种子数据自检
 *
 * 输出：逐件定位结果（位置 / 分级 / 来源 / 耗时）与汇总，任一零件无法定位则退出码非 0。
 * 与网页端「🎯 定位抽查」按钮共用 mes-core.js 的 locateAudit()，口径完全一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../mes-core.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GRADE_LABEL = { exact: '精确', container: '容器', zone: '模块区', clue: '历史线索', none: '无法定位' };
const GRADE_COLOR = { exact: '\x1b[32m', container: '\x1b[36m', zone: '\x1b[33m', clue: '\x1b[33m', none: '\x1b[31m' };
const RESET = '\x1b[0m';

function loadState(file) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const st = pkg.state || pkg;
  if (!Array.isArray(st.materials)) throw new Error('不是有效的 416MES 备份文件：' + file);
  return st;
}

/** 与页面 C_LAYOUT / MODULE_ZONES 等价的种子数据，供无备份文件时自检 */
function seedState() {
  const locations = [], containers = [], materials = [];
  const pad = (n, w) => String(n).padStart(w, '0');
  for (const area of ['B', 'C'])
    for (let s = 1; s <= 2; s++)
      for (let l = 1; l <= 4; l++)
        for (let p = 1; p <= 8; p++)
          locations.push({ code: area + '-' + pad(s, 2) + '-' + pad(l, 2) + '-' + pad(p, 2), kind: '货架', desc: area + '区 ' + s + '号货架 第' + l + '层 第' + p + '位' });
  for (let w = 1; w <= 4; w++)
    for (let g = 1; g <= 3; g++)
      locations.push({ code: 'W' + pad(w, 2) + '-G' + pad(g, 2), kind: '工位', desc: w + '号工位 第' + g + '格收纳' });
  for (let i = 1; i <= 12; i++)
    locations.push({ code: 'K401-' + String.fromCharCode(64 + ((i % 3) + 1)) + pad(i, 2), kind: '空地', desc: '401开放区 第' + i + '号块位' });
  for (let i = 1; i <= 5; i++)
    locations.push({ code: 'M-0' + i, kind: '模块区', desc: ['连接器', '电机', '电池', '防护设备', '端子线材'][i - 1] });
  for (let i = 1; i <= 40; i++)
    containers.push({ code: 'XK-' + pad(i, 3), type: 'A4四抽收纳盒', spec: 'A4', loc: i % 3 ? 'B-01-01-0' + ((i % 8) + 1) : '' });

  // 覆盖各种定位情形：有库位 / 在容器内 / 只有模块区 / 已领出仅剩历史线索
  for (let i = 1; i <= 40; i++) {
    const kind = i % 4;
    materials.push({
      code: 'GJ-SD-' + pad(i, 3), name: '零件' + i, spec: '规格' + i, xy: '', qty: (i * 3) % 20, minQty: 0, cost: 10, img: '',
      loc: kind === 0 ? '' : locations[(i * 7) % locations.length].code,
      container: kind === 0 ? containers[i % containers.length].code : '',
      zone: 'M-0' + ((i % 5) + 1)
    });
  }
  return { materials, locations, containers, workorders: [], transactions: [], scanHistory: [], txnSeq: 0, scanSeq: 0 };
}

/* ---------- 入口 ---------- */
const argv = process.argv.slice(2);
const useSeed = argv.includes('--seed-data');
const positional = argv.filter(a => !a.startsWith('--'));
const file = useSeed ? null : (positional[0] || path.join(ROOT, '416MES_备份.json'));
const sample = parseInt(positional[useSeed ? 0 : 1] || '10', 10);
const seed = parseInt(positional[useSeed ? 1 : 2] || '20260915', 10);

let state;
try {
  state = useSeed ? seedState() : loadState(file);
} catch (e) {
  console.error('❌ ' + e.message);
  if (!useSeed) console.error('   提示：可先用 --seed-data 跑内置种子数据，或在网页端「导出备份 JSON」后传入该文件。');
  process.exit(1);
}

console.log('== 416MES 30S 定位抽查 ==');
console.log(state === null ? '' : ('数据源：' + (useSeed ? '内置种子数据' : file)));
console.log('物料总数 ' + state.materials.length + '，抽查 ' + Math.min(sample, state.materials.length) + ' 件，seed ' + seed);
console.log('');

const t0 = process.hrtime.bigint();
const report = Core.locateAudit(state, { sample, seed });
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

const w = (s, n) => { // 中英混排按显示宽度补齐
  let width = 0;
  for (const ch of String(s)) width += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - width));
};

console.log(w('物料码', 14) + w('名称', 12) + w('数量', 6) + w('分级', 10) + '位置线索');
console.log('-'.repeat(96));
for (const r of report.results) {
  const c = GRADE_COLOR[r.grade] || '';
  console.log(
    w(r.code, 14) + w(r.name || '—', 12) + w(r.qty == null ? '—' : r.qty, 6) +
    c + w(GRADE_LABEL[r.grade] || r.grade, 10) + RESET + (r.path || '—')
  );
}
console.log('-'.repeat(96));
console.log('汇总：精确 ' + report.summary.exact + ' · 容器 ' + report.summary.container +
  ' · 模块区 ' + report.summary.zone + ' · 历史线索 ' + report.summary.clue +
  ' · 无法定位 ' + report.summary.none);
console.log('精确率 ' + Math.round(report.preciseRatio * 100) + '%（精确 + 容器 ÷ 抽查数）');
console.log('本次查询耗时 ' + elapsedMs.toFixed(1) + ' ms（验收口径为人工 30 秒内完成查询）');

if (!report.ok) {
  const bad = report.results.filter(r => r.grade === 'none').map(r => r.code);
  console.error('\n❌ 有 ' + bad.length + ' 件零件无法给出任何位置线索：' + bad.join('、'));
  console.error('   处理：在台账补「当前库位码 / 容器码 / 模块区」，或至少扫码一次留下位置记录。');
  process.exit(1);
}
console.log('\n✅ 抽查通过：每一件零件都能给出位置或历史线索。');
