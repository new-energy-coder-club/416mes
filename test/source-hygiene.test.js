'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['lib', 'api', 'scripts'];
const ROOT_SOURCE = ['index.html', 'home.html', 'home.js', 'join.html', 'mes-core.js', 'feishu-server.mjs', 'feishu-sync.mjs', 'feishu-import.mjs', 'nec-sync.mjs', 'xianyu-sync.mjs'];
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

test('CI 可移植性：测试不得写死开发机 /srv/416mes 项目目录', () => {
  const paths = walk(path.join(root, 'test'));
  const bad = paths.filter(f => /['"]\/srv\/416mes\//.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map(f => path.relative(root, f)), [],
    '测试应从 __dirname 推导仓库位置，而不是依赖 /srv/416mes');
});

test('CI 可重现性：测试 require 的第三方包必须在 package.json 中声明', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const allowed = new Set([...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.devDependencies || {})]);
  const { builtinModules } = require('node:module');
  const builtins = new Set(builtinModules);
  const missing = [];
  for (const file of walk(path.join(root, 'test'))) {
    const src = fs.readFileSync(file, 'utf8');
    const rex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of src.matchAll(rex)) {
      const name = match[1];
      if (name.startsWith('.') || name.startsWith('/') || name.startsWith('node:') || builtins.has(name)) continue;
      const pkg = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
      if (!allowed.has(pkg)) missing.push(path.relative(root, file) + ': ' + pkg);
    }
  }
  assert.deepEqual([...new Set(missing)], [],
    '测试引用了未声明依赖；本机残留 node_modules 会掩盖 CI MODULE_NOT_FOUND');
});
