#!/usr/bin/env node
/**
 * feishu-server.mjs — 416MES 真源服务（路线 A：飞书多维表当真源）
 *
 * 用法：node feishu-server.mjs [端口=8000]
 * 替代 python -m http.server：静态文件 + /api/feishu/* 代理（lark-cli 鉴权只在服务端）
 *
 * API：
 *   GET  /api/feishu/ping          # 存活检测
 *   GET  /api/feishu/state         # 全量状态（8 表拉取组装，飞书为真源）
 *   POST /api/feishu/stock         # 库存变动直写 {matCode, qty, operator, type, reason, ref}
 *
 * 前端行为：页面启动时拉 /api/feishu/state（失败则退回 localStorage 离线模式）；
 * 库存写口（工单执行/盘点/手工调整）直写 /api/feishu/stock，失败进入本地队列待重试。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, MAPS, PUSH_ORDER, listAll, larkJson, T, N, pad, fmtLocal } from './feishu-sync.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || '8000', 10);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

/* 未配置 feishu-backend.config.json 时降级为纯静态服务（离线模式），不影响页面打开 */
let cfg = null;
try {
  if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
  console.warn('⚠️ feishu-backend.config.json 解析失败，按未配置处理：' + e.message);
}

/* ---------- 全量状态（飞书 → state） ---------- */
function pullState() {
  const state = { materials: [], locations: [], containers: [], members: [], items: [], manuals: [], workorders: [], transactions: [] };
  for (const key of PUSH_ORDER) {
    const map = MAPS[key], tableId = cfg.tables[map.table];
    if (!tableId) continue;
    const recs = listAll(cfg, tableId);
    state[key] = recs.map(r => map.down(r.fields)).filter(r => key === 'transactions' ? r.matCode : r.code);
  }
  state.transactions.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  return state;
}

/* ---------- 库存直写：改物料行 + 追加流水 ---------- */
function writeStock({ matCode, qty, delta, operator, type, reason, ref }) {
  const matMap = MAPS.materials, matTable = cfg.tables[matMap.table];
  // 1. 找物料记录 → 更新库存数量
  const rows = listAll(cfg, matTable);
  const hit = rows.find(r => T(r.fields['物料码']) === matCode);
  if (!hit) return { ok: false, error: '物料码 ' + matCode + ' 不在飞书台账（请先在网页端建档或 push）' };
  const rid = hit.record_id;
  const r1 = larkJson(['base', '+record-batch-update', '--base-token', cfg.base_token, '--table-id', matTable, '--as', 'user'],
    { update_records: { [rid]: { '库存数量': qty } } });
  if (r1 && r1.ok === false) return { ok: false, error: JSON.stringify(r1.error).slice(0, 200) };
  // 2. 追加库存流水（seq = 当前最大 + 1）
  const txnMap = MAPS.transactions, txnTable = cfg.tables[txnMap.table];
  const txns = listAll(cfg, txnTable);
  const maxSeq = txns.reduce((m, r) => Math.max(m, parseInt(T(r.fields['流水号']).replace('#', ''), 10) || 0), 0);
  const seq = maxSeq + 1;
  const fields = txnMap.up({
    seq, ts: Date.now(), time: fmtLocal(new Date()), operator: operator || '', type: type || '手工调整',
    matCode, delta: typeof delta === 'number' ? delta : 0, balance: qty, ref: ref || '', reason: reason || ''
  });
  const r2 = larkJson(['base', '+record-batch-create', '--base-token', cfg.base_token, '--table-id', txnTable, '--as', 'user'],
    { create_records: [fields] });
  if (r2 && r2.ok === false) return { ok: false, error: '库存已改但流水写入失败：' + JSON.stringify(r2.error).slice(0, 150) };
  return { ok: true, seq };
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (u.pathname === '/api/feishu/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, feishu: !!cfg }));
  }
  if (u.pathname === '/api/feishu/state' && req.method === 'GET') {
    if (!cfg) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: '未配置 feishu-backend.config.json' })); }
    try {
      const state = pullState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state, pulledAt: new Date().toLocaleString() }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message.slice(0, 300) }));
    }
    return;
  }
  if (u.pathname === '/api/feishu/stock' && req.method === 'POST') {
    if (!cfg) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: '未配置' })); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        if (!p.matCode || typeof p.qty !== 'number') throw new Error('缺 matCode/qty');
        const r = writeStock(p);
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message.slice(0, 300) }));
      }
    });
    return;
  }

  // 静态文件
  let fp = path.normalize(path.join(DIR, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)));
  if (!fp.startsWith(DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`416MES 真源服务已启动：http://localhost:${PORT}`);
  console.log(cfg ? `飞书真源：${cfg.url}` : '⚠️ 未找到 feishu-backend.config.json，仅静态服务（离线模式）');
});
