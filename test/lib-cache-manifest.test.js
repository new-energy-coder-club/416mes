'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const REPO = process.env.FOUR16_REPO || path.join(__dirname, '..');
const MANIFEST_PATH = path.join(REPO, 'test', 'fixtures', 'lib-hash-manifest.json');
function readIndexHtml() { return fs.readFileSync(path.join(REPO, 'index.html'), 'utf8'); }
function appVersionOf(html) { const m = html.match(/const APP_VERSION = '([^']+)'/); assert.ok(m, 'index.html 里找不到 APP_VERSION'); return m[1]; }
function localScriptsOf(html) {
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]).filter(src => !/^(https?:)?\/\//.test(src));
}
function sha256Of(relFile) { return crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, relFile))).digest('hex'); }

test('缓存守卫 R1+R2：基线清单存在，且与当前 APP_VERSION 同版', () => {
  assert.ok(fs.existsSync(MANIFEST_PATH),
    '缺少 test/fixtures/lib-hash-manifest.json —— 请运行 npm run lib:manifest 生成基线并随本次改动一起提交');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const ver = appVersionOf(readIndexHtml());
  assert.equal(manifest.APP_VERSION, ver,
    'APP_VERSION 已顶到 ' + ver + '，但缓存基线还停在 ' + manifest.APP_VERSION + ' —— 请运行 npm run lib:manifest 刷新基线，并与本次改动一起提交');
});
test('缓存守卫 R3：每个带 ?v= 的本地脚本，版本号都必须等于 APP_VERSION', () => {
  const html = readIndexHtml();
  const ver = appVersionOf(html);
  for (const src of localScriptsOf(html)) {
    const m = src.match(/^(.*)\?v=([^"]*)$/);
    if (!m) continue;
    assert.equal(m[2], ver, src + ' 的 ?v=' + m[2] + ' 与 APP_VERSION ' + ver + ' 不一致');
  }
});
test('缓存守卫 R4+R5：lib 内容与基线一致 —— 内容变了而 APP_VERSION 没变 = 忘顶号', () => {
  const html = readIndexHtml();
  const ver = appVersionOf(html);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const tracked = localScriptsOf(html);   // 含 vendor 无版本件：集合必须精确一致
  const missing = tracked.filter(src => !(src in manifest.hashes));
  const stale = Object.keys(manifest.hashes).filter(src => !tracked.includes(src));
  assert.deepStrictEqual({ missing, stale }, { missing: [], stale: [] },
    '基线清单与 index.html 的本地脚本集合不一致（missing=' + missing + ' stale=' + stale + '）—— 请运行 npm run lib:manifest 刷新基线');
  const changed = tracked.filter(src => manifest.hashes[src] !== sha256Of(src.split('?v=')[0]));   // vendor 也盯：改了没 ?v= 同样 4h 旧缓存
  assert.deepStrictEqual(changed, [],
    '以下文件内容相对基线变了，但 APP_VERSION 还是 ' + ver + '（用户浏览器最长 4h 拿旧 lib）：\n  ' + changed.join('\n  ') + '\n改法：① 顶 APP_VERSION 与全部 ?v=；② npm run lib:manifest；③ 一起提交。');
});
