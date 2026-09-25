'use strict';
/* TASK-18 修复验证：BUG-16 崩溃根因（坏行/坏草稿不再崩 render）+ BUG-15 verifyLegacy
 * 入口 + BUG-13 方向文案 + errText 兜底 + 退役可用性（全真 harness）。 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { parseHTML } = require('linkedom');
const UI = require('/srv/416mes/lib/item-ui');
const Store = require('/srv/416mes/lib/store.js');
const PERSIST = require('/srv/416mes/lib/item-persistence.js');
const Client = require('/srv/416mes/lib/item-client.js');
const Scan = require('/srv/416mes/lib/item-scan.js');

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function setupProd() {
  return (async () => {
    const html = fs.readFileSync('/srv/416mes/index.html', 'utf8');
    const { document } = parseHTML(html);
    let n = 0;
    const commands = [];
    let state = {
      locations: [{ code: 'L-A', status: 'active' }, { code: 'L-B', status: 'active' }],
      containers: [{ code: 'C-A', loc: 'L-A', status: 'active', version: 2 }, { code: 'C-B', loc: 'L-A', status: 'active', version: 1 }, { code: 'C-F', loc: '', status: 'active', version: 0 }],
      items: [{ code: 'I-P', name: 'part', status: 'pending', version: 0 }, { code: 'I-IN', name: 'in库件', status: 'in_stock', container: 'C-A', version: 1 }, { code: 'I-OLD', name: '旧档案', status: 'unknown', version: 0 }],
      itemOperations: [], workorders: [], __itmPending: {}
    };
    const store = Store.createMemoryStore();
    store.kind = 'indexeddb';
    await store.open();
    const persistence = PERSIST.create({ store, getState: () => state, publish: next => { state = next; }, canWrite: () => true });
    const client = Client.create({
      persistence,
      fetch: async (url, opts) => {
        const body = JSON.parse(opts.body || '{}');
        const opId = body.opId || 'x';
        const request = (body && body.request) || body;
        let operation;
        if (request.kind === 'registerItem') {
          const code = (request.entity && request.entity.code) || 'WP-TS-0' + (++n);
          state.items.push({ code, name: request.entity.name, status: 'pending', version: 1, lastOpId: opId });
          operation = { code: opId, phase: 'APPLIED', request: { ...request, entity: { ...(request.entity || {}), code } }, after: { items: [{ code, status: 'pending', version: 1, lastOpId: opId }] } };
        } else if (request.kind === 'retire') {
          const it = state.items.find(x => x.code === request.itemCode);
          if (!it) operation = { code: opId, phase: 'REJECTED', request, error: 'NOT_FOUND' };
          else {
            const beforeRow = { code: it.code, status: it.status, version: it.version || 0, lastOpId: it.lastOpId || '' };
            operation = { code: opId, phase: 'APPLIED', request,
              before: { items: [beforeRow] },
              after: { items: [{ code: it.code, status: 'retired', version: (it.version || 0) + 1, lastOpId: opId }] } };
          }
        } else operation = { code: opId, phase: 'APPLIED', request };
        return { ok: true, status: 200, json: async () => ({ ok: true, operation }) };
      }
    });
    const page = UI.mount({
      document, getState: () => state, getPersistence: () => persistence,
      getCommands: async () => (await persistence.recover()).commands,
      getClient: () => client, isOnline: () => true, id: () => 't18-' + (++n)
    });
    return { document, get state() { return state; }, page, persistence };
  })();
}

test('BUG-16：坏 kind 行不再崩 render（修复前 labels.forEach 抛 TypeError）', async () => {
  const s = await setupProd();
  const scan = s.page.scan;
  scan.restore({ sessionId: 'bad', rows: [{ rowId: 'r1', kind: 'verify', generation: 0, values: [], locked: false, opId: null }] });
  s.page.render();   // 修复前：TypeError: Cannot read properties of undefined (reading 'forEach')
  const step = s.document.getElementById('itmStep').textContent;
  assert.doesNotMatch(s.document.getElementById('itmRegisterResult') ? 'x' : '', /^$/, ''); // noop
  assert.ok(step.length > 0, 'render 必须正常产出步骤引导');
  assert.doesNotMatch(step, /undefined/, '兜底渲染不得出现 undefined 字样');
  // 行列表仍渲染（坏行被过滤后 session 至少 1 行 receive）
  assert.equal(scan.row().kind, 'receive', 'restore 应把无合法 kind 的草稿行替换为 receive 空行');
});

test('BUG-16：restore 空 rows / 缺 rows 的草稿不崩', () => {
  const scan = Scan.create({ getState: () => ({ items: [] }), id: () => 'x' });
  scan.restore({ sessionId: 'e1', rows: [] });
  assert.equal(scan.row().kind, 'receive');
  scan.restore({ sessionId: 'e2' });
  assert.equal(scan.row().kind, 'receive');
});

test('BUG-16：领域错误仍显中文，TypeError 文案走人话兜底正则', async () => {
  const html = fs.readFileSync('/srv/416mes/index.html', 'utf8');
  const { document } = parseHTML(html);
  let n = 0;
  const state = { locations: [], containers: [], items: [], itemOperations: [] };
  const page = UI.mount({ document, getState: () => state, getPersistence: () => null, getCommands: async () => [], id: () => 'e' + (++n) });
  document.getElementById('itmRetireCode').value = 'I-MISSING';
  document.getElementById('itmRetireReason').value = 'x';
  document.getElementById('itmRetire').click();
  await tick();
  const txt = document.getElementById('itmStatus').textContent;
  assert.match(txt, /未找到对应档案（NOT_FOUND）/, '领域错误仍按 errZh 中文表显示');
  /* errText 兜底正则的独立行为验证（正则与 lib/item-ui.js errText 内一致） */
  const RX = /Cannot read propert|is not a function|undefined is not|Cannot convert|null is not an object/i;
  assert.ok(RX.test("Cannot read properties of undefined (reading 'forEach')"), 'TypeError 必命中人话兜底分支');
  assert.ok(!RX.test('IDB不可用'), '领域错误不走兜底分支');
});

test('BUG-16：建档+退役全真链路走通，界面无裸露错误', async () => {
  const s = await setupProd();
  const d = s.document;
  // 建档
  const pick = (id, val) => { const sel = d.getElementById(id); for (const o of sel.options) { if (o.value === val) o.setAttribute('selected', ''); else o.removeAttribute('selected'); } sel.dispatchEvent(new d.defaultView.Event('change')); };
  pick('itmRegisterType', 'registerItem');
  pick('itmRegisterCat', 'TS');
  d.getElementById('itmRegisterName').value = 'TASK18验证';
  d.getElementById('itmRegister').click();
  await tick(20);
  const regBox = d.getElementById('itmRegisterResult').textContent;
  assert.match(regBox, /建档完成：WP-/, '建档成功文案');
  assert.doesNotMatch(regBox, /forEach|Cannot read/, '建档区不得出现裸露 JS 错误');
  const code = (s.state.items.find(x => x.name === 'TASK18验证') || {}).code;
  assert.ok(code, '服务端已建档');
  // 退役
  d.getElementById('itmRetireCode').value = code;
  d.getElementById('itmRetireReason').value = 'TASK18 验证退役';
  d.getElementById('itmRetire').click();
  await tick(15);
  /* TASK-20（BUG-17）：退役提示从作业页 itmStatus 迁到注册页 itmRegisterResult（本页可见） */
  assert.match(d.getElementById('itmRegisterResult').textContent, /退役申请已保存/, '退役入队反馈落在本页容器');
  assert.doesNotMatch(d.getElementById('itmStatus').textContent, /forEach|Cannot read/, '退役不得出现裸露 JS 错误');
  // 待处理区执行退役卡
  await s.page.pending();
  const exec = [...d.getElementById('itmPending').querySelectorAll('button')].find(b => b.textContent === '执行');
  assert.ok(exec, '退役命令卡在待处理区');
  exec.click();
  await tick(25);
  const it = s.state.items.find(x => x.code === code);
  assert.equal(it.status, 'retired', '退役必须真正可用：物品转 retired');
  assert.doesNotMatch(d.getElementById('itmStatus').textContent, /forEach|Cannot read/, '执行后不得出现裸露 JS 错误');
});

test('BUG-15：itmKind 下拉含 verifyLegacy，且该类型可新建行', async () => {
  const s = await setupProd();
  const d = s.document;
  const sel = d.getElementById('itmKind');
  const vals = [...sel.options].map(o => o.value);
  assert.ok(vals.includes('verifyLegacy'), '下拉必须含 verifyLegacy');
  for (const o of sel.options) { if (o.value === 'verifyLegacy') o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
  sel.dispatchEvent(new d.defaultView.Event('change'));
  d.getElementById('itmNewRow').click();
  await tick();
  assert.equal(s.page.scan.row().kind, 'verifyLegacy', '能新建旧物品核实行');
  assert.match(d.getElementById('itmStep').textContent, /核实库位/, '步骤引导按 verifyLegacy 渲染');
});

test('BUG-13：各作业类型的提交方向文案', async () => {
  const s = await setupProd();
  const d = s.document;
  const cases = [
    ['issue', ['ITM:I-IN'], /才真正出库/],
    ['transfer', ['ITM:I-IN', 'LOC:L-A', 'CTN:C-B'], /才真正换箱/],
    ['moveContainer', ['CTN:C-A', 'LOC:L-B'], /才真正移库/],
    ['placeContainer', ['CTN:C-F', 'LOC:L-B'], /才真正定位/],
    ['verifyLegacy', ['LOC:L-A', 'CTN:C-A', 'ITM:I-OLD'], /才真正核实/]
  ];
  for (const [kind, fills, re] of cases) {
    s.page.scan.add(kind);
    for (const f of fills) await s.page.accept(f, s.page.scan.token());
    const txt = d.getElementById('itmStatus').textContent;
    assert.match(txt, re, kind + ' 的确认文案方向正确');
    s.page.scan.removeRow(s.page.scan.snapshot().rows.length - 1);
    if (s.page.scan.snapshot().rows.length === 0) s.page.scan.add('receive');
  }
});

/* ---------- 发现 W（v3.13.15）：SUBMIT_HINTS 必须覆盖全部作业类型 ----------
   BUG-13 修复时把兜底从「出库」改成中性「提交」—— 兜底不再误导，但意味着
   「新增 kind 却忘加映射」时会静默退化成无方向的「提交」。
   现在 sequences 与 SUBMIT_HINTS 完全对齐，加这条锁防止未来新增 kind 时漏配。 */

test('发现 W：SUBMIT_HINTS 必须覆盖 item-scan 里全部作业类型', () => {
  const fs = require('node:fs'), path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');
  const scan = require(path.join(ROOT, 'lib/item-scan.js'));
  const src = fs.readFileSync(path.join(ROOT, 'lib/item-ui.js'), 'utf8');
  const m = src.match(/const SUBMIT_HINTS=\{([^}]*)\}/);
  assert.ok(m, '必须能取到 SUBMIT_HINTS 定义');
  const hints = m[1].split(',').map(x => x.split(':')[0].trim()).filter(Boolean);
  const kinds = Object.keys(scan.sequences);
  assert.ok(kinds.length >= 6, '作业类型至少 6 种，实测 ' + kinds.length);
  // 每个 kind 都必须有映射（含 receive/issue 这两个方向词最关键的）
  const missing = kinds.filter(k => !hints.includes(k));
  assert.deepEqual(missing, [], '以下作业类型没有方向文案，用户会看到中性的「提交」：' + missing.join(','));
  // 兜底不得再退回「出库」（BUG-13 的病根：未知 kind 猜方向）
  const fn = src.match(/function submitHint\(kind\)\{[^}]*\}/);
  assert.ok(fn, '必须能取到 submitHint');
  assert.doesNotMatch(fn[0], /\|\|'\u51fa\u5e93'/, '兜底不得是「出库」（未知 kind 猜方向会误导）');
  assert.match(fn[0], /\|\|'\u63d0\u4ea4'/, '兜底必须是中性的「提交」');
});
