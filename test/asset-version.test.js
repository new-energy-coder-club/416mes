'use strict';
/**
 * 部署一致性：库文件的缓存版本号必须与 APP_VERSION 一致。
 *
 * 为什么必须自动化盯住：Vercel 给静态资源下发 `cache-control: public, max-age=14400`，
 * 也就是**浏览器 4 小时内不会重新拉取库文件**。库改了但 <script src> 没带新版本号时，
 * 用户跑的还是旧代码 —— 线上实测踩过：store.js 新增的 iterate 一直报
 * 「is not a function」，页面看起来却已经完全部署成功。
 * 靠人记得改版本号是不行的，所以在这里钉死。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const REPO = path.join(__dirname, '..');
const LOCAL_SCRIPTS = ['nec-gallery.js', 'jsqr.min.js', 'mes-core.js',
  'lib/outbox.js', 'lib/store.js', 'lib/replay-checkpoint.js', 'lib/incremental.js', 'lib/three-way-merge.js'];

test('index.html：每个本地库 script 都带 ?v=，且与 APP_VERSION 一致', () => {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const m = html.match(/const APP_VERSION = '([^']+)'/);
  assert.ok(m, '找不到 APP_VERSION');
  const ver = m[1];

  LOCAL_SCRIPTS.forEach(f => {
    const re = new RegExp('<script src="' + f.replace(/[.\/]/g, '\\$&') + '(\\?v=([^"]+))?"></script>');
    const hit = html.match(re);
    assert.ok(hit, f + ' 的 script 标签没找到');
    assert.ok(hit[1], f + ' 缺少 ?v= 版本号 —— 库改了用户 4 小时内拿不到');
    assert.equal(hit[2], ver, f + ' 的版本号 ' + hit[2] + ' 与 APP_VERSION ' + ver + ' 不一致');
  });
});

test('index.html：库文件确实存在，避免写了个不存在的路径还带版本号', () => {
  LOCAL_SCRIPTS.forEach(f => {
    assert.ok(fs.existsSync(path.join(REPO, f)), f + ' 不存在');
  });
});
