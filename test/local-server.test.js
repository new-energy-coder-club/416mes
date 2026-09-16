/**
 * 本地模式（feishu-server.mjs）—— 起真进程做端到端断言
 *
 * 这个文件的重点是**适配层**：本地服务现在直接 require ../api/feishu/*.js，
 * 与云端跑同一段代码，所以 handler 的业务逻辑不需要在这里重测
 * （那部分由 feishu-api.test.js / feishu-handlers.test.js 覆盖）。
 * 这里要证明的是新写的那层胶水对**每一条路由**都通：
 *   · req 的 method / url / query / 流式 body 都正确传给了 handler
 *   · res 的 setHeader / status / json / end 四个成员行为正确
 *   · 未实现的路由回 501 JSON（不是静态 404 HTML —— 前端要 r.json()）
 *   · 静态服务、路径穿越、`/%` 崩溃这几个老问题不复发
 *   · 缺凭证时如实失败，不假装可用
 *
 * 用 FEISHU_HOST 指向本地 mock，因此不需要任何真实凭证、不联网。
 * mock 只做「让 handler 的调用链能跑完」这一件事 —— 它的语义正确性由别的测试负责。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'feishu-server.mjs');

/* ---------- 最小飞书 mock：只让调用链跑完 ---------- */
function startFeishuMock() {
  const created = [], updated = [];
  /* 要按表存行、并**真的按 filter 过滤** —— 否则 writeStock 的幂等查重
     （按「操作ID」搜流水表）会在物料表那一行上误命中，整条账本路径就跑不成。
     这不是为了让测试好看：本地模式的价值就在于「与云端同一段代码，含幂等与账本」，
     所以 mock 必须让那条路径真的走完。 */
  let seq = 0;
  const tables = {
    tblMAT: [{ record_id: 'rec_mat_1', fields: { '物料码': 'A-1', '名称': '螺丝刀', '库存数量': 5 } }],
    tblTXN: [],
    tblWIP: []
  };
  const matchFilter = (filter, fields) => {
    if (!filter || !Array.isArray(filter.conditions) || !filter.conditions.length) return true;
    const one = c => {
      const v = fields[c.field_name];
      if (c.operator === 'is') return (c.value || []).some(x => String(x) === String(v == null ? '' : v));
      if (c.operator === 'isNotEmpty') return v != null && String(v) !== '';
      if (c.operator === 'contains') return String(v == null ? '' : v).includes(String((c.value || [])[0]));
      return false;
    };
    return filter.conjunction === 'or' ? filter.conditions.some(one) : filter.conditions.every(one);
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname.endsWith('/auth/v3/tenant_access_token/internal')) return send({ code: 0, tenant_access_token: 't-mock', expire: 7200 });
      const fm = u.pathname.match(/\/tables\/([^/]+)\/fields$/);
      if (fm) return send({ code: 0, data: { items: [
        { field_name: '物料码', type: 1 }, { field_name: '名称', type: 1 }, { field_name: '库存数量', type: 2 },
        { field_name: '流水号', type: 1 }, { field_name: '时间', type: 5 }, { field_name: '操作人', type: 1 },
        { field_name: '类型', type: 3, property: { options: [{ name: 'LL 领料' }, { name: '手工调整' }] } },
        { field_name: '变动', type: 2 }, { field_name: '余量', type: 2 },
        { field_name: '关联单', type: 1 }, { field_name: '原因/备注', type: 1 }, { field_name: '操作ID', type: 1 },
        { field_name: '工单号', type: 1 }, { field_name: '最后更新时间', type: 1002 }
      ] } });
      const rm = u.pathname.match(/\/tables\/([^/]+)\/records(\/[^/]+)?$/);
      if (!rm) return send({ code: 0, data: {} });
      const tid = rm[1];
      const rows = tables[tid] || (tables[tid] = []);
      const sub = (rm[2] || '').replace('/', '');
      const b = body ? JSON.parse(body) : {};
      if (!sub && req.method === 'GET') return send({ code: 0, data: { items: rows, total: rows.length, has_more: false } });
      if (sub === 'search') {
        const hit = rows.filter(r => matchFilter(b.filter, r.fields || {}));
        return send({ code: 0, data: { items: hit, total: hit.length, has_more: false } });
      }
      if (sub === 'batch_create') {
        const made = (b.records || []).map(r => { created.push(r.fields); const row = { record_id: 'rec_new_' + (++seq), fields: r.fields }; rows.push(row); return row; });
        return send({ code: 0, data: { records: made } });
      }
      if (sub === 'batch_update') {
        (b.records || []).forEach(r => {
          updated.push(r);
          const f = r.fields || {};
          // 兼容两种写法：按 record_id，或旧契约里的 { update_records: { id: fields } } 已在上层展开
          const row = rows.find(x => x.record_id === r.record_id);
          if (row) Object.assign(row.fields, f);
        });
        return send({ code: 0, data: { records: [] } });
      }
      if (sub === 'batch_delete') {
        const ids = b.records || [];
        for (const id of ids) { const i = rows.findIndex(x => x.record_id === id); if (i >= 0) rows.splice(i, 1); }
        return send({ code: 0, data: {} });
      }
      if (sub && req.method === 'GET') {
        const row = rows.find(x => x.record_id === sub);
        return row ? send({ code: 0, data: { record: row } }) : send({ code: 1254004, msg: 'record not found' });
      }
      return send({ code: 0, data: {} });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, created, updated, tables })));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, String(port)], {
    env: Object.assign({}, process.env, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', c => out += c);
  child.stderr.on('data', c => out += c);
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 15000;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('服务提前退出，code=' + child.exitCode + '\n' + out);
    try { const r = await fetch(base + '/api/feishu/ping'); if (r.status === 200) return { child, base, log: () => out }; } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 120));
  }
  child.kill('SIGKILL');
  throw new Error('服务 15s 内未起来：' + (lastErr && lastErr.message));
}

function envFor(mockPort) {
  return {
    FEISHU_HOST: 'http://127.0.0.1:' + mockPort,
    FEISHU_APP_ID: 'cli_mock', FEISHU_APP_SECRET: 'sec_mock', FEISHU_BASE_TOKEN: 'BASE_MOCK',
    FEISHU_TABLES: JSON.stringify({ materials: 'tblMAT', transactions: 'tblTXN', workorders: 'tblWIP' })
  };
}

/** 裸 HTTP GET：path 原样发出，不经 URL 归一化 */
function rawGet(base, rawPath) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method: 'GET' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ============================================================================
 * 一、配好凭证：每条路由都要通
 * ========================================================================== */

test('本地模式【P8 核心】每条路由都通，且与云端共用实现', async (t) => {
  const mock = await startFeishuMock();
  t.after(() => mock.server.close());
  const { child, base } = await startServer(envFor(mock.port));
  t.after(() => child.kill('SIGKILL'));

  await t.test('ping：不谎报，明确说走的是 tenant_access_token', async () => {
    const j = await (await fetch(base + '/api/feishu/ping')).json();
    assert.equal(j.ok, true);
    assert.equal(j.feishu, true, '凭证已配 → feishu 必须为 true');
    assert.equal(j.via, 'tenant_access_token', '与云端同一个实现，字段也要一致');
  });

  await t.test('schema：返回各表字段与类型', async () => {
    const j = await (await fetch(base + '/api/feishu/schema')).json();
    assert.equal(j.ok, true);
    assert.ok(j.tables && Array.isArray(j.tables.materials), 'schema 必须给出 tables.materials');
  });

  await t.test('state：全量状态（GET，走 list + listFields）', async () => {
    const j = await (await fetch(base + '/api/feishu/state')).json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.state.materials), 'state.materials 要是数组');
  });

  await t.test('nextcode：GET 取号（query 必须正确传给 handler）', async () => {
    const j = await (await fetch(base + '/api/feishu/nextcode?prefix=LL20260915&type=LL')).json();
    assert.equal(j.ok, true);
    assert.equal(j.prefix, 'LL20260915', 'req.url / req.query 必须传到 handler');
    assert.equal(typeof j.next, 'number');
  });

  await t.test('upsert：POST + JSON body 必须被 handler 读到并真的建记录', async () => {
    const r = await fetch(base + '/api/feishu/upsert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'materials', records: [{ code: 'ZZ-LOCAL-1', name: '本地建', qty: 3 }] })
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.ok, true);
    assert.equal(mock.created.length, 1, 'handler 必须真的把记录建到飞书（mock）上');
    assert.equal(mock.created[0]['物料码'], 'ZZ-LOCAL-1');
  });

  await t.test('stock：POST 走完整账本路径，操作ID 必须落库', async () => {
    const r = await fetch(base + '/api/feishu/stock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matCode: 'A-1', delta: -2, opId: 'local-stock-1' })
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.ok, true, '库存写入应成功（mock 允许）');
    assert.equal(typeof j.seq, 'number', '应分配流水号');
    assert.ok(mock.created.some(f => f['操作ID'] === 'local-stock-1'),
      '操作ID 必须落库 —— 旧本地实现把它丢了，超时重放就会重复记账');
  });

  await t.test('delete：POST 按业务键删除', async () => {
    const r = await fetch(base + '/api/feishu/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'materials', keys: ['ZZ-LOCAL-1'] })
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.ok, true);
  });

  await t.test('incremental：POST 探测返回 report', async () => {
    const r = await fetch(base + '/api/feishu/incremental', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'probe' })
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.ok, true);
    assert.ok(j.report, 'probe 必须返回 report');
  });

  await t.test('OPTIONS 预检返回 204（CORS）', async () => {
    const r = await fetch(base + '/api/feishu/stock', { method: 'OPTIONS' });
    assert.ok(r.status === 204 || r.status === 200, '预检应被 CORS 处理，实际 ' + r.status);
  });
});

/* ============================================================================
 * 二、没配凭证：必须如实失败，不假装可用
 * ========================================================================== */

test('本地模式【P8 重要】缺凭证时如实报错，不假装可用', async (t) => {
  const mock = await startFeishuMock();
  t.after(() => mock.server.close());
  const env = envFor(mock.port);
  delete env.FEISHU_APP_ID; delete env.FEISHU_APP_SECRET;
  const { child, base } = await startServer(env);
  t.after(() => child.kill('SIGKILL'));

  const ping = await (await fetch(base + '/api/feishu/ping')).json();
  assert.equal(ping.feishu, false, '缺凭证时 ping 必须说 feishu:false（旧实现只证明配置文件能解析）');

  const r = await fetch(base + '/api/feishu/stock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matCode: 'A-1', delta: -1, opId: 'x' })
  });
  const j = await r.json();
  assert.ok(r.status >= 400, '缺凭证时写接口必须失败，实际 ' + r.status);
  assert.match(JSON.stringify(j), /FEISHU_APP_ID|凭证|未配置/, '错误信息要点明缺的是凭证：' + JSON.stringify(j));
});

/* ============================================================================
 * 三、原有守护不能复发
 * ========================================================================== */

test('本地模式：未实现路由回 501 JSON，静态/穿越/坏 URL 的守护不复发', async (t) => {
  const mock = await startFeishuMock();
  t.after(() => mock.server.close());
  const { child, base } = await startServer(envFor(mock.port));
  t.after(() => child.kill('SIGKILL'));

  await t.test('未知 /api/feishu/* → 501 JSON（不是静态 404 HTML）', async () => {
    const r = await fetch(base + '/api/feishu/nope');
    assert.equal(r.status, 501);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const j = await r.json();
    assert.equal(j.code, 'LOCAL_ROUTE_UNSUPPORTED');
    assert.ok(Array.isArray(j.supported) && j.supported.length >= 10, '要把已实现的接口列出来');
  });

  await t.test('GET /% 不再打掉进程', async () => {
    const r = await fetch(base + '/%');
    assert.equal(r.status, 400);
    const again = await fetch(base + '/api/feishu/ping');
    assert.equal(again.status, 200, '一个坏 URL 之后服务必须仍然存活');
    assert.equal(child.exitCode, null, '进程不能退出');
  });

  await t.test('路径穿越被挡住（必须用裸 HTTP，fetch 会在客户端归一化掉 ..）', async () => {
    for (const raw of ['/../../etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const { status, body } = await rawGet(base, raw);
      assert.ok(status === 403 || status === 404, raw + ' 不该成功，实际 ' + status);
      assert.ok(!/root:x?:/.test(body), raw + ' 泄漏了 /etc/passwd');
    }
  });

  await t.test('静态服务仍然正常（这是本地模式存在的理由之一）', async () => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.match(await r.text(), /416MES/);
  });
});
