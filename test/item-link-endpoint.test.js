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
