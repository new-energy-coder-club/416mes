'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const handler = require('../api/item-link/[code].js');
const L = require('../lib/item-link');

function fakeRes() {
  const r = { headers: {}, statusCode: 200, body: null,
    status(n) { r.statusCode = n; return r; },
    setHeader(k, v) { r.headers[k] = v; return r; },
    end(b) { r.body = b === undefined ? undefined : String(b); return r; } };
  return r;
}

test('/i/ 短链转跳：本地解码 302 到物品详情深链，不依赖飞书', async () => {
  const short = L.fromItemCode('WP-TS-001');
  const res = fakeRes();
  await handler({ method: 'GET', query: { code: short } }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/index.html#item/WP-TS-001');
});

test('存量未分类 WP-001 同样可跳', async () => {
  const res = fakeRes();
  await handler({ method: 'GET', query: { code: 'KW4QYSBD' } }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/index.html#item/WP-001');
});

test('未知/篡改码 404 且文案不泄露内部结构', async () => {
  const res = fakeRes();
  await handler({ method: 'GET', query: { code: 'KW4QYSBE' } }, res);   // 校验位被篡改
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /未找到对应物品/);
  assert.doesNotMatch(res.body, /WP-|tbl|物品码/, '404 页不得泄露编码结构');
});

test('非 GET 拒绝', async () => {
  const res = fakeRes();
  await handler({ method: 'POST', query: { code: 'KW4QYSBD' } }, res);
  assert.equal(res.statusCode, 405);
});

/* 大小写双路由防回归（定稿 §二/§6.3：冻结 URL 是大写 /I/，曾因 vercel.json 只配 /i/ 导致
   印刷大写短链在生产 404 —— 路由配置从此钉死，/i/ 保留兼容入口） */
test('/I/ 大写路由：vercel.json 与 feishu-server.mjs 必须同时承接 /I/ 与 /i/', () => {
  const fs = require('node:fs');
  const vc = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'vercel.json'), 'utf8'));
  const dests = vc.rewrites.filter(r => r.destination === '/api/item-link/:code').map(r => r.source);
  assert.ok(dests.includes('/i/:code'), 'vercel.json 缺 /i/:code rewrite（兼容入口）');
  assert.ok(dests.includes('/I/:code'), 'vercel.json 缺 /I/:code rewrite（冻结大写形态，缺了印刷短链会 404）');
  const srv = fs.readFileSync(require('node:path').join(__dirname, '..', 'feishu-server.mjs'), 'utf8');
  assert.ok(srv.includes("startsWith('/I/')"), 'feishu-server.mjs 本地路由必须也认 /I/ 大写前缀');
});

test('冻结短链 URL 形态：linkFor 产出整条大写（QR alphanumeric 模式）', () => {
  const link = L.linkFor('WP-001');
  assert.equal(link, 'HTTPS://MES.NEWENERGYCODER.CLUB/I/KW4QYSBD');
  assert.equal(link, link.toUpperCase(), '整条 URL 必须全大写');
  assert.equal(link.length, 42, '全长 42 字符（QR V3-M 容量 61，余量 19，不可再加字符）');
});
