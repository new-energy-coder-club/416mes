'use strict';
/* 容器短链 v3.13.35 · api/ctn-link/[code].js 端点 + 双路由 pins
 * 与 test/item-link-endpoint.test.js 平行同构（物品侧曾因只配小写生产 404，双路由从此钉死）。
 */
const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/ctn-link/[code].js');
const C = require('../lib/ctn-link');

function fakeRes() {
  const r = { headers: {}, statusCode: 200, body: null,
    status(n) { r.statusCode = n; return r; },
    setHeader(k, v) { r.headers[k] = v; return r; },
    end(b) { r.body = b === undefined ? undefined : String(b); return r; } };
  return r;
}

test('/c/ 短链转跳：本地解码 302 到容器详情深链，不依赖飞书', async () => {
  const short = C.fromCtnCode('A4SH-001');
  const res = fakeRes();
  await handler({ method: 'GET', query: { code: short } }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/index.html#ctn/A4SH-001');
});

test('SLG-003 同样 302；缓存头 1h（码值永不变）', async () => {
  const res = fakeRes();
  await handler({ method: 'GET', query: { code: C.fromCtnCode('SLG-003') } }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/index.html#ctn/SLG-003');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=3600');
});

test('未知/篡改码 404 且文案是「容器」、不泄露内部结构', async () => {
  const base = C.fromCtnCode('A4SH-001');
  const flipped = base.slice(0, 7) + (base[7] === '0' ? '1' : '0');
  const res = fakeRes();
  await handler({ method: 'GET', query: { code: flipped } }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /未找到对应容器/);
  assert.doesNotMatch(res.body, /A4SH|tbl|ctnIndex|CTN_CATS/, '404 页不得泄露编码结构');
});

test('非 GET/HEAD 拒绝（POST/PUT/DELETE 405）', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = fakeRes();
    await handler({ method, query: { code: C.fromCtnCode('A4SH-001') } }, res);
    assert.equal(res.statusCode, 405, method + ' 必须 405');
  }
  const head = fakeRes();
  await handler({ method: 'HEAD', query: { code: C.fromCtnCode('A4SH-001') } }, head);
  assert.equal(head.statusCode, 302, 'HEAD 必须放行');
});

/* 大小写双路由防回归（D4：冻结 URL 是大写 /C/；物品侧曾因 vercel.json 只配 /i/ 导致印刷大写短链生产 404） */
test('/C/ 大写路由：vercel.json 与 feishu-server.mjs 必须同时承接 /C/ 与 /c/', () => {
  const fs = require('node:fs');
  const vc = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'vercel.json'), 'utf8'));
  const dests = vc.rewrites.filter(r => r.destination === '/api/ctn-link/:code').map(r => r.source);
  assert.ok(dests.includes('/c/:code'), 'vercel.json 缺 /c/:code rewrite（兼容入口）');
  assert.ok(dests.includes('/C/:code'), 'vercel.json 缺 /C/:code rewrite（冻结大写形态，缺了印刷短链会 404）');
  const srv = fs.readFileSync(require('node:path').join(__dirname, '..', 'feishu-server.mjs'), 'utf8');
  assert.ok(srv.includes("startsWith('/C/')"), 'feishu-server.mjs 本地路由必须也认 /C/ 大写前缀');
  assert.ok(srv.includes("startsWith('/c/')"), 'feishu-server.mjs 本地路由必须也认 /c/ 小写前缀');
});

test('/c/ 路由与静态资源前缀无冲突（/css/ 等不被误吞）', () => {
  assert.equal('/css/app.css'.startsWith('/c/'), false);
  assert.equal('/components/x'.startsWith('/c/'), false);
});

test('冻结短链 URL 形态：BASE_URL + 短码整条 42 字符全大写（QR alphanumeric）', () => {
  const link = C.linkFor('A4SH-001');
  assert.equal(link, 'HTTPS://MES.NEWENERGYCODER.CLUB/C/XW4QYGBY');
  assert.equal(link, link.toUpperCase(), '整条 URL 必须全大写');
  assert.equal(link.length, 42, '全长 42 字符（QR V3-M 容量 61，余量 19，不可再加字符）');
  assert.match(link, /\/C\/[0-9A-HJKMNP-TV-Z]{8}$/, '路径必须是 /C/ + 8 位 Crockford');
});
