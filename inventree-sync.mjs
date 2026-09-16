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
/* 根库位按**种类**分，不按代码前缀猜。
   实测 416MES 的真实库位码（188 条）：
     货架   B-01-01-01 / C-01-03-04（4 段，170 条）
     工位   W01-G01（2 段，12 条，kind 就是「工位」）
     站点   X-11B-1403（3 段，1 条）
     模块区 M-01（2 段，5 条）
   原来的实现只认「工位 / 其它」两种：模块区和站点会被静默塞进**货架区**树的下面，
   于是 InvenTree 里「货架区」下多出 M-01~M-05 和 X-11B 这些根本不是货架的节点。
   现在按 kind 精确映射；kind 缺失时才退回代码前缀启发式（并提示）。 */
const LOC_ROOTS = { shelf: '货架区', workstation: '工位区', container: '容器区', zone: '模块区', site: '站点区' };
/** 416MES 的「类型」→ 根库位 key。缺省（kind 为空或未知）按货架处理。 */
const KIND_TO_ROOT = { '货架': 'shelf', '工位': 'workstation', '模块区': 'zone', '站点': 'site' };

/** 解析数字单元格：空 / 非数字 → null（绝不返回 0 冒充「数量就是 0」） */
function numOrNull(v) {
  const t = String(v == null ? '' : v).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

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
/** 单次请求超时（毫秒）。没有超时的话，对端黑洞会让 push 永久挂住。 */
const API_TIMEOUT_MS = Number(process.env.INVENTREE_TIMEOUT_MS) > 0 ? Number(process.env.INVENTREE_TIMEOUT_MS) : 20000;
/** 分页最多翻多少页（防御：服务端 next 指回自己时不能无限循环） */
const MAX_LIST_PAGES = 200;

async function api(cfg, method, urlPath, body, { dryRun = false } = {}) {
  const url = cfg.base_url.replace(/\/$/, '') + urlPath;
  if (dryRun && method !== 'GET') {
    console.log(`  [dry-run] ${method} ${urlPath} ${body ? JSON.stringify(body).slice(0, 120) : ''}`);
    return { dry: true };
  }
  const res = await fetch(url, {
    method,
    headers: { 'Authorization': 'Token ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
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
/**
 * 列表查询，**真的翻页**。
 *
 * 旧实现只发一次 GET，拿到第一页就返回 —— 而 InvenTree 的列表接口是 DRF 分页
 * （返回 {count, next, results}）。四处「存在性检查」全都只看第一页，于是远程集合
 * 超过一页时：已有 Part/库位/分类不在首页 → 判定「不存在」→ **重复创建**。
 * 最严重的是库存：同一 part+location 的 StockItem 会越攒越多，读数时重复累加，
 * 直接把库存算多。
 *
 * 翻页依据 next 字段（DRF 的标准做法），并带三个保险：
 *  · 绝对 URL / 相对路径都认；
 *  · 单页最多 MAX_LIST_PAGES 页，且 next 与上一页相同就停（防服务端自指死循环）；
 *  · 拿不到 next 但拿到了 count 时，按已收条数补 offset 继续（有些配置不给 next）。
 */
async function apiList(cfg, urlPath, params = {}) {
  const base = new URL(cfg.base_url.replace(/\/$/, '') + urlPath);
  Object.entries(params).forEach(([k, v]) => base.searchParams.set(k, String(v)));
  const out = [];
  let url = base.toString();
  let expected = null;
  const seen = new Set();
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    if (seen.has(url)) break;           // next 指回自己 → 停，别死循环
    seen.add(url);
    const data = await api(cfg, 'GET', url.replace(cfg.base_url.replace(/\/$/, ''), ''));
    if (Array.isArray(data)) {          // 非分页（裸数组）：一次就是全部
      out.push(...data);
      return out;
    }
    out.push(...(data.results || []));
    if (typeof data.count === 'number') expected = data.count;
    if (!data.next) {
      // 没有 next：如果 count 说明还有更多，就按 offset 继续要（兼容不返回 next 的配置）
      if (expected !== null && out.length < expected) {
        const u = new URL(url);
        u.searchParams.set('limit', u.searchParams.get('limit') || '100');
        u.searchParams.set('offset', String(out.length));
        url = u.toString();
        continue;
      }
      return out;
    }
    url = /^https?:/i.test(String(data.next))
      ? String(data.next)
      : new URL(String(data.next), cfg.base_url.replace(/\/$/, '') + urlPath).toString();
  }
  process.stderr.write('⚠️ ' + urlPath + ' 翻页超过 ' + MAX_LIST_PAGES + ' 页仍未结束，已停止（结果可能不全）\n');
  return out;
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
      container: String(r['容器码'] ?? '').trim(),
      /* 数量/成本**不能**写成 `Number(x) || 0`：空白或写错的单元格会变成 NaN，`|| 0`
         把它吞成 0，然后 push 时 PATCH `quantity: 0` 上去 —— 远端库存被静默清零。
         旧实现正是这样。这里保留 null 表示「这个格子没有有效数字」，由 push 决定跳过。 */
      qty: numOrNull(r['库存数量']), cost: numOrNull(r['成本'])
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
  const unknownKinds = new Set();
  const missingRoots = new Set();
  /** 取某个 kind 对应的根库位 pk；配置里没有就退回货架区并记下来（打印告警，不静默） */
  const rootFor = kind => {
    const key = KIND_TO_ROOT[kind];
    if (key && cfg.loc_root_ids && cfg.loc_root_ids[key]) return { pk: cfg.loc_root_ids[key], key };
    if (kind && !key) unknownKinds.add(kind);
    // 老配置里没有 zone/site 这两个根 → 退回货架区，但要明确告诉用户怎么修好
    if (key && !(cfg.loc_root_ids && cfg.loc_root_ids[key])) missingRoots.add(key);
    return { pk: cfg.loc_root_ids.shelf, key: 'shelf' };
  };
  for (const l of [...locations].sort((a, b) => a.code.localeCompare(b.code))) {
    const parts = l.code.split('-');
    let parent, prefix;
    const isWorkstation = l.kind === '工位' || (!l.kind && /^W\d/.test(l.code));
    if (isWorkstation) {
      parent = cfg.loc_root_ids.workstation; prefix = parts[0];
      const g1 = await ensureLocation(cfg, prefix, parent, { dryRun }); if (g1.created) stat.loc++;
      const leaf = await ensureLocation(cfg, l.code, g1.pk, { dryRun, description: l.desc }); if (leaf.created) stat.loc++;
      locIdByCode[l.code] = leaf.pk;
    } else {
      /* 按 kind 选根：货架 → 货架区；模块区 → 模块区；站点 → 站点区。
         只有「货架」和未知 kind 才进多级货架树（模块区/站点是一级节点，不该被拆成 B-ss 那种层级）。 */
      const root = rootFor(l.kind);
      parent = root.pk;
      if (root.key !== 'shelf') {
        const node = await ensureLocation(cfg, l.code, parent, { dryRun, description: l.desc });
        if (node.created) stat.loc++;
        locIdByCode[l.code] = node.pk;
      } else {
        let p = parent;
        for (let i = 1; i <= parts.length - 1; i++) {
          const sub = parts.slice(0, i + 1).join('-');
          const node = await ensureLocation(cfg, sub, p, { dryRun, description: i === parts.length - 1 ? l.desc : '' });
          if (node.created) stat.loc++;
          p = node.pk;
        }
        locIdByCode[l.code] = p;
      }
    }
    await ensureBarcode(cfg, 'LOC:' + l.code, { stocklocation: locIdByCode[l.code] }, { dryRun });
    console.log(`  📍 ${l.code} → #${locIdByCode[l.code]}`);
  }

  if (unknownKinds.size) {
    console.log('  ⚠️ 这些「类型」没有对应的根库位，已按货架处理：' + [...unknownKinds].join('、') +
      '\n     若要分开，请在 inventree-sync.mjs 的 KIND_TO_ROOT 里加映射并重跑 init。');
  }
  if (missingRoots.size) {
    console.log('  ⚠️ 配置里缺少根库位 ' + [...missingRoots].map(k => LOC_ROOTS[k]).join('、') +
      '，这些种类暂时挂在「货架区」下面。跑一次 `node inventree-sync.mjs init` 就会补上（已存在的根会复用，不会重建）。');
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

  stat.badQty = stat.badQty || 0;
  // 4) 库存 → StockItem（数量以台账为准；库位优先容器）
  console.log('④ 库存 StockItem');
  for (const m of materials) {
    const partPk = partIdByCode[m.code];
    const locPk = locIdByCode[m.container] || locIdByCode[m.loc] || null;
    if (!partPk || partPk < 0) { console.log(`  ⚠️  ${m.code} 无 part（dry-run 下跳过库存）`); continue; }
    /* 数量没解析出来（Excel 那格是空的或写错了）→ **跳过**，绝不推到远端。
       旧实现把非法值当 0，然后 PATCH quantity:0 —— 远端库存被静默清零。 */
    if (m.qty === null) { console.log(`  ⚠️  ${m.code} 台账里「库存数量」不是有效数字，已跳过（不改远端库存）`); stat.badQty++; continue; }
    const found = await apiList(cfg, '/api/stock/', { part: partPk, location: locPk ?? '' });
    const hit = found.find(s => s.part === partPk && (s.location ?? null) === locPk);
    if (!hit) {
      if (m.qty > 0) {
        await api(cfg, 'POST', '/api/stock/', { part: partPk, location: locPk, quantity: m.qty, purchase_price: m.cost == null ? undefined : m.cost, status: 10 }, { dryRun });
        stat.stock++;
        console.log(`  🆕 ${m.code} ×${m.qty} @ ${m.container || m.loc || '(无库位)'}`);
      }
    } else if (Number(hit.quantity) !== m.qty) {
      await api(cfg, 'PATCH', `/api/stock/${hit.pk}/`, { quantity: m.qty }, { dryRun });
      stat.stock++;
      console.log(`  🔄 ${m.code} ${hit.quantity} → ${m.qty}`);
    } else { console.log(`  ⏭  ${m.code} 库存一致`); }
  }

  console.log(`\n完成：新建分类 ${stat.cat}，新建库位/容器 ${stat.loc}，新建物料 ${stat.part}，库存变更 ${stat.stock}，物料无变化 ${stat.skip}` +
    (stat.badQty ? `，**跳过数量非法 ${stat.badQty} 条**（远端库存未改动，请回台账修数字）` : '') +
    (stat.barcodeFail ? `，条码关联失败 ${stat.barcodeFail} 条` : '') +
    (dryRun ? '（均未实际执行）' : ''));
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
