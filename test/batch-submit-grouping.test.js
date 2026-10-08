'use strict';
/* v3.13.36（去锚点批量）· 提交分组（U4）：批量入库全部扫完一次提交，内部按行首 LOC
   分组——每组一条 receiveBatch 原子命令（协议零改动，A1），组间无依赖、行序稳定；
   子位组 target.sub===true；批量出库仍一条 issueBatch 且 source:{}（TASK-11 S2 先例）。
   版本重派（U5）：条目版本一律提交时从 getState() 取最新。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const UI = require('../lib/item-ui');
const U = require('../lib/unique-items');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function mkState() {
  const st = {
    locations: [
      { code: 'L-A', status: 'active' },
      { code: 'L-B', status: 'active' },
      { code: 'SUB-1', status: 'active', role: '容器子位', parentContainer: 'C-S' }
    ],
    containers: [
      { code: 'C-A', loc: 'L-A', status: 'active', version: 2 },
      { code: 'C-B', loc: 'L-B', status: 'active', version: 5 },
      { code: 'C-S', loc: '', status: 'active', version: 3 }
    ],
    items: [
      { code: 'WP-TS-001', status: 'pending', container: '', version: 0 },
      { code: 'WP-TS-002', status: 'pending', container: '', version: 0 },
      { code: 'WP-TS-003', status: 'pending', container: '', version: 0 },
      { code: 'WP-TS-004', status: 'pending', container: '', version: 0 },
      { code: 'WP-TS-005', status: 'in_stock', container: 'C-A', version: 1 },
      { code: 'WP-TS-006', status: 'in_stock', loc: 'SUB-1', container: '', version: 1 }
    ],
    itemOperations: []
  };
  U.migrate(st);
  return st;
}
function setup() {
  const box = { st: mkState() };
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const { document } = parseHTML(html);
  document.defaultView.ItemLink = require('../lib/item-link');
  document.defaultView.CtnLink = require('../lib/ctn-link');
  const enqueued = [];
  let n = 0;
  const page = UI.mount({ document, getState: () => box.st, getPersistence: () => ({ async enqueue(r) { enqueued.push(JSON.parse(JSON.stringify(r))); }, async saveDraft() {}, async recover() { return { drafts: [], commands: [] }; } }), getCommands: async () => [], id: () => 'bsg-' + (++n) });
  const fill = async t => { document.getElementById('itmCode').value = t; document.getElementById('itmScanBtn').click(); await tick(); };
  return { document, page, st: box.st, enqueued, fill };
}

test('BSG-1 提交分组：同库位两件合一条、不同库位各一条（行序稳定），行 opId 归组、提交后退出批量', async () => {
  const { document: d, page, enqueued, fill } = setup();
  d.getElementById('itmBatchStart-receive').click(); await tick();
  page.scan.setBatchQty(3);
  await fill('LOC:L-A'); await fill('CTN:C-A'); await fill('ITM:WP-TS-001');   /* 行1：L-A/C-A */
  await fill('LOC:L-B'); await fill('CTN:C-B'); await fill('ITM:WP-TS-002');   /* 行2：L-B/C-B */
  await fill('LOC:L-A'); await fill('CTN:C-A'); await fill('ITM:WP-TS-003');   /* 行3：L-A/C-A（行满自动开行） */
  d.getElementById('itmConfirm').click(); await tick(12);
  assert.equal(enqueued.length, 2, '两库位 → 恰两条 receiveBatch 命令');
  assert.deepEqual(enqueued.map(r => r.kind), ['receiveBatch', 'receiveBatch']);
  const gA = enqueued[0], gB = enqueued[1];
  /* 组顺序=行序稳定：L-A 组（行1、行3）在前 */
  assert.deepEqual(gA.target, { loc: 'L-A' });
  assert.deepEqual(gA.items.map(x => x.itemCode), ['WP-TS-001', 'WP-TS-003'], '同组两件、行序稳定');
  assert.deepEqual(gA.items[0], { itemCode: 'WP-TS-001', containerCode: 'C-A', expectedItemVersion: 0, expectedContainerVersion: 2 }, 'U5：版本提交时从最新镜像重派');
  assert.deepEqual(gB.target, { loc: 'L-B' });
  assert.deepEqual(gB.items.map(x => x.itemCode), ['WP-TS-002']);
  assert.notEqual(gA.opId, gB.opId, '每组独立 opId（同 opId 会触发 OP_ID_PAYLOAD_CONFLICT）');
  /* 行锁定挂对应组 opId */
  const snap = page.scan.snapshot();
  const rows = snap.rows.filter(r => r.locked);
  assert.equal(rows.length, 3, '三行全部锁定');
  const opA = rows.filter(r => r.values[0].code === 'L-A').map(r => r.opId);
  assert.deepEqual([...new Set(opA)], [gA.opId], 'L-A 两行挂组A opId');
  assert.equal(rows.find(r => r.values[0].code === 'L-B').opId, gB.opId, 'L-B 行挂组B opId');
  assert.equal(page.scan.batchState(), null, '提交后退出批量模式');
  assert.match(d.getElementById('itmStatus').textContent, /2 条「批量入库」命令（按库位分组，组间无依赖）/);
});

test('BSG-2 子位组：全 2 值行 → target.sub===true 且条目无 containerCode（P3 形状）', async () => {
  const { document: d, page, enqueued, fill } = setup();
  d.getElementById('itmBatchStart-receive').click(); await tick();
  page.scan.setBatchQty(2);
  await fill('LOC:SUB-1'); await fill('ITM:WP-TS-001');
  await fill('LOC:SUB-1'); await fill('ITM:WP-TS-002');   /* 子位行满自动开行，第二件同子位 */
  d.getElementById('itmConfirm').click(); await tick(12);
  assert.equal(enqueued.length, 1, '同子位库位 → 一条命令');
  const req = enqueued[0];
  assert.deepEqual(req.target, { loc: 'SUB-1', container: '', sub: true });
  assert.deepEqual(req.items, [{ itemCode: 'WP-TS-001', expectedItemVersion: 0 }, { itemCode: 'WP-TS-002', expectedItemVersion: 0 }], '子位条目无 containerCode/expectedContainerVersion 键');
});

test('BSG-3 批量出库：一条 issueBatch、source 深等 {}（TASK-11 S2 先例），子位/容器件逐条取形', async () => {
  const { document: d, page, enqueued, fill } = setup();
  d.getElementById('itmBatchStart-issue').click(); await tick();
  page.scan.setBatchQty(2);
  await fill('ITM:WP-TS-005');   /* 容器链件（C-A） */
  await fill('ITM:WP-TS-006');   /* 子位直存件（loc=SUB-1） */
  d.getElementById('itmConfirm').click(); await tick(12);
  assert.equal(enqueued.length, 1, '出库仍一条命令');
  const req = enqueued[0];
  assert.equal(req.kind, 'issueBatch');
  assert.deepEqual(req.source, {}, 'source 不再传展示锚点');
  assert.deepEqual(req.items[0], { itemCode: 'WP-TS-005', containerCode: 'C-A', expectedItemVersion: 1, expectedContainerVersion: 2 });
  assert.deepEqual(req.items[1], { itemCode: 'WP-TS-006', sub: true, locCode: 'SUB-1', expectedItemVersion: 1 }, 'P3：子位件条目带 sub/locCode');
  assert.equal(page.scan.batchState(), null);
});

test('BSG-补丁：原子批量入队失败不能锁行或退出批量模式（UI 仍可重试）', async () => {
  const st = mkState();
  const { document: d } = parseHTML(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'));
  d.defaultView.ItemLink = require('../lib/item-link');
  d.defaultView.CtnLink = require('../lib/ctn-link');
  let tries = 0, fallbackCalls = 0;
  let seq = 0;
  const p = {
    async enqueueBatch() { tries++; throw Error('IDB_WRITE_ABORTED'); },
    async enqueue() { fallbackCalls++; throw Error('MUST_NOT_FALLBACK'); },
    async saveDraft() {},
    async recover() { return { drafts: [], commands: [] }; }
  };
  const page = UI.mount({ document: d, getState: () => st, getPersistence: () => p,
    getCommands: async () => [], id: () => 'patch-'+(++seq) });
  const scan = async txt => {
    d.getElementById('itmCode').value = txt;
    d.getElementById('itmScanBtn').click();
    await tick();
  };
  d.getElementById('itmBatchStart-receive').click(); await tick();
  page.scan.setBatchQty(2);
  await scan('LOC:L-A'); await scan('CTN:C-A'); await scan('ITM:WP-TS-001');
  await scan('LOC:L-B'); await scan('CTN:C-B'); await scan('ITM:WP-TS-002');
  d.getElementById('itmConfirm').click(); await tick(16);
  assert.equal(tries, 1);
  assert.equal(fallbackCalls, 0, '正式提供 enqueueBatch 的持久化不许静默退回逐组入队');
  assert.equal(page.scan.snapshot().rows.filter(r => r.locked).length, 0, '所有行保持未锁定');
  assert.ok(page.scan.batchState(), '失败后仍保留当前批，可重试');
  assert.equal(page.scan.snapshot().rows.filter(r => r.values.some(v => v.type === 'ITM')).length, 2);
});
