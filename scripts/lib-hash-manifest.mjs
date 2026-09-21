#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.FOUR16_REPO
  ? path.resolve(process.env.FOUR16_REPO)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ver = (html.match(/const APP_VERSION = '([^']+)'/) || [])[1];
if (!ver) { console.error('✗ index.html 里找不到 APP_VERSION'); process.exit(1); }
const localScripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => m[1])
  .filter(src => !/^(https?:)?\/\//.test(src));
const hashes = {};
for (const src of localScripts) {
  const file = src.split('?v=')[0];
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) { console.error('✗ script 指向不存在的文件：' + src); process.exit(1); }
  hashes[src] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
const out = { APP_VERSION: ver, generatedAt: new Date().toISOString(), hashes };
const target = path.join(ROOT, 'test', 'fixtures', 'lib-hash-manifest.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log('✓ 已刷新基线 ' + path.relative(ROOT, target) + '（APP_VERSION ' + ver + '，' + Object.keys(hashes).length + ' 个文件）');
