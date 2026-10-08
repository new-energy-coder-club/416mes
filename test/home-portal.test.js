'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'home.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'home.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'home.js'), 'utf8');

test('首页作为 Vercel 唯一根入口，index.html 和短链/API 仍各自保留', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.deepEqual((config.redirects || []).filter(r => r.source === '/'), [
    { source: '/', destination: '/home.html', statusCode: 307 }
  ]);
  assert.equal(config.git?.deploymentEnabled?.main, false, 'main 只能由 Actions 测试通过后通过 Vercel CLI 生产部署，禁止原生 Git 重复部署');
  for (const route of ['/i/:code', '/I/:code', '/c/:code', '/C/:code']) {
    assert.ok(config.rewrites.some(r => r.source === route), '短链不可回退：' + route);
  }
  const local = fs.readFileSync(path.join(root, 'feishu-server.mjs'), 'utf8');
  assert.match(local, /u\.pathname === '\/' \? '\/home\.html'/, '本地服务器根路由必须和 Vercel 一致');
  assert.match(fs.readFileSync(path.join(root, 'scripts/static-server.mjs'), 'utf8'), /pathname === '\/' \? '\/home\.html'/);
});

test('主页高频功能在前，低频功能居后，所有入口命中当前真实页签', () => {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML(html);
  const nav = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const tabs = new Set([...nav.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]));
  assert.ok(document.querySelector('main #homeSearch'));
  assert.ok(document.querySelector('.action-grid'));
  assert.ok(document.querySelector('#statsGrid'));
  assert.ok(document.querySelector('.tool-grid'));
  assert.ok(html.indexOf('action-grid') < html.indexOf('statsGrid'));
  assert.ok(html.indexOf('statsGrid') < html.indexOf('tool-grid'));
  const paths = [...document.querySelectorAll('a[href^="index.html#"]')];
  assert.ok(paths.length >= 10);
  for (const a of paths) {
    const target = a.getAttribute('href').split('#')[1].split('?')[0];
    assert.ok(tabs.has(target), '无效主应用页签：' + target);
  }
});

test('首页数据只读、不能假造已同步或 99 天备份，静态页无强制 4 秒遮罩', () => {
  assert.match(script, /mes416_state_v1/);
  assert.match(script, /mes416_last_backup/);
  assert.match(script, /indexedDB\.databases/);
  assert.match(script, /transaction\('outbox', 'readonly'\)/);
  assert.doesNotMatch(script, /indexedDB\.open\([^)]*,\s*\d+\)/);
  assert.doesNotMatch(script, /fetch\s*\(/, '首页不能悄悄访问业务写接口');
  assert.doesNotMatch(script, /99\s*\*\s*86400000|days\s*=\s*99|days\s*>\s*7\s*\?\s*99/);
  assert.doesNotMatch(html, /id="appLoader"/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(html, /home\.css\?v=/);
  assert.match(html, /home\.js\?v=/);
});
