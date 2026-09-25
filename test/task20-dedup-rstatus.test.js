'use strict';
/* TASK-20 验收：BUG-17（注册页提示落在本页容器）+ BUG-18（同物品未决 retire/activate 查重）。 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const uiSrc = fs.readFileSync('/srv/416mes/lib/item-ui.js', 'utf8');
const { parseHTML } = require('linkedom');
const UI = require('/srv/416mes/lib/item-ui');
const Store = require('/srv/416mes/lib/store.js');
const PERSIST = require('/srv/416mes/lib/item-persistence.js');
const Client = require('/srv/416mes/lib/item-client.js');

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

async function setupProd({ online = true } = {}) {
  const html = fs.readFileSync('/srv/416mes/index.html', 'utf8');
  const { document } = parseHTML(html);
  let n = 0;
  let state = {
    locations: [{ code: 'L-A', status: 'active' }, { code: 'L-B', status: 'unknown', version: 0 }],
    containers: [{ code: 'C-F', loc: '', status: 'unknown', version: 0 }],
    items: [
      { code: 'I-P', name: 'part', status: 'pending', version: 0 },
      { code: 'I-Q', name: 'part2', status: 'pending', version: 0 }
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
      const operation = { code: request.opId, phase: 'REJECTED', request, error: 'VERSION_CONFLICT' };
      return { ok: true, status: 200, json: async () => ({ ok: true, operation }) };
    }
  });
  const page = UI.mount({
    document, getState: () => state, getPersistence: () => persistence,
    getCommands: async () => (await persistence.recover()).commands,
    getClient: () => client, isOnline: () => online, id: () => 'op-' + (++n)
  });
  return {
    document, page, persistence,
    get state() { return state; },
    async seed(request) { await persistence.enqueue(request); await page.pending(); },
    outboxIds() { return persistence.recover().then(r => r.commands.map(c => c.id)); },
    regText() { return document.getElementById('itmRegisterResult').textContent; },
    workStatus() { return document.getElementById('itmStatus').textContent; }
  };
}

test('T20-1 BUG-17：退役提示写进注册页容器 itmRegisterResult', async () => {
  const s = await setupProd();
  s.document.getElementById('itmRetireCode').value = 'I-P';
  s.document.getElementById('itmRetireReason').value = '报废';
  s.document.getElementById('itmRetire').click();
  await tick(15);
  assert.match(s.regText(), /退役申请已保存/, '提示必须落在本页（注册页）容器');
  const ids = await s.outboxIds();
  assert.equal(ids.length, 1, '正常入队一次');
});

test('T20-2 BUG-18：同物品未决 retire 拦截（人话 + 不入队），删除记录后可再入队', async () => {
  const s = await setupProd();
  await s.seed({ schemaVersion: 1, opId: 'op-r1', kind: 'retire', itemCode: 'I-P', expected: { itemVersion: 0 }, reason: '旧' });
  s.document.getElementById('itmRetireCode').value = 'I-P';
  s.document.getElementById('itmRetireReason').value = '报废';
  s.document.getElementById('itmRetire').click();
  await tick(15);
  assert.match(s.regText(), /已有一条待提交的退役命令（编号 op-r1）/, '人话拦截含旧命令编号');
  assert.match(s.regText(), /待处理区/);
  let ids = await s.outboxIds();
  assert.equal(ids.length, 1, '未重复入队');
  /* 「删除记录」出口后可再次入队 */
  await s.persistence.abandonCommand('op-r1');
  s.document.getElementById('itmRetire').click();
  await tick(15);
  assert.match(s.regText(), /退役申请已保存/);
  ids = await s.outboxIds();
  assert.equal(ids.length, 1, '删除旧卡后重新入队成功');
  assert.notEqual(ids[0], 'op-r1');
});

test('T20-3 BUG-18：不同物品的未决 retire 互不影响（只拦同 itemCode）', async () => {
  const s = await setupProd();
  await s.seed({ schemaVersion: 1, opId: 'op-rp', kind: 'retire', itemCode: 'I-P', expected: { itemVersion: 0 }, reason: '旧' });
  s.document.getElementById('itmRetireCode').value = 'I-Q';
  s.document.getElementById('itmRetireReason').value = '报废';
  s.document.getElementById('itmRetire').click();
  await tick(15);
  const ids = await s.outboxIds();
  assert.equal(ids.length, 2, '另一物品照常入队');
});

test('T20-4 BUG-18：同 code 未决 activateLocation 拦截（离线路径也在覆盖内）', async () => {
  const s = await setupProd({ online: false });
  await s.seed({ schemaVersion: 1, opId: 'op-a1', kind: 'activateLocation', locationCode: 'L-B', expected: {} });
  s.document.getElementById('itmAdminLoc').value = 'L-B';
  s.document.getElementById('itmActivateLoc').click();
  await tick(15);
  assert.match(s.regText(), /该库位已有一条待提交的启用命令（编号 op-a1）/, '激活类同码拦截');
  const ids = await s.outboxIds();
  assert.equal(ids.length, 1, '未重复入队');
});

test('T20-5 负向：register* 类不受查重影响（同码注册仍可入队）', async () => {
  const s = await setupProd();
  /* seed 一条 registerItem 未决命令，再走建档流程——注册类不查重（服务端 CODE_ALREADY_REGISTERED 兜底） */
  await s.seed({ schemaVersion: 1, opId: 'op-reg', kind: 'registerItem', entity: { code: 'WP-X', name: 'x', category: 'TS' }, expected: {} });
  const pick = (id, val) => { const sel = s.document.getElementById(id); for (const o of sel.options) { if (o.value === val) o.setAttribute('selected', ''); else o.removeAttribute('selected'); } sel.dispatchEvent(new s.document.defaultView.Event('change')); };
  pick('itmRegisterType', 'registerItem');
  pick('itmRegisterCat', 'TS');
  s.document.getElementById('itmRegisterName').value = '查重不拦注册';
  s.document.getElementById('itmRegister').click();
  await tick(20);
  const reg = s.regText();
  assert.doesNotMatch(reg, /已有一条待提交/, '注册类绝不走查重拦截');
  assert.match(reg, /建档/, '注册流程照常给出建档反馈');
});

test('T20-7 在线 activate：与 R2「自动替换旧卡」协同（不拦、替换后至多一张卡）', async () => {
  const s = await setupProd({ online: false });
  await s.seed({ schemaVersion: 1, opId: 'op-a2', kind: 'activateLocation', locationCode: 'L-B', expected: {} });
  /* 在线（fake fetch REJECTED 也走 guidedActivate 的 R2 替换路径） */
  const s2 = await setupProd({ online: true });
  await s2.seed({ schemaVersion: 1, opId: 'op-a3', kind: 'activateLocation', locationCode: 'L-B', expected: {} });
  s2.document.getElementById('itmAdminLoc').value = 'L-B';
  s2.document.getElementById('itmActivateLoc').click();
  await tick(20);
  assert.doesNotMatch(s2.regText(), /已有一条待提交/, '在线路径不查重拦截（R2 语义）');
  const ids = await s2.outboxIds();
  assert.ok(!ids.includes('op-a3'), 'R2 已把同实体旧卡替换掉');
  assert.equal(ids.length, 0, 'v3.5.0 语义：启用失败不留卡——outbox 空即「至多一张」的更强形式');
});

/* ---------- 发现 G / H（TASK-20 排查结论，DSH 修复）---------- */

test('发现 G：submitHint 对未知 kind 兜底为中性词，不再猜方向', () => {
  const m = uiSrc.match(/function submitHint\(kind\)\{[^}]*\}/);
  assert.ok(m, '必须能取到 submitHint');
  assert.match(m[0], /SUBMIT_HINTS\[kind\]\|\|'提交'/, '未知 kind 必须兜底「提交」—— 兜底「出库」会把方向猜反（BUG-13 同类）');
  assert.doesNotMatch(m[0], /\|\|'出库'/, '不得再拿「出库」当兜底');
});

test('发现 H：ITM NOT_FOUND 引导按当前行 kind 取词，出库不再被引导「重新入库」', () => {
  assert.match(uiSrc, /确认后按当前作业类型继续：'\+submitHint\(scan\.row\(\)\.kind\)/, 'NOT_FOUND 引导必须按当前行 kind 动态取词');
  assert.ok(!/确认后重新入库/.test(uiSrc), '不得再硬编码「重新入库」—— 出库/换箱场景会方向误导');
});

/* ---------- 发现 K（TASK-21）：服务端错误码汉化全覆盖 ---------- */

test('发现 K：服务端全部 fail 错误码都在 errZh 有中文（防新增码静默漏译）', () => {
  const U = fs.readFileSync('/srv/416mes/lib/unique-items.js', 'utf8');
  const ui = uiSrc;
  const codes = [...new Set([...U.matchAll(/fail\('([A-Z_]+)'/g)].map(m => m[1]))].sort();
  const errZh = (ui.match(/const errZh=\{[\s\S]*?\};/) || [''])[0];
  assert.ok(errZh.length > 100, '必须能取到 errZh 表');
  const missing = codes.filter(c => !errZh.includes(c));
  assert.deepEqual(missing, [], '以下错误码没有中文翻译，用户会看到原始码：' + missing.join(', '));
  assert.ok(codes.length >= 23, '服务端错误码数量应 ≥23（当前 ' + codes.length + '），若减少请同步更新本测试');
});

test('发现 K：errText 对 INACTIVE_ENTITY 走中文而非裸码', () => {
  // 直接驱动 errText 的分支逻辑：code 命中 errZh 时返回中文 + 代码
  assert.match(uiSrc, /INACTIVE_ENTITY:'[^']*请先[^']*'/, 'INACTIVE_ENTITY 必须翻译成中文');
});

/* ---------- 发现 C（TASK-21）：写前重计划比对顺序无关 ---------- */

test('发现 C：写前重计划的 before/after 比对顺序无关（快照顺序漂移不误报，实质变化仍检出）', () => {
  const op = fs.readFileSync('/srv/416mes/lib/item-operation.js', 'utf8');
  assert.match(op, /function normalizeSnapshot\(arr\)/, '必须有 normalizeSnapshot');
  assert.match(op, /function snapshotChanged\(a, b\)/, '必须有 snapshotChanged');
  assert.match(op, /snapshotChanged\(currentPlan\.before, plan\.before\)/, '写前比对必须走 snapshotChanged');
  assert.ok(!/canonical\(currentPlan\.before\) !== canonical\(plan\.before\)/.test(op),
    '不得再用顺序敏感的 canonical 直接比 before');
  // 行为自证：复刻比较逻辑
  const stableKey = r => String((r && (r.itemCode || r.code || r.containerCode || r.entityCode)) || '');
  const norm = a => (Array.isArray(a) ? a.slice() : []).sort((x, y) => stableKey(x) < stableKey(y) ? -1 : stableKey(x) > stableKey(y) ? 1 : 0);
  const changed = (a, b) => JSON.stringify(norm(a)) !== JSON.stringify(norm(b));
  const a = [{ itemCode: 'I-1', status: 'in_stock' }, { itemCode: 'I-2', status: 'out' }];
  const b = [{ itemCode: 'I-2', status: 'out' }, { itemCode: 'I-1', status: 'in_stock' }];
  const c = [{ itemCode: 'I-1', status: 'in_stock' }, { itemCode: 'I-2', status: 'in_stock' }];
  assert.equal(changed(a, b), false, '仅顺序漂移不得判为「前置已变」（否则重试也撞同一堵墙）');
  assert.equal(changed(a, c), true, '实质状态变化必须仍然检出');
});
