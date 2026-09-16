/**
 * P6 旁路模块：inventree-sync.mjs / xianyu-sync.mjs
 *
 * 这两个脚本以前**一个功能性测试都没有**，package.json 里只有 `node --check`。
 * 而它们的缺陷都是「静默损坏数据」型的：
 *   · inventree 只读第一页 → 判定「不存在」→ 重复建 Part/StockItem → 库存被算多
 *   · xianyu 把 TSV 的 tab 全换成逗号 → 标题里的逗号把整行挤错列
 *   · priceDivisor 不校验 → 成本算成 Infinity/NaN → 落盘时静默变 null
 *
 * inventree 用本地 HTTP 桩（真 fetch 打真端口），xianyu 用临时 TSV + 临时备份，
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
const INV = path.join(REPO, 'inventree-sync.mjs');
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
 * inventree：分页必须真的翻页
 * ========================================================================== */

/** 桩 InvenTree：/api/part/ 分页返回（page_size=2），并记录被 POST 了什么 */
function startInvenTree(partRows, pageSize = 2) {
  const created = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && u.pathname === '/api/part/') {
        const limit = Number(u.searchParams.get('limit')) || pageSize;
        const offset = Number(u.searchParams.get('offset')) || 0;
        const slice = partRows.slice(offset, offset + limit);
        const nextOffset = offset + limit;
        return send(200, {
          count: partRows.length,
          next: nextOffset < partRows.length ? `/api/part/?limit=${limit}&offset=${nextOffset}` : null,
          results: slice
        });
      }
      if (req.method === 'GET' && (u.pathname === '/api/part/category/' || u.pathname === '/api/stock/location/')) {
        return send(200, { count: 0, next: null, results: [] });
      }
      if (req.method === 'POST' && u.pathname === '/api/part/') {
        created.push(JSON.parse(body || '{}'));
        return send(201, { pk: 900 + created.length });
      }
      if (req.method === 'POST' && (u.pathname === '/api/part/category/' || u.pathname === '/api/stock/location/')) {
        return send(201, { pk: 1 });
      }
      if (req.method === 'GET' && u.pathname === '/api/stock/') return send(200, { count: 0, next: null, results: [] });
      if (req.method === 'POST' && u.pathname === '/api/stock/') return send(201, { pk: 7 });
      if (req.method === 'GET' && u.pathname === '/api/barcode/') return send(200, { count: 0, next: null, results: [] });
      return send(200, { count: 0, next: null, results: [] });
    });
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port, created })));
}

function xlsxWithMaterials(rows) {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['物料码', '名称', '规格型号', '闲鱼XY编号', '当前库位码', '容器码', '库存数量', '成本'],
    ...rows
  ]), '物料台账');
  const f = path.join(tmpDir(), 'in.xlsx');
  XLSX.writeFile(wb, f);
  return f;
}

test('inventree【P6 核心】目标 Part 在第 2 页时必须翻页找到，不能重复创建', async (t) => {
  // 第 1 页放 2 条无关 Part，把要匹配的那条挤到第 2 页
  const rows = [
    { pk: 1, IPN: 'OTHER-1', name: 'x' },
    { pk: 2, IPN: 'OTHER-2', name: 'y' },
    { pk: 3, IPN: 'ZZ-DUP-1', name: '目标' }
  ];
  const mock = await startInvenTree(rows, 2);
  t.after(() => mock.server.close());
  const dir = tmpDir();
  const cfgFile = path.join(dir, 'inventree-sync.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ base_url: `http://127.0.0.1:${mock.port}`, token: 't', categories: { JG: '机构件' } }));
  const xlsx = xlsxWithMaterials([['ZZ-DUP-1', '目标物料', '', '', 'B-01-01-01', '', 5, 1]]);

  // 用 INVENTREE_CONFIG 指到临时配置？脚本读固定文件名 —— 改成在临时 cwd 跑
  fs.copyFileSync(cfgFile, path.join(REPO, 'inventree-sync.config.json.p6bak'));
  const realCfg = path.join(REPO, 'inventree-sync.config.json');
  const hadCfg = fs.existsSync(realCfg);
  const savedCfg = hadCfg ? fs.readFileSync(realCfg) : null;
  fs.writeFileSync(realCfg, JSON.stringify({ base_url: `http://127.0.0.1:${mock.port}`, token: 't', root_category_id: 1, root_locations: { shelf: 2, workstation: 3, container: 4 } }));
  t.after(() => {
    if (savedCfg) fs.writeFileSync(realCfg, savedCfg); else fs.rmSync(realCfg, { force: true });
    fs.rmSync(path.join(REPO, 'inventree-sync.config.json.p6bak'), { force: true });
  });

  const r = await run(INV, ['push', xlsx]);
  // 先确认脚本真的走到了物料那一步：否则「没建重复」只是因为提前退出了（假通过）
  assert.match(r.stdout, /物料 1，库位 \d+，容器 \d+/, '脚本必须真的读到了台账并开始同步：' + r.stdout + r.stderr);
  const dup = mock.created.filter(p => p.IPN === 'ZZ-DUP-1');
  assert.equal(dup.length, 0,
    'ZZ-DUP-1 已经存在于第 2 页 → 必须翻页找到它、不能重复创建。实际创建了 ' + dup.length + ' 条。\n输出：' + r.stdout + r.stderr);
});

test('inventree【P6 回归】第 1 页就能找到时也不该重复创建（别把翻页改坏）', async (t) => {
  const rows = [{ pk: 1, IPN: 'ZZ-HIT-1', name: '首页命中' }];
  const mock = await startInvenTree(rows, 2);
  t.after(() => mock.server.close());
  const realCfg = path.join(REPO, 'inventree-sync.config.json');
  const had = fs.existsSync(realCfg);
  const saved = had ? fs.readFileSync(realCfg) : null;
  fs.writeFileSync(realCfg, JSON.stringify({ base_url: `http://127.0.0.1:${mock.port}`, token: 't', root_category_id: 1, root_locations: { shelf: 2, workstation: 3, container: 4 } }));
  t.after(() => { if (saved) fs.writeFileSync(realCfg, saved); else fs.rmSync(realCfg, { force: true }); });
  const xlsx = xlsxWithMaterials([['ZZ-HIT-1', '首页命中物料', '', '', 'B-01-01-01', '', 5, 1]]);
  await run(INV, ['push', xlsx]);
  assert.equal(mock.created.filter(p => p.IPN === 'ZZ-HIT-1').length, 0, '首页命中也不该重复建');
});

test('inventree【P6】「库存数量」不是数字时跳过，绝不把远端库存改成 0', async (t) => {
  const mock = await startInvenTree([], 2);
  t.after(() => mock.server.close());
  const realCfg = path.join(REPO, 'inventree-sync.config.json');
  const had = fs.existsSync(realCfg);
  const saved = had ? fs.readFileSync(realCfg) : null;
  fs.writeFileSync(realCfg, JSON.stringify({ base_url: `http://127.0.0.1:${mock.port}`, token: 't', root_category_id: 1, root_locations: { shelf: 2, workstation: 3, container: 4 } }));
  t.after(() => { if (saved) fs.writeFileSync(realCfg, saved); else fs.rmSync(realCfg, { force: true }); });
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['物料码', '名称', '库存数量', '成本'],
    ['ZZ-BADQ-1', '数字写错了', '约5个', 'x']
  ]), '物料台账');
  const f = path.join(tmpDir(), 'bad.xlsx');
  XLSX.writeFile(wb, f);
  const r = await run(INV, ['push', f]);
  assert.match(r.stdout, /物料 1，库位 0，容器 0/, '脚本必须真的开始同步：' + r.stdout + r.stderr);
  assert.match(r.stdout, /不是有效数字，已跳过/, '必须明确说跳过了：' + r.stdout);
  assert.doesNotMatch(r.stdout, /quantity: 0/, '绝不能带着 0 去 PATCH');
});

/* ============================================================================
 * xianyu：TSV 解析与除数校验（走真实 CLI + 临时备份文件）
 * ============================================================================ */

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
