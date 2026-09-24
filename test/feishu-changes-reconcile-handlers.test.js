/**
 * TASK-09 M8：为 api/feishu/changes.js 与 api/feishu/reconcile.js 补 handler 级契约测试。
 *
 * 背景：TASK-07 B 维度审查发现这两个端点**零直接测试**（`grep -rl "feishu/changes\|feishu/reconcile"
 * test/` → 0 命中）。它们分别是「增量拉取入口」与「数据对账入口」——handler 层的参数校验、
 * 方法校验、同源标记、错误包装一旦写窄，前端整条路会断且只在真机暴露。
 *
 * 做法与 test/feishu-handlers.test.js 同构：起最小 mock 飞书，不打真实网络、不需凭据。
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

/* ---------- 最小 mock 飞书：只实现这两个 handler 用到的接口 ----------
   changes → probeChangeDetection / dumpSearchShape（records/search + fields）
   reconcile → reconcile（拉 8 张表 + fields + search）                          */
function startMock(opts) {
  const o = opts || {};
  const http = require('node:http');
  /* 表 id → 字段清单（reconcile 要 8 张表都到场，否则抛 INCOMPLETE） */
  const fieldsByTable = {
    tblMAT: [{ name: '物料码' }, { name: '库存数量' }, { name: '最后更新时间' }],
    tblLOC: [{ name: '库位码' }, { name: '状态' }],
    tblCTN: [{ name: '容器码' }, { name: '当前库位码' }, { name: '状态' }, { name: '业务版本' }],
    tblITEM: [{ name: '物品码' }, { name: '状态' }, { name: '业务版本' }, { name: '最后操作ID' }],
    tblMEM: [{ name: '编号' }, { name: '姓名' }],
    txlMANUAL: [{ name: '编号' }, { name: '名称' }],
    tblWIP: [{ name: '工单号' }, { name: '类型', options: ['LL 领料'] }],
    tblTXN: [{ name: '流水号' }, { name: '时间' }],
    tblOP: [{ name: '操作ID' }, { name: '处理阶段' }]
  };
  const rowsByTable = {
    tblMAT: [{ '物料码': 'A-1', '库存数量': 10 }],
    tblLOC: [{ '库位码': 'L-1', '状态': 'active' }],
    tblCTN: [], tblITEM: [], tblMEM: [], txlMANUAL: [],
    tblWIP: [], tblTXN: [], tblOP: []
  };
  let fieldCalls = 0, searchCalls = 0, listCalls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = (obj, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url.pathname.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 't' });
      const fm = url.pathname.match(/\/tables\/([^/]+)\/fields$/);
      if (fm) {
        fieldCalls++;
        const id = url.searchParams.get('page_token') ? null : fm[1];
        const items = (fieldsByTable[fm[1]] || []).map(f => ({ field_name: f.name, type: 1 }));
        // reconcile 走 listFieldsCached，需要分页形状；probeChangeDetection 只读一次
        if (url.searchParams.get('page_token') !== null) return json({ code: 0, data: { items: [], has_more: false } });
        return json({ code: 0, data: { items, has_more: false } });
        void id;
      }
      const m = url.pathname.match(/\/tables\/([^/]+)\/records(\/[^/]+)?$/);
      if (!m) return json({ code: 404, msg: 'not found' });
      const tableId = m[1];
      const sub = (m[2] || '').replace('/', '');
      if (sub === 'search') {
        searchCalls++;
        const rows = rowsByTable[tableId] || [];
        return json({ code: 0, data: { items: rows.map((r, i) => ({ record_id: 'rec_' + i, fields: r })), has_more: false, page_token: '' } });
      }
      if (!sub) {
        listCalls++;
        const rows = rowsByTable[tableId] || [];
        return json({ code: 0, data: { items: rows.map((r, i) => ({ record_id: 'rec_' + i, fields: r })), has_more: false, page_token: '' } });
      }
      return json({ code: 1254004, msg: 'not found' });
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, origin: 'http://127.0.0.1:' + server.address().port,
      stats: () => ({ fieldCalls, searchCalls, listCalls }),
      failNext: () => { o.__fail = true; }
    }));
  });
}

/* ---------- 把 vercel handler 载入一个带 req/res 桩的上下文 ---------- */
/* handler 在 api/feishu/ 下，require('../../lib/feishu-api.js') 必须相对**它自己**解析；
   且 feishu-api.js 在**模块加载时**就读 FEISHU_APP_ID/SECRET/HOST —— 必须先在
   process.env 摆好再 require（与 test/feishu-handlers.test.js:127-131 同套做法）。 */
/* feishu-api.js 在模块加载时就读完 FEISHU_* 环境变量，
   因此每个 origin 都必须清掉 require 缓存后重新加载，
   否则错误路径会拿到常软路径的旧 host。 */
/* 错误路径要求僌口不可达：用一个肯定连不上的 port（需在 loadHandler 之前定义） */
const DEAD_ORIGIN = 'http://127.0.0.1:1';

const HANDLER_CACHE = new Map();
function loadHandler(relPath, mockOrigin) {
  const key = relPath + '@' + mockOrigin;
  if (HANDLER_CACHE.has(key)) return HANDLER_CACHE.get(key);
  process.env.FEISHU_HOST = mockOrigin;
  process.env.FEISHU_APP_ID = 'cli_fake';
  process.env.FEISHU_APP_SECRET = 'secret_fake';
  process.env.FEISHU_BASE_TOKEN = 'BASE_FAKE';
  const abs = path.join(ROOT, relPath);
  /* 清掉 handler 与它依赖的 feishu-api（只清本项目的，勿动 node 内置） */
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(ROOT) && (k.endsWith('feishu-api.js') || k === abs)) delete require.cache[k];
  }
  const mod = require(abs);
  HANDLER_CACHE.set(key, mod);
  return mod;
}

function fakeRes() {
  return {
    _code: 200, _body: null, _headers: {},
    status(c) { this._code = c; return this; },
    json(b) { this._body = b; return this; },
    setHeader(k, v) { this._headers[k] = v; }, getHeader(k) { return this._headers[k]; },
    end() {}, writeHead() { return this; }
  };
}
/* 请求覆照真实 http.IncomingMessage 的最小面：
   vercel handler 里的 readBody(req) 用 req.on('data'/'end') 读身体，
   assertSameOrigin 读 req.headers，方法校验读 req.method，查询参读 req.query。 */
function fakeReq(method, body, headers, query) {
  const h = Object.assign({}, headers || {});
  const emitter = new (require('node:events').EventEmitter)();
  emitter.method = method;
  emitter.headers = h;
  emitter.query = query || {};
  setImmediate(() => {
    if (body) emitter.emit('data', Buffer.from(body));
    emitter.emit('end');
  });
  return emitter;
}
const SAME_ORIGIN_HEADER = { 'x-416mes-same-origin': '1' };

/* ===================== changes.js ===================== */

test('changes：GET 正常路径 → 200 + report.tables 覆盖 8 张表', async () => {
  const mock = await startMock();
  const handler = loadHandler('api/feishu/changes.js', mock.origin);
  const res = fakeRes();
  await handler(fakeReq('GET', '', {}, {}), res);
  assert.equal(res._code, 200, '应 200');
  assert.ok(res._body.report && res._body.report.tables, '应带 report.tables');
  const t = res._body.report.tables;
  for (const k of ['materials', 'locations', 'containers', 'items', 'members', 'workorders', 'transactions', 'manuals']) {
    assert.ok(t[k], 'report.tables 缺表：' + k);
  }
  await new Promise(r => mock.server.close(r));
});

test('changes：POST 方法不允许 → 405', async () => {
  const mock = await startMock();
  const handler = loadHandler('api/feishu/changes.js', mock.origin);
  const res = fakeRes();
  await handler(fakeReq('POST', '', {}, {}), res);
  assert.equal(res._code, 405, 'POST 必须 405');
  await new Promise(r => mock.server.close(r));
});

test('changes：仓储抛错 → 502（不把内部错误透成 500/200）', async () => {
  const mock = await startMock();
  const handler = loadHandler('api/feishu/changes.js', DEAD_ORIGIN);   // 连不上的地址
  const res = fakeRes();
  await handler(fakeReq('GET', '', {}, {}), res);
  assert.equal(res._code, 502, '仓储不可达应 502');
  assert.equal(res._body.ok, false, '失败时 ok=false');
  await new Promise(r => mock.server.close(r));
});

/* ===================== reconcile.js ===================== */

test('reconcile：POST + 同源标记 + 正常 state → 200 + report', async () => {
  const mock = await startMock();
  const handler = loadHandler('api/feishu/reconcile.js', mock.origin);
  const res = fakeRes();
  await handler(fakeReq('POST', JSON.stringify({ state: { materials: [{ code: 'A-1' }] } }), SAME_ORIGIN_HEADER, {}), res);
  if(res._code!==200) console.log('DIAG reconcile:', JSON.stringify(res._body).slice(0,260));
  assert.equal(res._code, 200, '应 200');
  assert.ok(res._body.report.tables, 'report 应有 tables');
  await new Promise(r => mock.server.close(r));
});

test('reconcile：GET 方法不允许 → 405', async () => {
  const mock = await startMock();
  const handler = loadHandler('api/feishu/reconcile.js', mock.origin);
  const res = fakeRes();
  await handler(fakeReq('GET', '', SAME_ORIGIN_HEADER, {}), res);
  assert.equal(res._code, 405, 'GET 必须 405');
  await new Promise(r => mock.server.close(r));
});

test('reconcile：缺同源标记 → 被 assertSameOrigin 拦（不得 200）', async () => {
  const mock = await startMock();
  const handler = loadHandler('api/feishu/reconcile.js', mock.origin);
  const res = fakeRes();
  await handler(fakeReq('POST', JSON.stringify({ state: {} }), { origin: 'https://evil.example' }, {}), res);
  assert.notEqual(res._code, 200, '无同源标记不得放行');
  assert.equal(res._body.ok, false, '被拦时 ok=false');
  await new Promise(r => mock.server.close(r));
});

test('reconcile：仓储抛错 → 502', async () => {
  const mock = await startMock();
  const handler = loadHandler('api/feishu/reconcile.js', DEAD_ORIGIN);
  const res = fakeRes();
  await handler(fakeReq('POST', JSON.stringify({ state: {} }), SAME_ORIGIN_HEADER, {}), res);
  assert.equal(res._code, 502, '仓储不可达应 502');
  await new Promise(r => mock.server.close(r));
});

test('reconcile：空 body / 空 state 也应走到 200（对账允许本地为空）', async () => {
  const mock = await startMock();
  const handler = loadHandler('api/feishu/reconcile.js', mock.origin);
  const res = fakeRes();
  await handler(fakeReq('POST', '', SAME_ORIGIN_HEADER, {}), res);
  assert.equal(res._code, 200, '空 state 应正常出具报告');
  await new Promise(r => mock.server.close(r));
});
