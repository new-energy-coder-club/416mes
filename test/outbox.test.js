/**
 * lib/outbox.js 单元测试 —— Phase 1 的验收
 *
 * 这一层的意义：同步逻辑原来埋在 index.html 里，Node 测不到，
 * 于是「队列只进不出」「失败静默丢数据」只能在真机上撞见。
 * 抽出来之后，这些行为第一次有了自动化断言。
 *
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Outbox = require('../lib/outbox.js');
const Core = require('../mes-core.js');

const mk = (opts) => Outbox.create(Object.assign({ storage: Outbox.memoryStorage(), maxTries: 5 }, opts || {}));

/* ================= 持久化与基本操作 ================= */

test('outbox：入队后能读回，且落到了存储里', () => {
  const storage = Outbox.memoryStorage();
  const ob = Outbox.create({ storage });
  ob.append({ op: 'upsert', table: 'materials', records: [{ code: 'A-1', name: '甲' }] });

  assert.equal(ob.list().length, 1);
  const raw = JSON.parse(storage.getItem(Outbox.DEFAULT_KEY));
  assert.equal(raw.length, 1, '必须真的写进存储，否则刷新页面就丢');
  assert.equal(raw[0].records[0].code, 'A-1');
});

test('outbox【关键】旧格式条目（没有 id）读出来会自动补 id 并落盘', () => {
  const storage = Outbox.memoryStorage();
  // 模拟浏览器里已经存在的旧队列：条目没有 id 字段
  storage.setItem(Outbox.DEFAULT_KEY, JSON.stringify([
    { op: 'stock', matCode: 'A-1', qty: 3, delta: -1 },
    { op: 'upsert', table: 'members', records: [{ code: 'MB-1' }] }
  ]));
  const ob = Outbox.create({ storage });
  const q = ob.list();
  assert.equal(q.length, 2);
  assert.ok(q[0].id && q[1].id, '旧条目必须补上 id');
  assert.notEqual(q[0].id, q[1].id, 'id 不能重复');
  // 补完要立刻落盘，不能每次读都重新生成（否则 markAttempt 永远找不到目标）
  const persisted = JSON.parse(storage.getItem(Outbox.DEFAULT_KEY));
  assert.equal(persisted[0].id, q[0].id, '补出来的 id 必须持久化');
});

test('outbox：损坏的 JSON 不会让整个队列炸掉', () => {
  const storage = Outbox.memoryStorage();
  storage.setItem(Outbox.DEFAULT_KEY, '{不是合法 JSON');
  const ob = Outbox.create({ storage });
  assert.deepEqual(ob.list(), []);
  ob.append({ op: 'stock', matCode: 'A-1', qty: 1 });
  assert.equal(ob.list().length, 1);
});

/* ================= 去重 ================= */

test('outbox：同一操作重复入队只保留一条', () => {
  const ob = mk();
  const item = { op: 'upsert', table: 'materials', records: [{ code: 'A-1', name: '甲' }] };
  ob.append(item);
  ob.append(item);
  ob.append({ op: 'upsert', table: 'materials', records: [{ code: 'A-1', name: '甲' }] });
  assert.equal(ob.list().length, 1, '语义相同的操作不能堆三条');
});

test('outbox：元数据不同（tries/lastError/id）不算不同操作', () => {
  const ob = mk();
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3, delta: -1, tries: 0 });
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3, delta: -1, tries: 3, lastError: '超时', id: 'x1' });
  assert.equal(ob.list().length, 1);
});

test('outbox：不同操作要分开排队', () => {
  const ob = mk();
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3, delta: -1 });
  ob.append({ op: 'stock', matCode: 'A-1', qty: 5, delta: +2 });   // 数量不同
  ob.append({ op: 'stock', matCode: 'B-2', qty: 3, delta: -1 });   // 物料不同
  ob.append({ op: 'delete', table: 'materials', keys: ['A-1'] });   // 操作类型不同
  assert.equal(ob.list().length, 4);
});

test('outbox：records 数组顺序不同但内容相同 → 视为同一操作', () => {
  const ob = mk();
  ob.append({ op: 'upsert', table: 'locations', records: [{ code: 'L-1' }, { code: 'L-2' }] });
  ob.append({ op: 'upsert', table: 'locations', records: [{ code: 'L-2' }, { code: 'L-1' }] });
  assert.equal(ob.list().length, 1);
});

/* ================= 失败记账与剔除 ================= */

test('outbox【关键】记一次失败只增加计数，绝不自动删除条目', () => {
  const ob = mk();
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3 });
  const id = ob.list()[0].id;
  for (let i = 1; i <= 4; i++) {
    ob.markAttempt(id, '网络超时 #' + i);
    const it = ob.list()[0];
    assert.ok(it, '第 ' + i + ' 次失败后条目必须还在');
    assert.equal(it.tries, i);
    assert.equal(it.lastError, '网络超时 #' + i);
  }
});

test('outbox：prune 才负责剔除，且把被剔除的条目交回调用方（供告警/审计）', () => {
  const ob = mk();
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3 });
  ob.append({ op: 'stock', matCode: 'B-2', qty: 1 });
  const ids = ob.list().map(x => x.id);
  for (let i = 0; i < 5; i++) ob.markAttempt(ids[0], '一直失败');

  const r = ob.prune();
  assert.equal(r.dropped.length, 1, '达到上限的应被剔除');
  assert.equal(r.dropped[0].matCode, 'A-1');
  assert.match(r.dropped[0].lastError, /一直失败/, '被丢弃的条目必须带着失败原因，否则无法审计');
  assert.equal(r.kept.length, 1);
  assert.equal(ob.list().length, 1);
});

test('outbox：prune 不会碰没到上限的条目', () => {
  const ob = mk();
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3 });
  ob.markAttempt(ob.list()[0].id, '偶发');
  const r = ob.prune();
  assert.equal(r.dropped.length, 0);
  assert.equal(ob.list().length, 1);
});

/* ================= id 定位（替代旧的对象引用比较） ================= */

test('outbox【回归】按 id 删除，不依赖对象引用', () => {
  const ob = mk();
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3 });
  ob.append({ op: 'stock', matCode: 'B-2', qty: 1 });
  const idA = ob.list().find(x => x.matCode === 'A-1').id;
  // 关键：这里用一个**新对象**（内容相同但引用不同）来删除。
  // 旧实现用 x !== item 比较引用，JSON 往返后就失效了。
  ob.removeById(idA);
  const left = ob.list();
  assert.equal(left.length, 1);
  assert.equal(left[0].matCode, 'B-2');
});

test('outbox：summary 汇总状态，供健康面板显示', () => {
  const ob = mk();
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3 });
  ob.append({ op: 'stock', matCode: 'B-2', qty: 1 });
  ob.markAttempt(ob.list()[0].id, '超时');
  const s = ob.summary();
  assert.equal(s.total, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.lastError, '超时');
  assert.equal(s.byStatus.pending, 2);
});

test('outbox：clear 清空', () => {
  const ob = mk();
  ob.append({ op: 'stock', matCode: 'A-1', qty: 3 });
  ob.clear();
  assert.equal(ob.list().length, 0);
});

/* ================= 投影：视图 = 快照 ⊕ 未提交操作 ================= */

const snap = () => ({
  materials: [{ code: 'A-1', name: '甲', qty: 10 }, { code: 'B-2', name: '乙', qty: 5 }],
  locations: [{ code: 'L-1', kind: '货架' }],
  containers: [], members: [], items: [], manuals: [], workorders: [], transactions: []
});

test('投影：没有未提交操作时，视图就等于快照', () => {
  const s = snap();
  const r = Outbox.project(s, []);
  assert.deepEqual(r.view.materials, s.materials);
  assert.deepEqual(r.pending, {});
});

test('投影【核心】未提交的 upsert 会盖住快照里的旧值（用户要立刻看到自己的修改）', () => {
  const s = snap();
  const r = Outbox.project(s, [{ op: 'upsert', table: 'materials', records: [{ code: 'A-1', name: '甲改' }] }]);
  const a = r.view.materials.find(m => m.code === 'A-1');
  assert.equal(a.name, '甲改', '未提交的改动必须显示出来');
  assert.equal(a.qty, 10, '没被改的字段要保留');
  assert.deepEqual(r.pending.materials, ['A-1'], '要能标出哪个键是未提交的');
});

test('投影：未提交的 upsert 遇到快照里没有的记录 → 新增', () => {
  const r = Outbox.project(snap(), [{ op: 'upsert', table: 'materials', records: [{ code: 'NEW-1', name: '新' }] }]);
  assert.equal(r.view.materials.length, 3);
  assert.ok(r.view.materials.find(m => m.code === 'NEW-1'));
});

test('投影：未提交的 delete 让记录立刻从视图里消失', () => {
  const r = Outbox.project(snap(), [{ op: 'delete', table: 'materials', keys: ['A-1'] }]);
  assert.equal(r.view.materials.length, 1);
  assert.equal(r.view.materials[0].code, 'B-2');
  assert.deepEqual(r.pending.materials, ['A-1']);
});

test('投影：未提交的库存变动反映到 qty 上', () => {
  const r = Outbox.project(snap(), [{ op: 'stock', matCode: 'A-1', qty: 7, delta: -3 }]);
  assert.equal(r.view.materials.find(m => m.code === 'A-1').qty, 7);
  assert.deepEqual(r.pending.materials, ['A-1']);
});

test('投影：流水不本地伪造 —— 未提交的库存变动不产生流水行', () => {
  const r = Outbox.project(snap(), [{ op: 'stock', matCode: 'A-1', qty: 7, delta: -3 }]);
  assert.equal(r.view.transactions.length, 0, '流水由服务端生成，本地不能假装已经记账');
});

test('投影【关键】纯函数：不改快照、不改 outbox 条目', () => {
  const s = snap();
  const items = [{ op: 'upsert', table: 'materials', records: [{ code: 'A-1', name: '甲改' }] }, { op: 'delete', table: 'locations', keys: ['L-1'] }];
  const beforeS = JSON.stringify(s), beforeI = JSON.stringify(items);
  Outbox.project(s, items);
  assert.equal(JSON.stringify(s), beforeS, '快照不能被投影改掉');
  assert.equal(JSON.stringify(items), beforeI, 'outbox 条目不能被投影改掉');
});

test('投影：多条未提交操作按顺序叠加', () => {
  const r = Outbox.project(snap(), [
    { op: 'upsert', table: 'materials', records: [{ code: 'A-1', name: '第一次' }] },
    { op: 'upsert', table: 'materials', records: [{ code: 'A-1', name: '第二次' }] }
  ]);
  assert.equal(r.view.materials.find(m => m.code === 'A-1').name, '第二次', '后面的操作盖前面的');
  assert.deepEqual(r.pending.materials, ['A-1'], '同一个键只算一条待提交');
  assert.equal(r.counts.materials, 1);
});

test('投影：已放弃（gaveup）的操作不参与投影', () => {
  const r = Outbox.project(snap(), [{ op: 'delete', table: 'materials', keys: ['A-1'], status: 'gaveup' }]);
  assert.equal(r.view.materials.length, 2, '放弃掉的操作不该继续影响视图');
  assert.deepEqual(r.pending, {});
});

test('投影：空 business key 的操作被忽略，不会污染视图', () => {
  const r = Outbox.project(snap(), [{ op: 'upsert', table: 'materials', records: [{ code: '', name: 'x' }] }]);
  assert.equal(r.view.materials.length, 2);
});

/* ================= 防漂移 ================= */

test('outbox【防漂移】DEFAULT_TABLES 与 mes-core 的 MERGE_TABLES 必须一致', () => {
  const a = Outbox.DEFAULT_TABLES.map(t => t.key + ':' + t.id).sort();
  const b = Core.MERGE_TABLES.map(t => t.key + ':' + t.id).sort();
  assert.deepEqual(a, b, '业务主键定义两边必须一模一样，否则投影会按错的键匹配');
});

test('outbox【关键回归】冲刷时按 id 删除，成功条目必须真的出队', () => {
  const ob = mk();
  ob.append({ op: 'delete', table: 'materials', keys: ['X-1'] });
  ob.append({ op: 'delete', table: 'materials', keys: ['X-2'] });

  // 模拟 fsFlushQueue：先取一份快照，逐条执行，成功的按 id 删除。
  // 旧实现这里是 fsQueue().filter(x => x !== item) —— fsQueue() 每次都重新解析 JSON
  // 返回全新对象，x !== item 永远成立，于是成功的条目从来没被移除过：
  // 角标永远显示旧数字，而且每次开机都会重放，对 stock 就是重复记账。
  const snapshot = ob.list();
  for (const item of snapshot) {
    ob.removeById(item.id);          // = 执行成功
  }
  assert.equal(ob.list().length, 0, '全部成功后队列必须为空');
});

test('outbox：部分成功时只移除成功的那些', () => {
  const ob = mk();
  ob.append({ op: 'delete', table: 'materials', keys: ['X-1'] });
  ob.append({ op: 'delete', table: 'materials', keys: ['X-2'] });
  ob.append({ op: 'delete', table: 'materials', keys: ['X-3'] });
  const snapshot = ob.list();
  ob.removeById(snapshot[0].id);
  ob.markAttempt(snapshot[1].id, '网络超时');
  ob.removeById(snapshot[2].id);

  const left = ob.list();
  assert.equal(left.length, 1, '失败的必须留在队列里');
  assert.deepEqual(left[0].keys, ['X-2']);
  assert.equal(left[0].tries, 1);
  assert.equal(left[0].lastError, '网络超时');
});
