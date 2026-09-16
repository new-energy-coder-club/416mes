/**
 * feishu-server.mjs（本地模式）—— 起真进程做端到端断言
 *
 * 为什么必须起真进程：本地模式此前**零测试覆盖**，而它的三个故障都只有跑起来才暴露：
 *   1. `GET /%` → 未捕获的 URIError → Node ≥15 默认让进程退出，一个坏 URL 打掉整个服务
 *   2. 写接口 `/api/feishu/stock` 缺幂等键/流水号仲裁/账本写序 → 静默错账，现已停用（必须回 501）
 *   3. 未实现的 `/api/feishu/*` 落进静态分支 → 返回 404 **HTML**，前端 `r.json()` 抛一个
 *      看不懂的解析错误；必须是 501 + JSON，让队列里能看到真实原因
 *
 * 用 FEISHU_CONFIG 指向一个不存在的文件 → cfg=null → 纯静态模式，
 * 因此不需要 lark-cli、不碰真飞书、不产生任何生产写入。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'feishu-server.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, String(port)], {
    env: Object.assign({}, process.env, { FEISHU_CONFIG: path.join(__dirname, 'no-such-config.json') }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 15000;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('服务提前退出，code=' + child.exitCode);
    try {
      const r = await fetch(base + '/api/feishu/ping');
      if (r.ok) return { child, base };
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 120));
  }
  child.kill('SIGKILL');
  throw new Error('服务 15s 内未起来：' + (lastErr && lastErr.message));
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

test('本地模式：只读、崩溃免疫、未实现路由回 JSON', async (t) => {
  const { child, base } = await startServer();
  t.after(() => child.kill('SIGKILL'));

  await t.test('ping 明确标注只读且不再谎报飞书可用', async () => {
    const j = await (await fetch(base + '/api/feishu/ping')).json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.writeEnabled, false, 'ping 必须声明写入已停用');
    assert.strictEqual(j.mode, 'local-readonly');
    assert.strictEqual(j.feishu, false, '没有配置文件时 feishu 必须是 false');
  });

  await t.test('/stock 必须 501（不再直写、不再造成半提交）', async () => {
    const r = await fetch(base + '/api/feishu/stock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matCode: 'X', qty: 1, opId: 'o1' })
    });
    assert.strictEqual(r.status, 501);
    const j = await r.json();
    assert.strictEqual(j.code, 'LOCAL_WRITE_DISABLED');
    assert.match(j.hint, /适配层|云端/);
  });

  await t.test('未实现的 /api/feishu/* 回 501 JSON，而不是静态 404 HTML', async () => {
    for (const p of ['/api/feishu/upsert', '/api/feishu/incremental', '/api/feishu/nextcode', '/api/feishu/reconcile']) {
      const r = await fetch(base + p);
      assert.strictEqual(r.status, 501, p + ' 应回 501');
      assert.match(r.headers.get('content-type') || '', /application\/json/, p + ' 必须是 JSON');
      const j = await r.json();
      assert.strictEqual(j.code, 'LOCAL_ROUTE_UNSUPPORTED');
      assert.strictEqual(j.ok, false);
    }
  });

  await t.test('没配置时 /state 回 503 JSON', async () => {
    const r = await fetch(base + '/api/feishu/state');
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await r.json()).ok, false);
  });

  await t.test('GET /% 不再打掉进程（回归：未捕获 URIError）', async () => {
    const r = await fetch(base + '/%');
    assert.strictEqual(r.status, 400);
    // 关键断言：服务还活着
    const again = await fetch(base + '/api/feishu/ping');
    assert.strictEqual(again.status, 200, '一个坏 URL 之后服务必须仍然存活');
    assert.strictEqual(child.exitCode, null, '进程不能退出');
  });

  await t.test('路径穿越被挡住（回归：startsWith(DIR) 前缀守卫不严）', async () => {
    // 必须用裸 http 请求：fetch/URL 会在客户端就把 /../ 归一化掉，
    // 于是「测试通过」其实只证明了客户端的行为，服务器根本没收到 .. —— 这个坑我踩过一次。
    for (const raw of ['/../../etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/..%5c..%5cetc%5cpasswd']) {
      const { status, body } = await rawGet(base, raw);
      assert.ok(status === 403 || status === 404, raw + ' 不该成功，实际 ' + status);
      assert.ok(!/root:x?:/.test(body), raw + ' 泄漏了 /etc/passwd');
    }
  });

  await t.test('静态服务仍然正常（这是本地模式存在的唯一理由）', async () => {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.match(await r.text(), /416MES/);
  });
});
