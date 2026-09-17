/**
 * P6 旁路模块：xianyu-sync.mjs
 *
 * 这个脚本以前**一个功能性测试都没有**，package.json 里只有 `node --check`。
 * 而它们的缺陷都是「静默损坏数据」型的：
 *   · xianyu 把 TSV 的 tab 全换成逗号 → 标题里的逗号把整行挤错列
 *   · priceDivisor 不校验 → 成本算成 Infinity/NaN → 落盘时静默变 null
 *
 * 全程不联网、不碰任何真实服务。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const XY = path.join(REPO, 'xianyu-sync.mjs');

function run(script, args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [script, ...args], {
      cwd: REPO, env: Object.assign({}, process.env, env || {}), timeout: 60000
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'p6-')); }

/* ============================================================================
   闲鱼导入脚本：TSV/CSV 解析与数值校验（inventree-sync 已按需求移除）
   ============================================================================ */

test('xianyu【P6 核心】TSV 里标题含逗号不得错列（旧实现整行右移）', async (t) => {
  const dir = tmpDir();
  const tsv = path.join(dir, 'xy.tsv');
  fs.writeFileSync(tsv, 'outer_id\t标题\tstock\t售价\t首图\nXY-9\t全新,未拆封\t3\t1290\tu\n');
  const backup = path.join(dir, 'bak.json');
  fs.writeFileSync(backup, JSON.stringify({ app: '416MES', version: 2, state: { materials: [] } }));
  const cfg = path.join(REPO, 'xianyu-sync.config.json');
  const had = fs.existsSync(cfg);
  const saved = had ? fs.readFileSync(cfg) : null;
  fs.writeFileSync(cfg, JSON.stringify({ priceDivisor: 100 }));
  t.after(() => { if (saved) fs.writeFileSync(cfg, saved); else fs.rmSync(cfg, { force: true }); });

  const r = await run(XY, ['import', tsv, backup]);
  const st = JSON.parse(fs.readFileSync(backup, 'utf8'));
  const m = (st.state.materials || []).find(x => x.code === 'XY-9');
  assert.ok(m, '应导入 XY-9：' + r.stdout + r.stderr);
  assert.equal(m.name, '全新,未拆封', '标题必须完整保留（旧实现会变成「全新」）');
  assert.equal(m.img, 'u', '首图必须是 u（旧实现会拿到 1290）');
  assert.equal(m.cost, 12.9, '售价 1290 / 100 = 12.9（旧实现会算成 0.03）');
  assert.equal(m.qty, 3, '数量 3（旧实现会拿标题碎片当数量→0）');
});

test('xianyu【P6】priceDivisor 为 0 / 空 / 非数字时必须退回 100，不能把成本写成 null', async (t) => {
  for (const bad of [0, '', 'abc', -5]) {
    const dir = tmpDir();
    const tsv = path.join(dir, 'xy.tsv');
    fs.writeFileSync(tsv, 'outer_id\t标题\t售价\nXY-' + String(bad) + '\t测试\t500\n');
    const backup = path.join(dir, 'bak.json');
    fs.writeFileSync(backup, JSON.stringify({ app: '416MES', version: 2, state: { materials: [] } }));
    const cfg = path.join(REPO, 'xianyu-sync.config.json');
    const had = fs.existsSync(cfg);
    const saved = had ? fs.readFileSync(cfg) : null;
    fs.writeFileSync(cfg, JSON.stringify({ priceDivisor: bad }));
    try {
      const r = await run(XY, ['import', tsv, backup]);
      const st = JSON.parse(fs.readFileSync(backup, 'utf8'));
      const m = (st.state.materials || []).find(x => x.code === 'XY-' + String(bad));
      assert.ok(m, 'priceDivisor=' + JSON.stringify(bad) + ' 时应导入成功：' + r.stdout + r.stderr);
      assert.equal(m.cost, 5, 'priceDivisor=' + JSON.stringify(bad) + ' 必须退回 100 → 500/100=5，实际 ' + m.cost);
      assert.ok(Number.isFinite(m.cost), '成本必须是有限数，绝不能是 Infinity/NaN（落盘会静默变 null）');
      assert.match(r.stderr, /退回默认 100/, '要明确告警：' + r.stderr);
    } finally {
      if (saved) fs.writeFileSync(cfg, saved); else fs.rmSync(cfg, { force: true });
    }
  }
});

test('xianyu【P6】未配对的引号必须报错，而不是把后续所有行吞掉', async () => {
  const dir = tmpDir();
  const tsv = path.join(dir, 'xy.tsv');
  // 标题里一个孤立的英寸符号
  fs.writeFileSync(tsv, 'outer_id\t标题\tstock\nXY-1\t15"显示器\t3\nXY-2\t正常\t5\n');
  const backup = path.join(dir, 'bak.json');
  fs.writeFileSync(backup, JSON.stringify({ app: '416MES', version: 2, state: { materials: [] } }));
  const r = await run(XY, ['import', tsv, backup]);
  assert.notEqual(r.code, 0, '引号没闭合应当失败退出，而不是静默吞掉后面几行：' + r.stdout);
  assert.match(r.stdout + r.stderr, /引号没有闭合/, '要说清原因');
});

test('xianyu【P6】tab 分隔的 .txt 也要能被识别（旧实现整行当一个字段→全部跳过）', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'xy.txt');
  fs.writeFileSync(f, 'outer_id\t标题\tstock\nXY-TXT-1\t文本文件\t7\n');
  const backup = path.join(dir, 'bak.json');
  fs.writeFileSync(backup, JSON.stringify({ app: '416MES', version: 2, state: { materials: [] } }));
  const r = await run(XY, ['import', f, backup]);
  const st = JSON.parse(fs.readFileSync(backup, 'utf8'));
  const m = (st.state.materials || []).find(x => x.code === 'XY-TXT-1');
  assert.ok(m, '按内容嗅探出 tab 分隔后应能导入：' + r.stdout + r.stderr);
  assert.equal(m.qty, 7);
});
