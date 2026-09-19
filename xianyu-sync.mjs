#!/usr/bin/env node
/**
 * xianyu-sync.mjs — 闲鱼商品数据 → 416MES 台账合并（需求书 4.3）
 *
 * 【G3 已停用】（v2.46.0）：闲鱼挂的是分类级商品，与单件物品不同层；MAT 数量账已
 * 整体封存，物料台账页降级为只读历史视图，页面层不再触发本脚本。文件保留不删，
 * 后续如需闲鱼对接请按物品/分类层级单列方案，勿直接恢复本脚本的 MAT 合并。
 *
 * 用法：
 *   node xianyu-sync.mjs status                       # 查看配置与取数命令可用性
 *   node xianyu-sync.mjs import <文件.json|文件.csv> [备份.json] [--dry-run]
 *   node xianyu-sync.mjs fetch [备份.json] [--dry-run] # 先跑配置里的取数命令，再合并
 *
 * 字段映射（需求书 4.3）：
 *   outer_id → 物料码 ｜ product_id → 闲鱼XY编号 ｜ 标题 → 名称
 *   stock → 库存 ｜ 售价/100 → 成本 ｜ 首图 → 图片链接 ｜ 分类默认 QT
 *
 * 合并规则：
 *   - 不覆盖本地已维护的：分类 / 库位 / 容器 / 模块区 / 安全库存 / 规格型号
 *   - 空值不覆盖旧值（名称 / 闲鱼XY编号 / 图片链接）
 *   - 数量与成本例外：外部值始终采用（stock=0 表示售罄）
 *   - 幂等：重复执行不产生重复记录
 *
 * 取数：闲鱼没有公开官方接口，取数方式因人而异，因此本脚本把它抽象成一条
 * 配置好的命令（config.fetchCommand），只要它向 stdout 输出 JSON 数组或 CSV 即可。
 * 想用现成的 Python 爬取脚本，就把它放进 .venv-xianyu/ 并在配置里指明命令——
 * 合并逻辑留在本文件里，不依赖 Python 环境。
 *
 * 配置文件：xianyu-sync.config.json（已被 .gitignore 排除，请勿提交）
 *   { "fetchCommand": "python .venv-xianyu/fetch.py --json", "priceDivisor": 100 }
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('./mes-core.js');
const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.XIANYU_CONFIG || path.join(DIR, 'xianyu-sync.config.json');

function loadConfig({ quiet = false } = {}) {
  if (!fs.existsSync(CONFIG_FILE)) {
    if (!quiet) console.log('（未找到 xianyu-sync.config.json，使用默认设置）');
    return {};
  }
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { throw new Error('xianyu-sync.config.json 解析失败：' + e.message); }
}

/* ---------- 分隔符文本解析（CSV / TSV 共用） ----------
 * 旧实现把 TSV「全局把 \t 换成 ,」再按 CSV 解析 —— 那是**数据损坏**：
 *   行: XY-9 <TAB> 全新,未拆封 <TAB> 3 <TAB> 1290 <TAB> u
 *   替换后: XY-9,全新,未拆封,3,1290,u   → 标题被逗号切成两列，后面全部右移/错位
 *   实测结果：stock='未拆封'、售价=3、首图='1290'，真正的图片列被丢掉。
 * 现在按**真实分隔符**解析（TSV 用 \t、CSV 用 ,），字段内的逗号/tab 都不再是分隔符。
 */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text).replace(/^\uFEFF/, '');   // 去 BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* 忽略，等 \n */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  /* 引号没闭合会把**后面所有行**吞进同一个字段（静默丢行）。
     与其猜，不如明说 —— 这类文件通常是导出时标题里带了单个双引号（15"显示器）。 */
  if (inQuotes) throw new Error('引号没有闭合：文件里有一个未配对的 \"（常见于标题含英寸符号，如 15\"显示器）。请把它写成 \"\" 或删掉。');
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h).trim());
  const ragged = [];
  const out = rows.slice(1)
    .filter(r => r.some(v => String(v).trim() !== ''))
    .map((r, idx) => {
      // 列数与表头不一致 → 记下来告警，不再静默错列/丢列
      if (r.length !== header.length) ragged.push({ line: idx + 2, got: r.length, want: header.length });
      const o = {};
      header.forEach((h, i) => o[h] = r[i] === undefined ? '' : String(r[i]).trim());
      return o;
    });
  if (ragged.length) {
    const eg = ragged.slice(0, 3).map(x => '第 ' + x.line + ' 行 ' + x.got + '/' + x.want).join('、');
    out.__ragged = ragged;   // 调用方读走后再删（数组上挂个非索引属性不影响遍历）
    process.stderr.write('⚠️ 有 ' + ragged.length + ' 行列数与表头不一致（' + eg + '）—— 可能是分隔符或引号有问题，请核对\n');
  }
  return out;
}
function parseCsv(text) { return parseDelimited(text, ','); }
function parseTsv(text) { return parseDelimited(text, '\t'); }

/** 按内容猜分隔符：表头里 tab 比逗号多就是 TSV（不再只看扩展名） */
function sniffDelim(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

/** 读外部数据文件：按扩展名 / 内容自动识别 JSON 或 CSV */
function readRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  // .tsv 用真 tab 解析；.csv 用逗号。其它扩展名（如 .txt）按内容猜，而不是一律当 CSV ——
  // 旧实现让 tab 分隔的 .txt 整行变成一个字段，全部行都被当成「缺 outer_id」静默跳过。
  if (ext === '.tsv') return parseTsv(text);
  if (ext === '.csv') return parseCsv(text);
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed);
    if (Array.isArray(j)) return j;
    for (const k of ['items', 'data', 'list', 'rows', 'products', 'result']) {
      if (Array.isArray(j[k])) return j[k];
    }
    throw new Error('JSON 里找不到数组（支持的键：items / data / list / rows / products / result）');
  }
  return sniffDelim(text) === '\t' ? parseTsv(text) : parseCsv(text);
}

/** 读备份文件；不存在时视为空台账 */
function loadState(file) {
  if (!fs.existsSync(file)) {
    return { state: { materials: [], locations: [], containers: [], members: [], items: [], manuals: [], workorders: [], transactions: [], serials: {}, necOrders: [], necSerials: {}, scanLog: [] }, existed: false };
  }
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const st = pkg.state || pkg;
  if (!Array.isArray(st.materials)) throw new Error('不是有效的 416MES 备份文件：' + file);
  return { state: st, existed: true };
}

function saveState(file, state, existed) {
  if (existed) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.state) { pkg.state = state; pkg.exportedAt = new Date().toLocaleString(); fs.writeFileSync(file, JSON.stringify(pkg, null, 1)); return; }
  }
  const pkg = { app: '416MES', version: 2, deviceId: 'xianyu-sync', exportedAt: new Date().toLocaleString(), state };
  fs.writeFileSync(file, JSON.stringify(pkg, null, 1));
}

function printStat(stat) {
  console.log(`  新建 ${stat.created} · 更新 ${stat.updated} · 无变化 ${stat.unchanged} · 跳过 ${stat.skipped.length}`);
  if (stat.skipped.length) {
    console.log('  跳过明细：');
    stat.skipped.slice(0, 10).forEach(s => console.log('    #' + s.index + (s.code ? ' ' + s.code : '') + ' ' + s.reason));
    if (stat.skipped.length > 10) console.log('    …共 ' + stat.skipped.length + ' 条');
  }
  const shown = stat.changes.filter(c => c.kind === 'update').slice(0, 20);
  if (shown.length) {
    console.log('  字段变化：');
    shown.forEach(c => console.log('    ' + c.code + '  ' + c.fields.join('，')));
    if (stat.changes.filter(c => c.kind === 'update').length > 20) console.log('    …');
  }
}

/* ---------- 入口 ---------- */
const argv = process.argv.slice(2);
const cmd = argv[0];
const dryRun = argv.includes('--dry-run');
const positional = argv.filter(a => !a.startsWith('--'));
/* loadConfig 在 try 之外会绕过下面的 die()：配置文件写坏时直接抛未捕获异常、
   打印一堆栈，用户看不到那句人话错误。这里就地兜住。 */
let cfg;
try { cfg = loadConfig({ quiet: true }); }
catch (e) {
  console.error('\n❌ ' + e.message);
  console.error('   修好 xianyu-sync.config.json 里的 JSON 语法，或删掉它改用默认设置。');
  process.exit(1);
}
/* 售价除数必须校验。旧实现来者不拒：配成 0 或 "" 时 `price / div` 得到 Infinity，
   配成 "abc" 得 NaN —— 两者都 !== null，于是被当成合法成本写进物料，
   最后 JSON.stringify 把 Infinity/NaN 序列化成 null，**把原有的成本静默抹成 null**
   （备份文件里就写成了 "cost": null，没有任何告警，退出码还是 0）。
   合理取值是 >0 的有限数；不合法就退回默认 100 并明确告知。 */
const rawDivisor = cfg.priceDivisor;
let priceDivisor = 100;
if (rawDivisor == null) {
  priceDivisor = 100;
} else {
  const d = Number(rawDivisor);
  if (Number.isFinite(d) && d > 0) priceDivisor = d;
  else process.stderr.write('⚠️ 配置里的 priceDivisor=' + JSON.stringify(rawDivisor) +
    ' 不是大于 0 的有限数，已退回默认 100（否则会把成本算成 Infinity/NaN，落盘时静默变成 null）\n');
}
const mergeOpts = { priceDivisor };

const DEFAULT_BACKUP = path.join(DIR, '416MES_备份.json');

function die(msg, hint) {
  console.error('\n❌ ' + msg);
  if (hint) console.error('   ' + hint);
  process.exit(1);
}

try {
  if (cmd === 'status') {
    console.log('== 闲鱼同步状态 ==');
    console.log('配置文件：' + (fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : '（不存在，使用默认设置）'));
    console.log('售价除数：' + mergeOpts.priceDivisor + '（售价 ' + mergeOpts.priceDivisor + ' → 成本 1）');
    console.log('取数命令：' + (cfg.fetchCommand || '（未配置，请用 import 手动指定文件）'));
    if (cfg.fetchCommand) {
      const bin = String(cfg.fetchCommand).trim().split(/\s+/)[0];
      let found = false;
      try { execSync((process.platform === 'win32' ? 'where ' : 'command -v ') + bin, { stdio: 'ignore' }); found = true; } catch { }
      console.log('  命令可用性：' + (found ? '✅ ' + bin + ' 在 PATH 中' : '⚠️ 找不到 ' + bin + '（Python 取数脚本请确认 .venv-xianyu 已建好）'));
    }
    console.log('默认备份文件：' + DEFAULT_BACKUP + (fs.existsSync(DEFAULT_BACKUP) ? '（存在）' : '（不存在）'));
  } else if (cmd === 'import' || cmd === 'fetch') {
    let rows, sourceLabel;
    if (cmd === 'import') {
      const src = positional[1];
      if (!src) die('缺少输入文件', '用法：node xianyu-sync.mjs import <文件.json|文件.csv> [备份.json] [--dry-run]');
      if (!fs.existsSync(src)) die('输入文件不存在：' + src);
      rows = readRows(src);
      sourceLabel = src;
    } else {
      if (!cfg.fetchCommand) {
        die('未配置取数命令', '请在 xianyu-sync.config.json 里设置 fetchCommand，或改用 import 指定已有文件。');
      }
      let out;
      try { out = execSync(cfg.fetchCommand, { cwd: DIR, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: true }); }
      catch (e) { die('取数命令执行失败：' + (e.message || e), '命令：' + cfg.fetchCommand); }
      const trimmed = String(out).trim();
      if (!trimmed) die('取数命令没有输出任何内容', '命令：' + cfg.fetchCommand);
      try {
        const j = JSON.parse(trimmed);
        rows = Array.isArray(j) ? j : (j.items || j.data || j.list || j.rows || j.products || j.result);
        if (!Array.isArray(rows)) die('取数命令输出的 JSON 里找不到数组');
      } catch { rows = parseCsv(trimmed); }
      sourceLabel = '取数命令：' + cfg.fetchCommand;
    }

    const backup = positional[2] || (cmd === 'fetch' && positional[1] ? positional[1] : DEFAULT_BACKUP);
    console.log('== 闲鱼数据合并' + (dryRun ? '（dry-run）' : '') + ' ==');
    console.log('数据来源：' + sourceLabel);
    console.log('外部记录：' + rows.length + ' 条');
    console.log('目标台账：' + backup + (fs.existsSync(backup) ? '' : '（不存在，将新建）'));

    const { state, existed } = loadState(backup);
    const before = state.materials.length;
    const stat = Core.mergeXianyu(state, rows, mergeOpts);
    printStat(stat);
    console.log('  物料总数：' + before + ' → ' + state.materials.length);

    if (dryRun) {
      console.log('\n（dry-run：未写入任何文件。去掉 --dry-run 才会保存）');
    } else {
      saveState(backup, state, existed);
      console.log('\n✅ 已写入 ' + backup + ' → 网页端「导入合并」即可回本机');
    }
  } else {
    console.log('用法：');
    console.log('  node xianyu-sync.mjs status');
    console.log('  node xianyu-sync.mjs import <文件.json|文件.csv> [备份.json] [--dry-run]');
    console.log('  node xianyu-sync.mjs fetch [备份.json] [--dry-run]');
  }
} catch (e) {
  die(e && e.message ? e.message : String(e));
}
