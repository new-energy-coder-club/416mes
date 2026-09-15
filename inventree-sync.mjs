#!/usr/bin/env node
/**
 * inventree-sync.mjs — 416MES Excel 台账 → InvenTree 同步脚本（路线 B：API 桥）
 *
 * 用法：
 *   node inventree-sync.mjs init                          # 初始化：配置地址/Token + 建根分类/根库位
 *   node inventree-sync.mjs push [台账.xlsx] [--dry-run]  # 推送物料/库位/容器/库存到 InvenTree
 *   node inventree-sync.mjs status                        # 查看配置与连通性
 *
 * 配置文件：inventree-sync.config.json（含 API Token，请勿外传/提交）
 * Excel 来源：416MES 网页「物料台账」页 →「导出 Excel 台账」（416MES_台账_YYYYMMDD.xlsx）
 *
 * 映射规则：
 *   物料台账 → Part（IPN=物料码）+ PartCategory（按大类）+ StockItem（数量/成本/库位）
 *   库位     → StockLocation 树（货架区 B-01-03-04 三级 / 工位区 W01-G02 两级）
 *   容器     → StockLocation（挂在其实际库位下，无库位则挂「容器区」）
 *   条码     → MAT:/LOC:/CTN: 前缀串写入 InvenTree barcode，扫码串不变、标签不用重打
 *   工单记录/NEC工单 → 不同步（库存仍以 416MES 扫码闭环为准，InvenTree 只做台账镜像）
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import XLSX from 'xlsx';

const DIR = path.normalize(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')));
const CONFIG_FILE = path.join(DIR, 'inventree-sync.config.json');

const MAT_CATEGORY = { GJ: '工具', HC: '耗材', PJ: '配件', DZ: '电子件' };
const ROOT_CATEGORY = '416MES物料';
const LOC_ROOTS = { shelf: '货架区', workstation: '工位区', container: '容器区' };

/* ---------- 配置 ---------- */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, ans => { rl.close(); res(ans.trim()); }));
}

/* ---------- InvenTree API 封装 ---------- */
async function api(cfg, method, urlPath, body, { dryRun = false } = {}) {
  const url = cfg.base_url.replace(/\/$/, '') + urlPath;
  if (dryRun && method !== 'GET') {
    console.log(`  [dry-run] ${method} ${urlPath} ${body ? JSON.stringify(body).slice(0, 120) : ''}`);
    return { dry: true };
  }
  const res = await fetch(url, {
    method,
    headers: { 'Authorization': 'Token ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    const m = text.match(/"(error|detail)"\s*:\s*"([^"]+)"/) || text.match(/"non_field_errors"\s*:\s*\[\s*"([^"]+)"/);
    if (m) msg = m[2] || m[1];
    throw new Error(`${method} ${urlPath} → HTTP ${res.status}: ${msg}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
// 列表查询（兼容分页），返回数组
async function apiList(cfg, urlPath, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const data = await api(cfg, 'GET', urlPath + (qs ? '?' + qs : ''));
  return Array.isArray(data) ? data : (data.results || []);
}

/* ---------- init ---------- */
async function init() {
  console.log('== 416MES → InvenTree 同步初始化 ==\n');
  const old = loadConfig() || {};
  // 非交互模式：优先读环境变量 INVENTREE_BASE_URL / INVENTREE_TOKEN
  const envUrl = process.env.INVENTREE_BASE_URL;
  const envToken = process.env.INVENTREE_TOKEN;
  const baseUrl = envUrl ?? await ask(`① InvenTree 地址（回车取 ${old.base_url || 'http://localhost:8001'}）：`);
  const token = envToken ?? await ask('② API Token（管理页 → Settings → Tokens，或 /api/user/token/）：');
  const cfg = {
    base_url: baseUrl || old.base_url || 'http://localhost:8001',
    token: token || old.token || ''
  };
  if (!cfg.token) { console.error('Token 不能为空'); process.exit(1); }

  console.log('\n③ 测试连接…');
  const info = await api(cfg, 'GET', '/api/');
  console.log(`   ✅ ${info.server} ${info.version}（API v${info.apiVersion}）`);

  console.log('④ 创建根结构（已存在则复用）…');
  cfg.root_category_id = (await ensureCategory(cfg, ROOT_CATEGORY, null)).pk;
  cfg.loc_root_ids = {};
  for (const [key, name] of Object.entries(LOC_ROOTS)) {
    cfg.loc_root_ids[key] = (await ensureLocation(cfg, name, null)).pk;
  }
  cfg.created_at = new Date().toLocaleString();
  saveConfig(cfg);
  console.log(`\n⑤ 配置已写入 inventree-sync.config.json`);
  console.log('   根分类 #' + cfg.root_category_id + '，根库位 ' + JSON.stringify(cfg.loc_root_ids));
  console.log('   下一步：416MES 导出 Excel 台账后运行  node inventree-sync.mjs push');
}

async function ensureCategory(cfg, name, parentId, { dryRun = false } = {}) {
  const list = await apiList(cfg, '/api/part/category/', { name });
  const hit = list.find(c => c.name === name && (c.parent ?? null) === parentId);
  if (hit) return { pk: hit.pk, created: false };
  const r = await api(cfg, 'POST', '/api/part/category/', { name, parent: parentId }, { dryRun });
  return { pk: r.pk ?? -1, created: true };
}
async function ensureLocation(cfg, name, parentId, { dryRun = false, description = '' } = {}) {
  const list = await apiList(cfg, '/api/stock/location/', { name });
  const hit = list.find(l => l.name === name && (l.parent ?? null) === parentId);
  if (hit) return { pk: hit.pk, created: false };
  const r = await api(cfg, 'POST', '/api/stock/location/', { name, parent: parentId, description }, { dryRun });
  return { pk: r.pk ?? -1, created: true };
}
async function ensureBarcode(cfg, barcode, link, { dryRun = false } = {}) {
  // link: { part: pk } / { stocklocation: pk }；重复绑定会返回“匹配现有项目”，视为幂等成功
  if (dryRun) { console.log(`  [dry-run] POST /api/barcode/link/ ${barcode} ${JSON.stringify(link)}`); return; }
  try {
    const r = await api(cfg, 'POST', '/api/barcode/link/', { barcode, ...link });
    if (r.error && !/匹配现有|already/i.test(String(r.error))) console.log(`  ⚠️ 条码 ${barcode}：${r.error}`);
  } catch (e) {
    if (!/匹配现有|already/i.test(e.message)) console.log(`  ⚠️ 条码 ${barcode}：${e.message.slice(0, 120)}`);
  }
}

/* ---------- 读取台账 Excel ---------- */
function readLedger(file) {
  const wb = XLSX.readFile(file);
  const rows = name => wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }) : [];
  return {
    materials: rows('物料台账').map(r => ({
      code: String(r['物料码']).trim(), name: String(r['名称']).trim(), spec: String(r['规格型号']).trim(),
      xy: String(r['闲鱼XY编号'] ?? '').trim(), loc: String(r['当前库位码']).trim(),
      container: String(r['容器码'] ?? '').trim(), qty: Number(r['库存数量']) || 0, cost: Number(r['成本']) || 0
    })).filter(m => m.code),
    locations: rows('库位').map(r => ({
      code: String(r['库位码']).trim(), kind: String(r['类型']).trim(), desc: String(r['说明'] ?? '').trim()
    })).filter(l => l.code),
    containers: rows('容器').map(r => ({
      code: String(r['容器码']).trim(), type: String(r['容器类型'] ?? '').trim(),
      spec: String(r['规格'] ?? '').trim(), loc: String(r['当前库位码'] ?? '').trim()
    })).filter(c => c.code)
  };
}

/* ---------- push ---------- */
async function push(file, dryRun) {
  const cfg = loadConfig();
  if (!cfg) { console.error('未找到 inventree-sync.config.json，请先运行：node inventree-sync.mjs init'); process.exit(1); }
  if (!cfg.root_category_id) { console.error('配置缺少根结构 ID，请重新运行：node inventree-sync.mjs init'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('找不到台账文件：' + file + '\n请先在 416MES 网页点「导出 Excel 台账」，并放到本目录。'); process.exit(1); }

  const { materials, locations, containers } = readLedger(file);
  console.log(`== 同步台账 ${path.basename(file)} → ${cfg.base_url}${dryRun ? '（dry-run）' : ''} ==`);
  console.log(`   物料 ${materials.length}，库位 ${locations.length}，容器 ${containers.length}\n`);

  const stat = { cat: 0, loc: 0, part: 0, stock: 0, barcode: 0, skip: 0 };
  const locIdByCode = {};   // 库位码/容器码 → InvenTree location pk
  const partIdByCode = {};  // 物料码 → part pk

  // 1) 库位树：货架 B-ss-ll-pp → 货架区/B-ss/B-ss-ll/B-ss-ll-pp；工位 Www-Ggg → 工位区/Www/Www-Ggg
  console.log('① 库位树');
  for (const l of [...locations].sort((a, b) => a.code.localeCompare(b.code))) {
    const parts = l.code.split('-');
    let parent, prefix;
    if (l.kind === '工位' || /^W\d/.test(l.code)) {
      parent = cfg.loc_root_ids.workstation; prefix = parts[0];
      const g1 = await ensureLocation(cfg, prefix, parent, { dryRun }); if (g1.created) stat.loc++;
      const leaf = await ensureLocation(cfg, l.code, g1.pk, { dryRun, description: l.desc }); if (leaf.created) stat.loc++;
      locIdByCode[l.code] = leaf.pk;
    } else {
      parent = cfg.loc_root_ids.shelf;
      let p = parent;
      for (let i = 1; i <= parts.length - 1; i++) {
        const sub = parts.slice(0, i + 1).join('-');
        const node = await ensureLocation(cfg, sub, p, { dryRun, description: i === parts.length - 1 ? l.desc : '' });
        if (node.created) stat.loc++;
        p = node.pk;
      }
      locIdByCode[l.code] = p;
    }
    await ensureBarcode(cfg, 'LOC:' + l.code, { stocklocation: locIdByCode[l.code] }, { dryRun });
    console.log(`  📍 ${l.code} → #${locIdByCode[l.code]}`);
  }

  // 2) 容器：挂在实际库位下，无库位则挂容器区
  console.log('② 容器');
  for (const c of containers) {
    const parent = locIdByCode[c.loc] || cfg.loc_root_ids.container;
    const node = await ensureLocation(cfg, c.code, parent, { dryRun, description: [c.type, c.spec].filter(Boolean).join(' ') });
    if (node.created) stat.loc++;
    const id = node.pk;
    locIdByCode[c.code] = id;
    await ensureBarcode(cfg, 'CTN:' + c.code, { stocklocation: id }, { dryRun });
    console.log(`  📦 ${c.code} → #${id}（${c.loc ? '位于 ' + c.loc : '容器区'}）`);
  }

  // 3) 物料 → Part（按大类建分类，IPN=物料码）
  console.log('③ 物料 Part');
  const catIds = {};
  for (const m of materials) {
    const prefix = m.code.split('-')[0];
    if (!catIds[prefix]) {
      const cat = await ensureCategory(cfg, MAT_CATEGORY[prefix] || prefix, cfg.root_category_id, { dryRun });
      catIds[prefix] = cat.pk;
      if (cat.created) stat.cat++;
    }
    const desc = [m.spec && '规格：' + m.spec, m.xy && '闲鱼XY：' + m.xy].filter(Boolean).join(' ｜ ');
    const found = await apiList(cfg, '/api/part/', { IPN: m.code });
    const hit = found.find(p => p.IPN === m.code);
    if (!hit) {
      const r = await api(cfg, 'POST', '/api/part/', {
        name: m.name, IPN: m.code, description: desc, category: catIds[prefix],
        purchaseable: true, salable: false, active: true
      }, { dryRun });
      partIdByCode[m.code] = r.pk ?? -1; stat.part++;
      console.log(`  🆕 ${m.code} ${m.name}`);
    } else {
      partIdByCode[m.code] = hit.pk;
      if (hit.name !== m.name || (hit.description || '') !== desc) {
        await api(cfg, 'PATCH', `/api/part/${hit.pk}/`, { name: m.name, description: desc, category: catIds[prefix] }, { dryRun });
        console.log(`  🔄 ${m.code} ${m.name}（属性更新）`);
      } else { stat.skip++; console.log(`  ⏭  ${m.code} 无变化`); }
    }
    await ensureBarcode(cfg, 'MAT:' + m.code, { part: partIdByCode[m.code] }, { dryRun });
  }

  // 4) 库存 → StockItem（数量以台账为准；库位优先容器）
  console.log('④ 库存 StockItem');
  for (const m of materials) {
    const partPk = partIdByCode[m.code];
    const locPk = locIdByCode[m.container] || locIdByCode[m.loc] || null;
    if (!partPk || partPk < 0) { console.log(`  ⚠️  ${m.code} 无 part（dry-run 下跳过库存）`); continue; }
    const found = await apiList(cfg, '/api/stock/', { part: partPk, location: locPk ?? '' });
    const hit = found.find(s => s.part === partPk && (s.location ?? null) === locPk);
    if (!hit) {
      if (m.qty > 0) {
        await api(cfg, 'POST', '/api/stock/', { part: partPk, location: locPk, quantity: m.qty, purchase_price: m.cost || undefined, status: 10 }, { dryRun });
        stat.stock++;
        console.log(`  🆕 ${m.code} ×${m.qty} @ ${m.container || m.loc || '(无库位)'}`);
      }
    } else if (Number(hit.quantity) !== m.qty) {
      await api(cfg, 'PATCH', `/api/stock/${hit.pk}/`, { quantity: m.qty }, { dryRun });
      stat.stock++;
      console.log(`  🔄 ${m.code} ${hit.quantity} → ${m.qty}`);
    } else { console.log(`  ⏭  ${m.code} 库存一致`); }
  }

  console.log(`\n完成：新建分类 ${stat.cat}，新建库位/容器 ${stat.loc}，新建物料 ${stat.part}，库存变更 ${stat.stock}，物料无变化 ${stat.skip}${dryRun ? '（均未实际执行）' : ''}`);
}

/* ---------- status ---------- */
async function status() {
  const cfg = loadConfig();
  if (!cfg) { console.log('尚未初始化。运行：node inventree-sync.mjs init'); return; }
  console.log('配置：');
  console.log('  InvenTree 地址：' + cfg.base_url);
  console.log('  根分类 #' + cfg.root_category_id + '，根库位 ' + JSON.stringify(cfg.loc_root_ids || {}));
  console.log('  初始化时间：' + (cfg.created_at || '—'));
  try {
    const info = await api(cfg, 'GET', '/api/');
    const [parts, locs, stock] = await Promise.all([
      apiList(cfg, '/api/part/', { limit: 1 }), apiList(cfg, '/api/stock/location/', { limit: 1 }), apiList(cfg, '/api/stock/', { limit: 1 })
    ]);
    const count = async p => (await api(cfg, 'GET', p + '?limit=1')).count ?? '?';
    console.log(`  连通性：✅ ${info.server} ${info.version}`);
    console.log(`  现有数据：Part ${await count('/api/part/')}，库位 ${await count('/api/stock/location/')}，库存条目 ${await count('/api/stock/')}`);
  } catch (e) { console.log('  连通性：❌ ' + e.message); }
}

/* ---------- 入口 ---------- */
const [, , cmd, ...rest] = process.argv;
const dryRun = rest.includes('--dry-run');
const fileArg = rest.find(a => !a.startsWith('--'));
// 未指定文件时，自动取目录下最新的 416MES_台账_*.xlsx
function latestLedger() {
  const files = fs.readdirSync(DIR).filter(f => /^416MES_台账_.*\.xlsx$/i.test(f)).sort();
  return files.length ? path.join(DIR, files[files.length - 1]) : null;
}
try {
  if (cmd === 'init') await init();
  else if (cmd === 'push') {
    const file = fileArg ? path.resolve(fileArg) : latestLedger();
    if (!file) { console.error('未指定台账文件，且目录下没有 416MES_台账_*.xlsx'); process.exit(1); }
    await push(file, dryRun);
  }
  else if (cmd === 'status') await status();
  else {
    console.log('用法：\n  node inventree-sync.mjs init\n  node inventree-sync.mjs push [416MES_台账_YYYYMMDD.xlsx] [--dry-run]\n  node inventree-sync.mjs status');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error('❌ ' + e.message); process.exit(1); }
