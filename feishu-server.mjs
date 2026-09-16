#!/usr/bin/env node
/**
 * feishu-server.mjs — 416MES 本地静态服务 + 飞书**只读**接口
 *
 * 用法：node feishu-server.mjs [端口=8000]
 * 替代 python -m http.server：静态文件 + /api/feishu/* 只读代理（lark-cli 鉴权只在服务端）
 *
 * ⚠️ 本地模式**不再提供写入能力**（2026-09-16 起）。
 *
 * 为什么砍掉写入：本文件原来的 writeStock 是独立于云端的一套实现，实测有 8 处与
 * lib/feishu-api.js 的行为分歧，每一条都会造成**静默错账**：
 *   1. 丢弃前端一定会上送的 opId（操作ID）→ 请求超时重放就重复记账
 *   2. 把 qty 当绝对值直接覆盖「库存数量」，流水「变动」却写 0 → 破坏账本反推的期初
 *   3. 先改库存再写流水 → 流水失败即半提交（原代码自己都在返回里承认了）
 *   4. 流水号用「全表 max+1」→ 两台客户端并发必撞号，没有云端的 16 轮仲裁
 *   5. 拒绝 delta-only 请求（云端允许，且多设备并发本来就该给 delta）
 *   6. 没有操作ID 查重（幂等）
 *   7. 没有 dryRun / timing / dropped / warning 等契约字段
 *   8. 每次写入都全表拉取，且走同步 execFileSync → 阻塞整个 Node 进程
 *
 * 结论：局域网写操作一律走云端后端。要恢复局域网离线**写入**，唯一正确的做法是把
 * 本文件重写成 lib/feishu-api.js 的薄 HTTP 适配层（一份实现，本地/云端同语义），
 * 而不是把下面那套自研写入再放出来。
 *
 * API：
 *   GET  /api/feishu/ping          # 存活检测（只说明服务在，不代表飞书可用）
 *   GET  /api/feishu/state         # 全量状态（8 表拉取组装，飞书为真源）—— 只读
 *   POST /api/feishu/stock         # 501 已停用，见上
 *   其它 /api/feishu/*             # 501 未实现（不是静态 404：前端会 r.json()，
 *                                  #     返回 HTML 会让它拿到一个看不懂的解析错误）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, MAPS, PUSH_ORDER, listAll } from './feishu-sync.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || '8000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.css': 'text/css', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

/* 未配置 feishu-backend.config.json 时降级为纯静态服务（离线模式），不影响页面打开 */
let cfg = null;
try {
  if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
  console.warn('⚠️ feishu-backend.config.json 解析失败，按未配置处理：' + e.message);
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const WRITE_DISABLED = {
  ok: false,
  code: 'LOCAL_WRITE_DISABLED',
  error: '本地模式已停用写入接口（/api/feishu/stock 不再可用）',
  hint: '本地服务只提供「读」与「诊断」。原自研写入缺幂等键、缺流水号仲裁、且先改库存后写流水，会造成「库存改了、账本没记」的静默错账。请让写操作走云端后端；局域网离线写入需要先把本地服务重写成 lib/feishu-api.js 的适配层。'
};

/* ---------- 全量状态（飞书 → state）—— 只读 ---------- */
function pullState() {
  const state = { materials: [], locations: [], containers: [], members: [], items: [], manuals: [], workorders: [], transactions: [] };
  for (const key of PUSH_ORDER) {
    const map = MAPS[key], tableId = cfg.tables[map.table];
    if (!tableId) continue;
    const recs = listAll(cfg, tableId);
    // 流水的判存条件必须与 lib/feishu-api.js:398 一致（matCode 或 seq 有其一即保留）。
    // 只看 matCode 会把「有流水号但没物料码」的行静默丢掉 —— 对账凭据少一条都是大事。
    state[key] = recs.map(r => map.down(r.fields))
      .filter(r => key === 'transactions' ? (r.matCode || r.seq != null) : r.code);
  }
  state.transactions.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  return state;
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://x');
  } catch (e) {
    return json(res, 400, { ok: false, error: '非法 URL' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (u.pathname === '/api/feishu/ping') {
    // 只说「服务在」。不要拿它证明飞书可用：以前这里回 feishu:!!cfg，
    // 而 cfg 只是「配置文件能解析」—— lark-cli 不在 PATH 时照样回 true，
    // README 的验收步骤会被这一条骗过去。
    return json(res, 200, { ok: true, mode: 'local-readonly', feishu: !!cfg, writeEnabled: false });
  }
  if (u.pathname === '/api/feishu/state' && req.method === 'GET') {
    if (!cfg) return json(res, 503, { ok: false, error: '未配置 feishu-backend.config.json' });
    try {
      const state = pullState();
      return json(res, 200, { ok: true, state, pulledAt: new Date().toLocaleString(), readOnly: true });
    } catch (e) {
      return json(res, 502, { ok: false, error: String((e && e.message) || e).slice(0, 300) });
    }
  }
  if (u.pathname === '/api/feishu/stock') {
    return json(res, 501, WRITE_DISABLED);
  }
  if (u.pathname.startsWith('/api/feishu/')) {
    return json(res, 501, {
      ok: false,
      code: 'LOCAL_ROUTE_UNSUPPORTED',
      error: '本地模式未实现该接口：' + u.pathname,
      supported: ['/api/feishu/ping', '/api/feishu/state'],
      hint: '本地模式缺 upsert/delete/incremental/nextcode/reconcile/schema/changes。请走云端后端，或先把本地服务重写成 lib/feishu-api.js 的适配层。'
    });
  }

  // 静态文件
  let decoded;
  try {
    decoded = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
  } catch (e) {
    // decodeURIComponent('%') 会抛 URIError。以前没有 try —— Node ≥15 默认把未捕获的
    // promise rejection 变成进程退出，一个 `GET /%` 就能把整个服务打掉。
    return json(res, 400, { ok: false, error: '路径编码非法' });
  }
  const fp = path.resolve(DIR, '.' + path.posix.normalize(decoded));
  // 前缀守卫必须比对「DIR + 分隔符」：只写 startsWith(DIR) 时，兄弟目录
  // /srv/416mes-evil 也会被判为在 /srv/416mes 之内。
  if (fp !== DIR && !fp.startsWith(DIR + path.sep)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`416MES 本地服务已启动：http://localhost:${PORT}`);
  console.log(cfg ? `飞书只读真源：${cfg.url}` : '⚠️ 未找到 feishu-backend.config.json，仅静态服务（离线模式）');
  console.log('⚠️ 本地模式为**只读**：/api/feishu/stock 与其它写接口一律返回 501。写入请走云端后端。');
});
