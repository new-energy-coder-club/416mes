#!/usr/bin/env node
/**
 * feishu-server.mjs — 416MES 本地服务（静态文件 + 与云端**同一份**的 /api/feishu/* 实现）
 *
 * 用法：node feishu-server.mjs [端口=8000]
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 这个文件曾经是「同源优先的 /state 读 + /stock 直写」两个半接口，与云端**不共享实现**：
 * 它自己写了一套 writeStock，实测有 8 处与 lib/feishu-api.js 的行为分歧
 *   · 丢弃前端一定会上送的 opId（操作ID）→ 超时重放就重复记账
 *   · 把 qty 当绝对值直接覆盖「库存数量」，流水「变动」却写 0 → 破坏账本反推的期初
 *   · 先改库存再写流水 → 流水失败即半提交
 *   · 流水号用「全表 max+1」→ 两台客户端并发必撞号（没有云端的 16 轮仲裁）
 *   · 拒绝 delta-only 请求、没有幂等查重、没有 dryRun/timing/dropped 契约字段
 *   · 每次写入全表扫 + 同步 execFileSync → 阻塞整个进程
 * 而且只实现了 3 条路由，前端依赖的 upsert/delete/incremental/nextcode/reconcile/schema
 * 全 404 → 台账/人员/工单的编辑全部进队列且永不成功。
 *
 * 现在改成**薄适配层**：把 Node 的 http 请求适配成 Vercel handler 认的 (req, res)，
 * 然后直接 require ../api/feishu/*.js —— 本地与云端跑的是**同一段代码**，
 * 语义不可能再漂移。这是唯一能同时满足「局域网可用」与「可信」的做法。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 需要飞书**应用凭证**：环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET
 *   （与 Vercel 上那两个变量同一套；应用需有该多维表格的读写权限）。
 *   缺凭证时服务照常启动，但写接口会明确失败并在 /api/feishu/ping 里如实标注 ——
 *   绝不假装可用。
 *
 * 路由（与 api/feishu/ 一一对应，全部共用云端实现）：
 *   GET  /api/feishu/ping         存活 + 凭证状态
 *   GET  /api/feishu/state        全量状态（8 表）
 *   GET  /api/feishu/schema       表结构
 *   GET  /api/feishu/nextcode     工单取号（只读）
 *   POST /api/feishu/stock        库存直写（幂等/账本/仲裁）
 *   POST /api/feishu/upsert       按业务键新建或更新
 *   POST /api/feishu/delete       按业务键删除
 *   POST /api/feishu/incremental  增量协议（probe/pull/census/sync/bench）
 *   POST /api/feishu/changes      变更探测
 *   POST /api/feishu/reconcile    一致性核对（只读）
 *   其它 /api/feishu/*            → 501 JSON（不是静态 404 HTML：前端要 r.json()）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || '8000', 10);

/* 路由 → 云端 handler。require 在**模块加载时**发生，所以 FEISHU_HOST / FEISHU_BASE_TOKEN /
   FEISHU_TABLES 这些「模块级读取」的环境变量必须在启动本进程前设好
   （应用凭证是调用时才读的，可以后配）。 */
const ROUTES = {
  '/api/feishu/ping': './api/feishu/ping.js',
  '/api/feishu/state': './api/feishu/state.js',
  '/api/feishu/schema': './api/feishu/schema.js',
  '/api/feishu/nextcode': './api/feishu/nextcode.js',
  '/api/feishu/stock': './api/feishu/stock.js',
  '/api/feishu/upsert': './api/feishu/upsert.js',
  '/api/feishu/delete': './api/feishu/delete.js',
  '/api/feishu/incremental': './api/feishu/incremental.js',
  '/api/feishu/changes': './api/feishu/changes.js',
  '/api/feishu/reconcile': './api/feishu/reconcile.js'
};
const handlers = {};
for (const [route, mod] of Object.entries(ROUTES)) {
  try { handlers[route] = require(mod); }
  catch (e) { console.error('⚠️ 加载 ' + route + ' 的处理器失败：' + e.message); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.css': 'text/css', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

/**
 * 把 Node 的 ServerResponse 适配成 Vercel handler 认的 res。
 * handler 用到的全部成员就是这四个（已按 api/feishu/*.js 的实际用法逐一核对）：
 *   setHeader / status(链式) / json / end
 */
function adaptRes(nodeRes) {
  const res = {
    statusCode: 200,
    setHeader(k, v) { nodeRes.setHeader(k, v); return res; },
    status(code) { res.statusCode = code; return res; },
    json(obj) {
      if (!nodeRes.headersSent) nodeRes.setHeader('Content-Type', 'application/json; charset=utf-8');
      nodeRes.statusCode = res.statusCode;
      nodeRes.end(JSON.stringify(obj));
      return res;
    },
    end(body) {
      nodeRes.statusCode = res.statusCode;
      nodeRes.end(body === undefined ? undefined : String(body));
      return res;
    }
  };
  return res;
}

/** 把 Node 的 IncomingMessage 适配成 Vercel handler 认的 req（补上 Vercel 才有的 req.query） */
function adaptReq(req, pathname) {
  if (!req.query) {
    try { req.query = Object.fromEntries(new URL(req.url, 'http://x').searchParams); }
    catch (_) { req.query = {}; }
  }
  return req;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); }
  catch (e) { return json(res, 400, { ok: false, error: '非法 URL' }); }

  // 与 vercel.json / setCors 保持一致，让局域网里其它口径（含 file://）也能用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS' && !ROUTES[u.pathname]) { res.writeHead(204); return res.end(); }

  const handler = handlers[u.pathname];
  if (handler) {
    try {
      // 直接调用**云端那一个** handler；req 本身是流，readBody(req) 能正常工作
      await handler(adaptReq(req, u.pathname), adaptRes(res));
    } catch (e) {
      if (!res.headersSent && !res.writableEnded) {
        json(res, 500, { ok: false, error: '本地服务调用处理器失败：' + String((e && e.message) || e) });
      }
    }
    return;
  }
  if (u.pathname.startsWith('/api/feishu/')) {
    return json(res, 501, {
      ok: false, code: 'LOCAL_ROUTE_UNSUPPORTED',
      error: '没有这个接口：' + u.pathname,
      supported: Object.keys(ROUTES),
      hint: '本地服务与云端共用 api/feishu/* 的实现；上面这份是全部已实现的接口。'
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

/** 启动前把「缺什么」一次说清楚，而不是等用户点了写入才失败 */
function preflight() {
  const hasCred = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
  const missing = [];
  if (!hasCred) missing.push('FEISHU_APP_ID / FEISHU_APP_SECRET（飞书应用凭证，与 Vercel 上那两个同一套）');
  if (!Object.keys(handlers).length) missing.push('api/feishu/* 处理器（一个都没加载成功，见上面的告警）');
  return { hasCred, ready: hasCred && Object.keys(handlers).length > 0, missing };
}

server.listen(PORT, '0.0.0.0', () => {
  const pf = preflight();
  console.log(`416MES 本地服务已启动：http://localhost:${PORT}`);
  console.log(`已挂载接口 ${Object.keys(handlers).length}/${Object.keys(ROUTES).length} 条（与云端共用 api/feishu/* 的实现）`);
  if (pf.ready) {
    console.log('✅ 飞书应用凭证已配置，读写可用。');
  } else {
    console.log('⚠️ 还不能读写飞书，缺少：');
    pf.missing.forEach(m => console.log('   · ' + m));
    console.log('   （界面照常打开，只是同步会失败 —— 不会假装成功）');
  }
});
