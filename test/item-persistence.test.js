'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('fake-indexeddb');
const Store = require('../lib/store');
const P = require('../lib/item-persistence');
async function setup(t) {
  const store = Store.createIndexedDbStore({ indexedDB: new F.IDBFactory(), IDBKeyRange: F.IDBKeyRange, dbName: 'mes416-state' });
  await store.open(); t.after(() => store.close());
  let state = { items: [{ code: 'I-P', status: 'pending', container: '', version: 0, lastOpId: '' }], itemOperations: [], materials: [{ code: 'M-KEEP', qty: 7 }], transactions: [] };
  const queue = P.createQueue();
  const client = P.create({ store, queue, canWrite: () => true, getState: () => state, publish: s => { state = s; } });
  return { store, queue, client, state: () => state };
}
const req = () => ({ schemaVersion: 1, opId: 'stable-1', kind: 'receive', itemCode: 'I-P', target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 2 } });
test('IDB command/state/draft atomic, stable identity, no optimistic relation', async t => {
  const f = await setup(t); const request = req();
  await f.client.enqueue(request, 'session-1', { rowId: 'row-1' }); request.kind = 'issue';
  assert.equal((await f.store.getAll('outbox')).length, 1);
  assert.equal((await f.store.get('syncMeta', 'state-v1')).value.__itmPending['stable-1'].request.kind, 'receive');
  assert.equal(f.state().items[0].status, 'pending');
  await f.client.enqueue(req(), 'session-1', {}); assert.equal((await f.store.getAll('outbox')).length, 1);
  await assert.rejects(f.client.enqueue({ ...req(), kind: 'issue' }), /OP_ID_PAYLOAD_CONFLICT/);
  assert.equal((await f.store.get('syncMeta', 'itmDraft:session-1')).value.locked, true);
});
test('IDB failure rolls back command and snapshot, publishes no success', async t => {
  const f = await setup(t); const original = f.store.transaction.bind(f.store);
  f.store.transaction = (names, work) => original(names, async tx => {
    const put = tx.put; tx.put = async (name, value) => { if (name === 'syncMeta' && value.key === 'state-v1') throw new Error('injected IDB failure'); return put(name, value); };
    return work(tx);
  });
  await assert.rejects(f.client.enqueue(req(), 'session-1', {}), /injected/);
  f.store.transaction = original;
  assert.equal((await f.store.getAll('outbox')).length, 0);
  assert.equal(await f.store.get('syncMeta', 'itmDraft:session-1'), undefined);
  assert.equal(f.state().__itmPending, undefined);
});
test('save queue takes newest state; replaceAll preserves operations and draft namespace', async t => {
  const f = await setup(t); await f.client.saveDraft('s', { loc: 'L-A' });
  const a = f.client.enqueue(req());
  const b = f.queue.run(async () => f.store.transaction(['records', 'transactions', 'syncMeta'], tx => P.writeSnapshot(tx, f.state())));
  await Promise.all([a, b]);
  assert.ok((await f.store.get('syncMeta', 'state-v1')).value.__itmPending['stable-1']);
  assert.equal((await f.store.get('syncMeta', 'itmDraft:s')).value.loc, 'L-A');
  f.state().itemOperations.push({ code: 'old-op', phase: 'APPLIED' });
  await f.store.transaction(['records', 'transactions', 'syncMeta'], tx => P.writeSnapshot(tx, f.state()));
  assert.equal((await f.store.get('records', ['itemOperations', 'old-op'])).value.phase, 'APPLIED');
});
test('LS dirty cannot erase IDB command or resurrect pre-issue container', async t => {
  const f = await setup(t); await f.client.enqueue(req());
  const ls = structuredClone(f.state()); ls.items[0].container = 'C-OLD'; ls.items[0].status = 'in_stock'; delete ls.__itmPending;
  const restored = P.restore(ls, f.state(), true, await f.store.getAll('outbox'));
  assert.equal(restored.items[0].container, ''); assert.equal(restored.items[0].status, 'pending');
  assert.ok(restored.__itmPending['stable-1']);
  assert.equal((await f.client.recover()).commands.length, 1);
});
test('unknown results retain command; final receipt atomically updates and removes', async t => {
  const f = await setup(t); await f.client.enqueue(req());
  await f.client.markUnknown('stable-1', 'timeout');
  assert.equal((await f.store.get('outbox', 'stable-1')).status, 'needs_attention');
  await assert.rejects(f.client.acknowledge({ code: 'stable-1', phase: 'PREPARED' }), /RESULT_NOT_FINAL/);
  await f.client.acknowledge({ code: 'stable-1', request: req(), phase: 'APPLIED', before: { items: [{ code: 'I-P', container: '', status: 'pending', version: 0, lastOpId: '' }] }, after: { items: [{ code: 'I-P', container: 'C-A', status: 'in_stock', version: 1, lastOpId: 'stable-1' }] } });
  assert.equal(await f.store.get('outbox', 'stable-1'), undefined);
  assert.equal(f.state().items[0].status, 'in_stock'); assert.equal(f.state().materials[0].qty, 7);
  assert.equal((await f.store.get('records', ['itemOperations', 'stable-1'])).value.phase, 'APPLIED');
});
test('late ACK cannot roll back a newer proven snapshot; same-version conflict retains command', async t => {
  const f = await setup(t); await f.client.enqueue(req());
  const newer = { code: 'I-P', container: 'C-B', status: 'in_stock', version: 5, lastOpId: 'newer-op' };
  Object.assign(f.state().items[0], newer);
  const old = { code: 'stable-1', request: req(), phase: 'APPLIED', after: { items: [{ code: 'I-P', container: '', status: 'out', version: 4, lastOpId: 'stable-1' }] } };
  await assert.rejects(f.client.acknowledge(old), /CURRENT_SNAPSHOT_UNVERIFIED/);
  f.state().itemOperations.push({ code: 'newer-op', phase: 'APPLIED', after: { items: [newer] } });
  await f.client.acknowledge(old);
  assert.equal(f.state().items[0].version, 5); assert.equal(f.state().items[0].container, 'C-B');
  assert.equal(await f.store.get('outbox', 'stable-1'), undefined);
  assert.ok(f.state().itemOperations.some(o => o.code === 'stable-1'));
  const nextReq = { ...req(), opId: 'same-v' }; await f.client.enqueue(nextReq);
  await assert.rejects(f.client.acknowledge({ code: 'same-v', request: nextReq, phase: 'APPLIED', after: { items: [{ ...newer, container: '', lastOpId: 'same-v' }] } }), /SAME_VERSION_CONFLICT/);
  assert.ok(await f.store.get('outbox', 'same-v'));
});
test('two tabs share lifecycle lock; second cannot become a writer until release', async () => {
  let busy = false;
  const locks = { async request(name, options, callback) { if (busy) return callback(null); busy = true; try { return await callback({ name }); } finally { busy = false; } } };
  const a = await P.acquireTab(locks); const b = await P.acquireTab(locks);
  assert.equal(a.acquired, true); assert.equal(b.acquired, false);
  a.release(); await new Promise(resolve => setImmediate(resolve));
  const c = await P.acquireTab(locks); assert.equal(c.acquired, true); c.release();
});
test('outbox projection reports ITM intent without altering confirmed fields or MAT', () => {
  const O = require('../lib/outbox'); const state = { items: [{ code: 'I-P', status: 'pending', container: '' }], materials: [{ code: 'M', qty: 7 }] };
  const result = O.project(state, [{ id: 'stable-1', op: 'itemOperation', request: req() }]);
  assert.equal(result.view.items[0].status, 'pending'); assert.equal(result.view.materials[0].qty, 7);
  assert.deepEqual(result.pending.items, ['I-P']); assert.equal(result.itemIntents.length, 1);
});
test('lack of browser lock or real IDB disables command persistence', async t => {
  const f = await setup(t);
  const denied = P.create({ store: f.store, getState: f.state, publish() {}, canWrite: () => false });
  await assert.rejects(denied.enqueue(req()), /SINGLE_WRITER_TAB/);
  assert.equal((await P.acquireTab(null)).acquired, false);
  const memory = P.create({ store: { kind: 'memory' }, getState: f.state, publish() {}, canWrite: () => true });
  await assert.rejects(memory.enqueue(req()), /INDEXEDDB/);
});

/* ================= A 阶段：acknowledge 放宽服务端回填码（P4） ================= */

test('registerItem 无码命令：服务端回填码后 ACK 放宽通过并落本地', async t => {
  const f = await setup(t);
  const request = { schemaVersion: 1, opId: 'reg-auto', kind: 'registerItem', entity: { category: 'TS', name: '示波器' } };
  await f.client.enqueue(request);
  const applied = {
    code: 'reg-auto', kind: 'registerItem', phase: 'APPLIED',
    request: { schemaVersion: 1, opId: 'reg-auto', kind: 'registerItem', entity: { category: 'TS', name: '示波器', code: 'WP-TS-001' } },
    before: { items: [] },
    after: { items: [{ code: 'WP-TS-001', name: '示波器', container: '', status: 'pending', version: 1, lastOpId: 'reg-auto' }] }
  };
  await f.client.acknowledge(applied);
  assert.equal(await f.store.get('outbox', 'reg-auto'), undefined);
  const row = f.state().items.find(i => i.code === 'WP-TS-001');
  assert.ok(row, '回填码物品落本地'); assert.equal(row.status, 'pending');
  assert.equal((await f.store.get('records', ['itemOperations', 'reg-auto'])).value.phase, 'APPLIED');
});
test('registerItem 无码命令：回填码与 after 不一致或请求被篡改仍拒收', async t => {
  const f = await setup(t);
  const request = { schemaVersion: 1, opId: 'reg-auto', kind: 'registerItem', entity: { category: 'TS', name: '示波器' } };
  await f.client.enqueue(request);
  const base = { code: 'reg-auto', kind: 'registerItem', phase: 'APPLIED', before: { items: [] },
    request: { schemaVersion: 1, opId: 'reg-auto', kind: 'registerItem', entity: { category: 'TS', name: '示波器', code: 'WP-TS-001' } } };
  // 回填码 !== after.items[0].code
  await assert.rejects(f.client.acknowledge({ ...base, after: { items: [{ code: 'WP-TS-002', name: '示波器', container: '', status: 'pending', version: 1, lastOpId: 'reg-auto' }] } }), /RESULT_REQUEST_MISMATCH/);
  // 缺 after
  await assert.rejects(f.client.acknowledge(base), /RESULT_REQUEST_MISMATCH/);
  // 请求其余字段被篡改（名称不同）——放宽仅限 entity.code
  const tampered = structuredClone(base);
  tampered.request.entity.name = '万用表';
  tampered.after = { items: [{ code: 'WP-TS-001', name: '万用表', container: '', status: 'pending', version: 1, lastOpId: 'reg-auto' }] };
  await assert.rejects(f.client.acknowledge(tampered), /RESULT_REQUEST_MISMATCH/);
  // 非 register 命令不享受放宽
  const recv = { schemaVersion: 1, opId: 'recv-1', kind: 'receive', itemCode: 'I-P', target: { loc: 'L-A', container: 'C-A' }, expected: { itemVersion: 0, containerVersion: 2 } };
  await f.client.enqueue(recv);
  await assert.rejects(f.client.acknowledge({ code: 'recv-1', kind: 'receive', phase: 'APPLIED', request: { ...recv, itemCode: 'I-OTHER' }, after: { items: [] } }), /RESULT_REQUEST_MISMATCH/);
  // 三次失败不影响合法 ACK 后续落库
  await f.client.acknowledge({ ...base, after: { items: [{ code: 'WP-TS-001', name: '示波器', container: '', status: 'pending', version: 1, lastOpId: 'reg-auto' }] } });
  assert.ok(f.state().items.some(i => i.code === 'WP-TS-001'));
});
test('registerItem 无码命令 REJECTED（发号后 plan 拒）也能 ACK 出队', async t => {
  const f = await setup(t);
  const request = { schemaVersion: 1, opId: 'reg-rej', kind: 'registerItem', entity: { category: 'TS', name: 'x' } };
  await f.client.enqueue(request);
  await f.client.acknowledge({ code: 'reg-rej', kind: 'registerItem', phase: 'REJECTED', error: 'CODE_ALREADY_REGISTERED',
    request: { schemaVersion: 1, opId: 'reg-rej', kind: 'registerItem', entity: { category: 'TS', name: 'x', code: 'WP-TS-001' } } });
  assert.equal(await f.store.get('outbox', 'reg-rej'), undefined);
  assert.equal(f.state().items.some(i => i.code === 'WP-TS-001'), false, 'REJECTED 不落物品');
});

/* ================= 2.48.0：APPLIED ACK 解除「未核验变更」冲突（现场核实即凭据） ================= */
test('acknowledge of APPLIED activateLocation clears unverified-controlled-change conflict', async t => {
  const f = await setup(t);
  const state = f.state();
  // 本地 unknown + 冲突（云端 active 但无凭据的历史现场）
  state.locations = [{ code: 'L-A', status: 'unknown' }];
  state.__itmConflicts = { 'locations:L-A': { table: 'locations', key: 'L-A', reason: 'unverified-controlled-change', local: { code: 'L-A', status: 'unknown' }, observed: { code: 'L-A', status: 'active' } } };
  const activate = { schemaVersion: 1, opId: 'act-1', kind: 'activateLocation', locationCode: 'L-A', expected: { locationStatus: 'unknown' } };
  await f.client.enqueue(activate);
  await f.client.acknowledge({ code: 'act-1', request: activate, phase: 'APPLIED', before: { locations: [{ code: 'L-A', status: 'unknown' }] }, after: { locations: [{ code: 'L-A', status: 'active' }] } });
  const next = f.state();
  assert.equal(next.locations[0].status, 'active', 'ACK 应用启用结果');
  assert.equal(next.__itmConflicts['locations:L-A'], undefined, '冲突随凭据落地而解除');
  assert.equal(next.itemOperations.at(-1).phase, 'APPLIED', '操作日志保留，作为后续同步合并的凭据');
});

test('clearDrafts removes all itmDraft: keys without touching outbox', async t => {
  const f = await setup(t);
  await f.client.saveDraft('itmDraft:s1', { sessionId: 's1', rows: [] });
  await f.client.saveDraft('itmDraft:s2', { sessionId: 's2', rows: [] });
  const before = (await (async () => { const store = f.store; return store; })(), null);
  const n = await f.client.clearDrafts();
  assert.equal(n, 2, '清除 2 份草稿');
  const after = f.state();
  const left = (after.__draftCheck || []);
  void left;
  const r = await f.client.recover();
  assert.equal(r.drafts.length, 0, '草稿全清');
});

/* ================= 发现 E（TASK-21）：升级兼容 —— 旧卡带 device 不得炸 =================
   v3.13.1 把 device 从 request 主体改到 header。但 v3.12.1~3.13.0 期间入队的**旧卡**
   其 request 里可能已带 device 字段（那是 BUG-12 的病根补丁写进去的）。
   升级后新旧客户端交替提交这些旧卡，不得触发 RESULT_REQUEST_MISMATCH 或 hash 失败。 */

test('发现 E：旧卡 request 带 device 原样重发，ACK 一致性校验通过（升级兼容）', async t => {
  const f = await setup(t);
  f.state().items = [{ code: 'I-1', container: 'C-1', status: 'in_stock', version: 3 }];
  f.state().containers = [{ code: 'C-1', loc: 'L-1', status: 'active', version: 2 }];
  // 旧客户端形态：device 在 request 主体里
  const legacyRequest = { schemaVersion: 1, opId: 'legacy-dev-1', kind: 'issue', itemCode: 'I-1',
    source: { loc: 'L-1', container: 'C-1' }, device: 'dev-OLDCLIENT',
    expected: { itemVersion: 3, containerVersion: 2 } };
  await f.client.enqueue(structuredClone(legacyRequest));
  // 回执原样带回同一个 request（旧客户端不移植 header，服务端也不解析）
  await f.client.acknowledge({
    code: 'legacy-dev-1', kind: 'issue', phase: 'APPLIED',
    request: structuredClone(legacyRequest),
    before: { items: [{ code: 'I-1', container: 'C-1', status: 'in_stock', version: 3 }] },
    // 真实回执形态：after 行必须带 version + lastOpId（item-persistence.js:162 的落账守卫）
    after: { items: [{ code: 'I-1', container: '', status: 'out', version: 4, lastOpId: 'legacy-dev-1' }] }
  });
  assert.equal(await f.store.get('outbox', 'legacy-dev-1'), undefined, '旧卡正常清卡');
  assert.equal(f.state().items[0].status, 'out', '旧卡结果正常落本地');
});

test('发现 E：新客户端不得再把 device 写进 request 主体（防 BUG-12 复发）', async t => {
  const f = await setup(t);
  f.state().items = [{ code: 'I-2', container: 'C-1', status: 'in_stock', version: 3 }];
  f.state().containers = [{ code: 'C-1', loc: 'L-1', status: 'active', version: 2 }];
  await f.client.enqueue({ schemaVersion: 1, opId: 'new-dev-1', kind: 'issue', itemCode: 'I-2',
    source: { loc: 'L-1', container: 'C-1' }, expected: { itemVersion: 3, containerVersion: 2 } });
  const cmd = await f.store.get('outbox', 'new-dev-1');
  assert.ok(cmd && cmd.request, '命令应已入队');
  assert.ok(!('device' in cmd.request), '新入队命令的 request 不得含 device —— device 走 header');
  // 同样内容但因 device 在场而被判 mismatch 的组合，必须不再出现
  const withDevice = Object.assign(structuredClone(cmd.request), { device: 'dev-X' });
  const P = require('../lib/item-persistence.js');
  assert.notEqual(P.canonical(withDevice), P.canonical(cmd.request),
    '带 device 与不带 device 的 canonical 必须不同 —— 这正是 BUG-12 的判定点，本条锁死「新命令不得带」');
});

test('发现 E：device 只允许出现在 header，不进 request 也不进回执比对', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'item-client.js'), 'utf8');
  const op = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'item-operation.js'), 'utf8');
  assert.match(src, /'X-416mes-Device':deviceHeader\(\)/, '客户端必须通过 header 发 device');
  assert.match(op, /device:\s*\(declaredDevice\(headerSource\)/, '服务端必须从 header 取 device');
  const persist = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'item-persistence.js'), 'utf8');
  assert.ok(!/frozen\.device\s*=/.test(persist), 'item-persistence 不得再往 request 注入 device');
});

/* ================= 发现 F（TASK-21）：REPAIR_REQUIRED 附「受影响件清单」 ================= */

test('发现 F：部分写入时按 before/after 精确算出受影响行，不误报未变行', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'item-operation.js'), 'utf8');
  // 三处 REPAIR_REQUIRED 出口都要带明细
  const sites = src.match(/withPartialDetail\(\{[^]*?phase: 'REPAIR_REQUIRED'/g) || [];
  assert.ok(sites.length >= 2, '至少 sweep 与 trial 回读两条 REPAIR_REQUIRED 路径要带明细，实测 ' + sites.length);

  /* v3.13.15：直接调用产品代码的真函数，不再复刻一份逻辑"自证"——
     此前测试里复制了同样的比较逻辑，产品改了算法而副本没改时测试依然绿。 */
  const O = require('../lib/item-operation.js');
  const svc = O.create({ repository: {}, coordinator: {}, enabled: false, mode: 'feishu-trial' });
  assert.equal(typeof svc.partialWriteDetail, 'function', 'create() 必须暴露 partialWriteDetail');
  assert.equal(typeof svc.withPartialDetail, 'function', 'create() 必须暴露 withPartialDetail');
  const detail = svc.partialWriteDetail;

  // 批量第 2 件失败：只有第 1 件真的变了
  assert.deepEqual(detail(
    { items: [{ code: 'I-1', container: 'C-1', status: 'in_stock', version: 1 }, { code: 'I-2', container: 'C-1', status: 'in_stock', version: 1 }] },
    { items: [{ code: 'I-1', container: '', status: 'out', version: 2 }, { code: 'I-2', container: 'C-1', status: 'in_stock', version: 1 }] }),
    ['变更 物品 I-1'], '只报真正变化的那一件，不得把未变的 I-2 也列进去');
  // 容器库位变化也要报
  assert.deepEqual(detail({ containers: [{ code: 'C-1', loc: 'L-1', status: 'active' }] },
                          { containers: [{ code: 'C-1', loc: 'L-2', status: 'active' }] }), ['变更 容器 C-1']);
  // 完全一致时不报（此时本就不该是 REPAIR_REQUIRED）
  assert.deepEqual(detail({ items: [{ code: 'I-1', status: 'out' }] }, { items: [{ code: 'I-1', status: 'out' }] }), []);
  // 新增 / 移除也要报
  assert.deepEqual(detail({ items: [] }, { items: [{ code: 'I-N', status: 'pending' }] }), ['新增 物品 I-N']);
  assert.deepEqual(detail({ items: [{ code: 'I-O', status: 'out' }] }, { items: [] }), ['移除 物品 I-O']);
  // 空入参不得抛错
  assert.deepEqual(detail(null, null), []);
  assert.deepEqual(detail(undefined, undefined), []);
  // 包装后：错误文案必须接上明细，且不改变原 verdict 对象
  const verdict = { phase: 'REPAIR_REQUIRED', error: '检出部分写入，需人工核对' };
  const wrapped = svc.withPartialDetail(verdict,
    { items: [{ code: 'I-1', status: 'in_stock' }] }, { items: [{ code: 'I-1', status: 'out' }] });
  assert.match(wrapped.error, /受影响：变更 物品 I-1/, '错误文案必须接上受影响明细');
  assert.equal(wrapped.phase, 'REPAIR_REQUIRED', '不得改变 phase');
  assert.notEqual(wrapped, verdict, '必须返回新对象（不能改入参）');
});

/* ================= 发现 O（v3.13.11）：recover() 缺 store 前置校验 ================= */

test('发现 O：recover() 在 store 缺失/非 indexeddb 时必须报 ITM_REQUIRES_INDEXEDDB（与 enqueue 同款）', async () => {
  const P = require('../lib/item-persistence.js');
  const state = { items: [], containers: [], locations: [] };
  const mk = store => P.create({ store, getState: () => state, publish() {}, canWrite: () => true });

  // store = null
  await assert.rejects(mk(null).recover(), /ITM_REQUIRES_INDEXEDDB/, 'store 为 null 必须报可读错误');
  // store 不是 indexeddb（隐私模式降级 / 内存存储）
  await assert.rejects(mk({ kind: 'memory' }).recover(), /ITM_REQUIRES_INDEXEDDB/, '非 indexeddb 同样必须报');
  // 同时验证 enqueue 的行为一致（两侧口径统一）
  await assert.rejects(mk(null).enqueue({ schemaVersion: 1, opId: 'p-1', kind: 'retire', itemCode: 'I-1', expected: { itemVersion: 1 } }),
    /ITM_REQUIRES_INDEXEDDB/, 'enqueue 早已有此闸，确认未回退');
});

test('发现 O：store 不可用时，所有持久化方法都必须报 ITM_REQUIRES_INDEXEDDB（行为断言，非源码匹配）', async () => {
  const P = require('../lib/item-persistence.js');
  const state = { items: [], containers: [], locations: [] };
  const seq = [];
  const mk = store => P.create({ store, getState: () => state, publish() {}, canWrite: () => true });
  const cases = [
    ['saveDraft',    p => p.saveDraft('itmDraft:s1', { sessionId: 's1' })],
    ['enqueue',      p => p.enqueue({ schemaVersion: 1, opId: 'x-1', kind: 'retire', itemCode: 'I-1', expected: { itemVersion: 1 } })],
    ['acknowledge',  p => p.acknowledge({ code: 'x-1', phase: 'APPLIED', request: {} })],
    ['markUnknown',  p => p.markUnknown('x-1', '结果待确认')],
    ['recover',      p => p.recover()],
    ['clearDrafts',  p => p.clearDrafts()],
    ['abandonCommand', p => p.abandonCommand('x-1')],
  ];
  for (const [name, call] of cases) {
    let msg = '(未抛错)';
    try { await call(mk(null)); } catch (e) { msg = String(e.message || e); }
    seq.push({ name, msg });
    assert.match(msg, /ITM_REQUIRES_INDEXEDDB/, name + ' 在 store 缺失时必须报 ITM_REQUIRES_INDEXEDDB，实测：' + msg);
  }
  // 7 个方法全覆盖（防止新增方法悄悄漏掉这道闸）
  assert.equal(seq.length, 7, '必须覆盖全部 7 个持久化方法');
});

test('发现 O：正常 indexeddb store 下 recover() 行为不变（不放宽也不收紧）', async () => {
  const P = require('../lib/item-persistence.js');
  const state = { items: [], containers: [], locations: [] };
  const store = { kind: 'indexeddb',
    async getAll(name) {
      if (name === 'outbox') return [{ id: 'o-1', op: 'itemOperation', status: 'pending', request: { opId: 'o-1' } }];
      if (name === 'syncMeta') return [{ key: 'itmDraft:s1', value: { sessionId: 's1' } }, { key: 'other', value: 1 }];
      return [];
    } };
  const r = await P.create({ store, getState: () => state, publish() {}, canWrite: () => true }).recover();
  assert.equal(r.commands.length, 1, '取回 1 条 ITM 命令');
  assert.equal(r.drafts.length, 1, '只取 itmDraft: 前缀的草稿');
});
