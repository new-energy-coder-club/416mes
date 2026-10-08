'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['lib', 'api', 'scripts'];
const ROOT_SOURCE = ['index.html', 'home.html', 'join.html', 'mes-core.js', 'feishu-server.mjs', 'feishu-sync.mjs', 'feishu-import.mjs', 'nec-sync.mjs', 'xianyu-sync.mjs'];
const SOURCE_EXT = new Set(['.js', '.mjs', '.html']);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (SOURCE_EXT.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

test('源码卫生：生产源码不得残留 Git 冲突标记', () => {
  const files = ROOT_SOURCE.map(f => path.join(root, f)).filter(fs.existsSync);
  for (const dir of SOURCE_DIRS) {
    const p = path.join(root, dir);
    if (fs.existsSync(p)) files.push(...walk(p));
  }
  const bad = [];
  const marker = /^(?:<<<<<<< .+|=======|>>>>>>> .+)$/m;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (marker.test(text)) bad.push(path.relative(root, file));
  }
  assert.deepEqual(bad, [], '发现未解决的 Git 冲突标记：\n' + bad.map(x => '  ' + x).join('\n'));
});

test('门户：所有 index.html# 页签入口必须指向当前真实 tab', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const home = fs.readFileSync(path.join(root, 'home.html'), 'utf8');
  const tabs = new Set([...index.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]));
  const hrefs = [...home.matchAll(/href="index\.html#([^"]+)"/g)].map(m => m[1]);
  assert.ok(hrefs.length > 0, 'home.html 应至少有一个主应用页签入口');
  const invalid = hrefs.filter(h => !tabs.has(h) && !/^item\//.test(h));
  assert.deepEqual(invalid, [], '门户存在失效页签入口：' + invalid.join(', '));
});

test('同步成功文案必须从 SYNC_TABLES 动态取表数，禁止再次硬编码 8 表', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(index, /SYNC_TABLES\.length\s*\+\s*' 张表数据条数全部一致/);
  assert.doesNotMatch(index, /8 张表数据条数全部一致/);
});
