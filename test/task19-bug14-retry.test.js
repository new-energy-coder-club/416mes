'use strict';
/* TASK-19（BUG-14）验收：未决卡「重试」在扫码行丢失时用 request 快照重建，不再死局。
   覆盖任务书 4 条：单件重建 / 批量重建一条 / 坏命令人话兜底 / 既有扫码行路径不回归。 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { parseHTML } = require('linkedom');
const UI = require('/srv/416mes/lib/item-ui');
const Store = require('/srv/416mes/lib/store.js');
const PERSIST = require('/srv/416mes/lib/item-persistence.js');
const Client = require('/srv/416mes/lib/item-client.js');

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

async function setupProd() {
  const html = fs.readFileSync('/srv/416mes/index.html', 'utf8');
  const { document } = parseHTML(html);
  let n = 0;
  const serverLog = [];
  let state = {
    locations: [{ code: 'L-A', status: 'active' }, { code: 'L-B', status: 'active' }],
    containers: [{ code: 'C-A', loc: 'L-A', status: 'active', version: 2 }, { code: 'C-B', loc: 'L-A', status: 'active', version: 1 }, { code: 'C-F', loc: '', status: 'active', version: 0 }],
    items: [
      { code: 'I-P', name: 'part', status: 'pending', version: 0 },
      { code: 'I-IN', name: '在库件', status: 'in_stock', container: 'C-A', version: 1 }
    ],
    itemOperations: [], __itmPending: {}
  };
  const store = Store.createMemoryStore();
  store.kind = 'indexeddb';
  await store.open();
  const persistence = PERSIST.create({ store, getState: () => state, publish: next => { state = next; }, canWrite: () => true });
  const client = Client.create({
    persistence,
    fetch: async (url, opts) => {
      const request = JSON.parse(opts.body || '{}');
      serverLog.push(JSON.parse(JSON.stringify(request)));
      /* 恒 REJECTED：终态可被 acknowledge 收口（出 outbox、进 itemOperations），
         且不触发 before/after 版本校验——重试流程断言只关心命令重建本身 */
      const operation = { code: request.opId, phase: 'REJECTED', request, error: 'VERSION_CONFLICT' };
      return { ok: true, status: 200, json: async () => ({ ok: true, operation }) };
    }
  });
  const page = UI.mount({
    document, getState: () => state, getPersistence: () => persistence,
    getCommands: async () => (await persistence.recover()).commands,
    getClient: () => client, isOnline: () => true, id: () => 'rb-' + (++n)
  });
  return {
    document, page, persistence, serverLog,
    get state() { return state; },
    async seedCommand(request) {   /* 入队一条命令并打成 needs_attention（未决卡） */
      await persistence.enqueue(request);
      await persistence.markUnknown(request.opId, '测试未决');
      await page.pending();
      return request.opId;
    },
    retryButtons() {
      return [...document.getElementById('itmPending').querySelectorAll('button')].filter(b => b.textContent === '重试（按最新数据）');
    },
    outboxIds() { return persistence.recover().then(r => r.commands.map(c => c.id)); }
  };
}

test('T19-1 单件：扫码行丢失后 retry 用快照重建（新 opId + 最新 expected + 旧命令 abandon）', async () => {
  const s = await setupProd();
  const oldId = await s.seedCommand({ schemaVersion: 1, opId: 'op-old', kind: 'receive', itemCode: 'I-P', target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 999, containerVersion: 999 } });
  s.page.scan.reset();   /* 模拟页面刷新：内存扫码行全部丢失 */
  const btns = s.retryButtons();
  assert.equal(btns.length, 1, '未决卡渲染出重试按钮');
  await btns[0].click();
  await tick(20);
  const st = s.document.getElementById('itmStatus').textContent;
  assert.doesNotMatch(st, /本地找不到对应的扫码行/, '死局文案必须消失');
  assert.doesNotMatch(st, /Cannot read|TypeError/, '不得裸奔英文错误');
  assert.match(st, /重试/, '重试流程完整走完（' + '状态行反馈）');
  const submitted = s.serverLog.filter(r => r.opId && r.opId !== oldId);
  assert.equal(submitted.length, 1, '重建出恰好一条新命令');
  const q = submitted[0];
  assert.equal(q.kind, 'receive');
  assert.notEqual(q.opId, oldId, '换新 opId');
  assert.equal(q.itemCode, 'I-P');
  assert.equal(q.target.loc, 'L-A');
  assert.equal(q.expected.itemVersion, 0, 'expected.itemVersion 取自最新 state（旧快照是 999）');
  assert.equal(q.expected.containerVersion, 2, 'expected.containerVersion 取自最新 state');
  const ids = await s.outboxIds();
  assert.ok(!ids.includes(oldId), '旧命令已被 abandon');
});

test('T19-2 批量：issueBatch 快照重建为一条批量命令（不是 N 条单件）', async () => {
  const s = await setupProd();
  const oldId = await s.seedCommand({
    schemaVersion: 1, opId: 'op-batch', kind: 'issueBatch', source: { loc: 'L-A' },
    items: [{ itemCode: 'I-IN', containerCode: 'C-A', expectedItemVersion: 999, expectedContainerVersion: 999 }]
  });
  s.page.scan.reset();
  const btns = s.retryButtons();
  assert.equal(btns.length, 1);
  await btns[0].click();
  await tick(20);
  const st = s.document.getElementById('itmStatus').textContent;
  assert.doesNotMatch(st, /本地找不到对应的扫码行/);
  const submitted = s.serverLog.filter(r => r.opId && r.opId !== oldId);
  assert.equal(submitted.length, 1, '整批只重建一条命令');
  const q = submitted[0];
  assert.equal(q.kind, 'issueBatch', '仍是批量类型');
  assert.ok(Array.isArray(q.items) && q.items.length === 1, 'items 数组保留');
  assert.equal(q.items[0].itemCode, 'I-IN');
  assert.equal(q.items[0].containerCode, 'C-A');
  assert.equal(q.items[0].expectedItemVersion, 1, '版本从最新镜像重派');
  assert.equal(q.items[0].expectedContainerVersion, 2);
  const ids = await s.outboxIds();
  assert.ok(!ids.includes(oldId), '旧批量命令已 abandon');
});

test('T19-3 坏命令（缺 itemCode）：人话兜底，不抛错不 abandon', async () => {
  const s = await setupProd();
  await s.seedCommand({ schemaVersion: 1, opId: 'op-bad', kind: 'receive', expected: { itemVersion: 1 } });
  s.page.scan.reset();
  const btns = s.retryButtons();
  await btns[0].click();
  await tick(15);
  const st = s.document.getElementById('itmStatus').textContent;
  assert.match(st, /无法自动重试（原因：/, '人话兜底文案');
  assert.match(st, /重新扫码/, '给出可操作指引');
  assert.match(st, /删除记录/, '给出清卡出口');
  assert.doesNotMatch(st, /Cannot read|TypeError|is not a function/, '不得裸奔英文');
  assert.doesNotMatch(st, /本地找不到对应的扫码行/, '旧死局文案不得回归');
  const ids = await s.outboxIds();
  assert.ok(ids.includes('op-bad'), '无法重建时保留卡片由用户决定');
});

test('T19-4 既有路径不回归：扫码行在时 retry 仍走行重建（行重新绑定新 opId）', async () => {
  const s = await setupProd();
  await s.seedCommand({ schemaVersion: 1, opId: 'op-row', kind: 'receive', itemCode: 'I-P', target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 2 } });
  /* 重建扫码行并绑到旧命令（模拟刷新前就在操作中） */
  s.page.scan.add('receive');
  await s.page.accept('LOC:L-A', s.page.scan.token());
  await s.page.accept('CTN:C-A', s.page.scan.token());
  await s.page.accept('ITM:I-P', s.page.scan.token());
  const row = s.page.scan.row();
  row.opId = 'op-row'; row.locked = true;
  const btns = s.retryButtons();
  await btns[0].click();
  await tick(20);
  const submitted = s.serverLog.filter(r => r.opId !== 'op-row');
  assert.equal(submitted.length, 1, '只提交一条重建命令');
  const q = submitted[0];
  assert.equal(q.kind, 'receive');
  assert.equal(q.itemCode, 'I-P', '重建自扫码行');
  assert.equal(q.expected.itemVersion, 0, 'expected 仍取最新 state');
  assert.equal(s.page.scan.row().opId, q.opId, '扫码行被重新绑定到新命令（行路径特征；快照路径不动行）');
  const ids = await s.outboxIds();
  assert.ok(!ids.includes('op-row'), '旧命令已 abandon');
  const st = s.document.getElementById('itmStatus').textContent;
  assert.doesNotMatch(st, /本地找不到对应的扫码行/);
});

test('T19-5 激活类：保留既有「安全重拉」引导，不受快照重建影响', async () => {
  const s = await setupProd();
  await s.seedCommand({ schemaVersion: 1, opId: 'op-act', kind: 'activateLocation', locationCode: 'L-B', expected: {} });
  s.page.scan.reset();
  const btns = s.retryButtons();
  await btns[0].click();
  await tick(15);
  const st = s.document.getElementById('itmStatus').textContent;
  assert.doesNotMatch(st, /本地找不到对应的扫码行|Cannot read/, '激活类不得死局');
  const ids = await s.outboxIds();
  assert.ok(!ids.includes('op-act'), '激活类重试会 abandon 旧命令走引导');
});

test('T19-6 批量坏清单（items 缺 itemCode）：同样人话兜底', async () => {
  const s = await setupProd();
  await s.seedCommand({ schemaVersion: 1, opId: 'op-bb', kind: 'issueBatch', source: { loc: 'L-A' }, items: [{ containerCode: 'C-A' }] });
  s.page.scan.reset();
  const btns = s.retryButtons();
  await btns[0].click();
  await tick(15);
  const st = s.document.getElementById('itmStatus').textContent;
  assert.match(st, /无法自动重试（原因：批量清单缺 itemCode）/);
  assert.doesNotMatch(st, /Cannot read|TypeError/);
  const ids = await s.outboxIds();
  assert.ok(ids.includes('op-bb'), '坏批量卡保留');
});

/* ---------- 发现 R（v3.13.13）：同一命令的提交/查询必须进程内串行 ---------- */

test('发现 R：executeCommand 以 method+id 为键复用 in-flight Promise（连点不产生重复请求）', () => {
  const src = fs.readFileSync('/srv/416mes/lib/item-ui.js', 'utf8');
  assert.match(src, /const _execInFlight = Object\.create\(null\);/, '必须有 in-flight 表');
  assert.match(src, /const inFlightKey = method \+ ':' \+ String\(\(c && c\.id\) \|\| ''\);/, '键必须是 method+命令id');
  assert.match(src, /if \(_execInFlight\[inFlightKey\]\) return _execInFlight\[inFlightKey\];/, '重复调用必须直接复用同一个 Promise');
  assert.match(src, /\.finally\(\(\) => \{ delete _execInFlight\[inFlightKey\]; \}\)/, '结束后必须清键（否则后续重试被永久挡住）');
  // 原函数体必须被保留为 _execCommandInner，而不是被替换掉
  assert.match(src, /async function _execCommandInner\(method,c,request\)\{/, '原逻辑必须搬到 _execCommandInner');
  assert.match(src, /let result;/, '回执处理逻辑保持原样');
});

test('发现 R：待处理卡动作按钮在飞行中禁用，结束后恢复', () => {
  const src = fs.readFileSync('/srv/416mes/lib/item-ui.js', 'utf8');
  assert.match(src, /const own=\[\.\.\.section\.querySelectorAll\('button'\)\];\s*own\.forEach\(b=>\{b\.disabled=true;\}\);/,
    '执行前必须禁用本卡所有按钮');
  assert.match(src, /finally\{ own\.forEach\(b=>\{b\.disabled=false;\}\);/,
    '结束后必须恢复（不能被永久禁用，否则用户只能刷新）');
  // 恢复后还要刷新待处理区（否则卡面状态不更新）
  assert.ok(src.includes("if(typeof pending==='function'){try{await pending();}catch(_){ }"), '恢复后必须刷新待处理区');
});
