/* v3.6.0 一键重置本地环境：UI 存在性 + 两段式交互 + 清空序列 + 只读拦截 + boot 一次性提示 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');

function slice(from, to) {
  const a = HTML.indexOf(from);
  assert.ok(a >= 0, '找不到起点标记：' + from);
  const b = to === null ? HTML.length : HTML.indexOf(to, a);   // 终点从起点之后搜，避免同名标记在前文误命中
  if (to !== null) assert.ok(b > a, '找不到终点标记：' + to);
  return HTML.slice(a, to === null ? undefined : b);
}

test('静态：同步页有 danger 折叠块、两段式按钮、状态行，且都位于 tab-sync 区段内', () => {
  const syncSeg = HTML.slice(HTML.indexOf('<section class="tab" id="tab-sync">'), HTML.indexOf('<section class="tab"', HTML.indexOf('<section class="tab" id="tab-sync">') + 1));
  assert.ok(syncSeg.includes('id="hardResetZone"'), 'hardResetZone 必须在同步页');
  assert.ok(syncSeg.includes('id="btnHardReset"'), 'btnHardReset 必须在同步页');
  assert.ok(syncSeg.includes('id="hardResetStatus"'), 'hardResetStatus 必须在同步页');
  assert.ok(syncSeg.includes('重新从飞书拉取'), '说明文案必须声明重拉');
  assert.ok(syncSeg.includes('不受任何影响'), '说明文案必须声明飞书数据不受影响');
});

test('静态：wipeAll 在 memory 与 indexeddb 两个 store 实现里都有', () => {
  assert.equal((STORE_SRC.match(/wipeAll\(\)/g) || []).length >= 2, true, 'wipeAll 至少两处定义');
  assert.ok(STORE_SRC.includes('部分仓库清空失败'), 'indexeddb 版需汇总失败');
});

function makeContext(opts) {
  const o = opts || {};
  const els = {};
  function el(id) {
    if (!els[id]) els[id] = {
      id, textContent: '', _h: {},
      addEventListener(ev, fn) { this._h[ev] = fn; },
      dispatch(ev) { return this._h[ev] && this._h[ev](); }
    };
    return els[id];
  }
  const timers = [];
  const clicked = { sync: 0 };
  const ctx = {
    els, timers, clicked,
    document: {
      getElementById: el,
      querySelector() { clicked.sync++; return { click() { clicked.sync++; } }; }
    },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); }
    },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    state: Object.assign({ __healthHidden: true },
      o.state || { deviceId: 'dev-test', materials: [{ code: 'A' }], __syncedKeys: { x: 1 }, scanLog: [] }),
    localStore: { wipeAllCount: 0, async wipeAll() { this.wipeAllCount++; } },
    itmReadOnlyTab: !!o.readOnly,
    _pollTimer: 777,
    _saveCount: 0,
    save() { ctx._saveCount++; },
    _idbCount: 0,
    async persistStateToIdb() { ctx._idbCount++; },
    /* v3.7.1 补刀块用到：内存态归零、健康面板、日志。原 makeContext 没有这些 stub，
       补刀内 try{}catch(_){} 会把 seedState/migrateState 失败静默咽掉。 */
    seedState: () => ({ locations: [], containers: [], __rev: 0 }),
    migrateState: () => {},
    HEALTH: {},
    log: () => {},
    renderStatusBar: () => {},
    refreshStatusHint: () => {},
    /* boot IIFE 首段还引用这些（切片起点已覆盖到 IIFE 首行）。 */
    _pendingMissCheck: [],
    _pendingItemCheck: null,
    _pendingWipChecks: [],
    deepLinkMiss: () => {},
    showWipDetail: () => {},
    renderHealthPanel: () => {},
  };
  ctx.location = { reloadCount: 0, reload() { ctx.location.reloadCount++; } };
  return { ctx, vmCtx: vm.createContext(ctx), el };
}

/* v3.7.1：HARD_RESET_DONE_KEY / HARD_RESET_TTL_MS / hardResetPending 都在 index.html
   顶部常量区（load()/writeStateToLs/flushStateOnHide 的重置守卫都要用），
   位于各切片区间之外，故统一前置注入，保证切片片段在 vm 里能独立运行。
   ⚠️ 注入的是**与产品同源的常量值**（直接从 HTML 里抓取），避免测试脱离真实代码。 */
const HOISTED_CONSTS = [
  slice('const HARD_RESET_DONE_KEY =', 'const IDB_MIGRATION_KEY'),          // 含 KEY + TTL
  slice('function hardResetPending()', 'const IDB_MIGRATION_KEY'),          // 含 hardResetPending
].join('\n');
/* 把 HARD_RESET_TTL_MS 提到**测试作用域**，供 TTL 边界用例算「陈旧/未过期」的相对时间。
   值从 HTML 原文抓取，与产品同源（不是测试里另抄一份）。 */
/* 产品源码写的是算术式 `10 * 60 * 1000`，**不能直接 Number()**（会把 '10' 后面的丢掉，
   得到 10ms——守卫会在标记落盘瞬间就判过期）。用 vm 求值，与产品同源。 */
const _ttlSrc = (HOISTED_CONSTS.match(/const HARD_RESET_TTL_MS = ([^;]+);/) || [])[1];
const HARD_RESET_TTL_MS = Number(vm.runInNewContext(_ttlSrc));
assert.equal(HARD_RESET_TTL_MS, 10 * 60 * 1000,
  'TTL 必须解析为 10 分钟（测试与产品同源；解析成 10 说明正则吃掉了算术式）');
const HANDLER_SRC = HOISTED_CONSTS + '\n'
  + slice('const HARD_RESET_LS_KEYS', '/* ================= 库存工单管理');
/* TASK-04 修：boot IIFE 在**第一个 await 之前**取 `const _wasHardReset = hardResetPending()`，
   后续补刀块只读这个快照（不再二次调用带副作用的 hardResetPending）。
   故切片起点必须是 IIFE 首行；终点在 `fsBoot()` 之前，需自行补上 `fsBoot(); })();`
   才能让 IIFE 闭合（原实现把 `fsBoot();` 留在切片外、由外层 '(' + ... + ')();' 拼接）。 */
const BOOT_CONSTS = HOISTED_CONSTS + '\n'
  + "const HARD_RESET_LS_KEYS = ['mes416_state_v1', 'mes416_state_v1.corrupt', 'mes416_idb_behind_v1', 'mes416_fs_queue', 'mes416_write_fail_v1', 'mes416_last_backup'];\n";
const BOOT_SRC = BOOT_CONSTS + slice('(async function boot() {', 'fsBoot();   // 飞书真源') + '})();';

test('两段式：第一次点击只武装（变文案 + 5 秒取消定时器），不执行任何清空', async () => {
  const { ctx, vmCtx, el } = makeContext();
  vm.runInContext(HANDLER_SRC, vmCtx);
  await el('btnHardReset').dispatch('click');
  assert.ok(el('btnHardReset').textContent.includes('再点一次确认重置'), '第一次点击必须变文案');
  assert.equal(ctx.localStore.wipeAllCount, 0, '第一次点击不能清空');
  assert.ok(ctx.timers.some(t => t.ms === 5000), '必须有 5 秒取消定时器');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx._saveCount, 0, '不能写盘');
  // 超时路径：执行 5 秒定时器 → 按钮复原
  const arm = ctx.timers.find(t => t.ms === 5000 && !t.cancelled);
  arm.fn();
  assert.equal(el('btnHardReset').textContent, '一键重置本地环境', '超时后按钮复原');
});

test('两段式：第二次点击执行清空序列（7 仓库 wipe + LS 键删除 + 写盘 + reload）', async () => {
  const { ctx, vmCtx, el } = makeContext();
  // 预置脏数据：state 有记录、LS 有残留键
  ctx.state.materials = [{ code: 'A' }, { code: 'B' }];
  ctx.localStorage.setItem('mes416_state_v1', 'BIGBLOB');
  ctx.localStorage.setItem('mes416_state_v1.corrupt', 'x');
  ctx.localStorage.setItem('mes416_fs_queue', '[]');
  ctx.localStorage.setItem('mes416_write_fail_v1', '{}');
  vm.runInContext(HANDLER_SRC, vmCtx);
  await el('btnHardReset').dispatch('click');   // 武装
  await el('btnHardReset').dispatch('click');   // 执行
  assert.equal(ctx.localStore.wipeAllCount, 1, '必须调 wipeAll');
  assert.equal(ctx._pollTimer, null, '必须停增量轮询');
  for (const k of ['mes416_state_v1', 'mes416_state_v1.corrupt', 'mes416_fs_queue', 'mes416_write_fail_v1', 'mes416_idb_behind_v1', 'mes416_last_backup']) {
    assert.equal(ctx.localStorage.getItem(k), null, '必须删除 ' + k);
  }
  assert.equal(ctx._saveCount, 0, '不写盘：reload 后从零初始化（load() 读不到 blob 走出厂种子）');
  assert.equal(ctx._idbCount, 0, '不写 IDB（wipeAll 已清空，无需写 fresh state）');
  assert.notEqual(ctx.localStorage.getItem('mes416_hard_reset_done'), null, '必须写一次性完成标记');
  // 600ms 后 reload
  const reloadTimer = ctx.timers.find(t => t.ms === 600 && !t.cancelled);
  assert.ok(reloadTimer, '必须有 reload 定时器');
  reloadTimer.fn();
  assert.equal(ctx.location.reloadCount, 1, '必须整页刷新重启启动链');
});

test('两段式：清空保留 ITM 令牌与界面偏好（LS 不被整库 clear）', async () => {
  const { ctx, vmCtx, el } = makeContext();
  ctx.localStorage.setItem('mes416_itm_token', 'TOK');
  ctx.localStorage.setItem('mes416_label_type', '60');
  vm.runInContext(HANDLER_SRC, vmCtx);
  await el('btnHardReset').dispatch('click');
  await el('btnHardReset').dispatch('click');
  assert.equal(ctx.localStorage.getItem('mes416_itm_token'), 'TOK', 'ITM 身份令牌必须保留');
  assert.equal(ctx.localStorage.getItem('mes416_label_type'), '60', '界面偏好必须保留');
});

test('只读页签：非写入页签点击必须拦截，不执行任何清空', async () => {
  const { ctx, vmCtx, el } = makeContext({ readOnly: true });
  vm.runInContext(HANDLER_SRC, vmCtx);
  await el('btnHardReset').dispatch('click');
  await el('btnHardReset').dispatch('click');
  assert.ok(el('hardResetStatus').textContent.includes('写入权'), '必须提示写入权问题');
  assert.equal(ctx.localStore.wipeAllCount, 0, '不能清空');
  assert.equal(ctx._saveCount, 0, '不能写盘');
});

test('boot：一次性标记 → 补刀 wipeAll + 移除标记 + 延后跳同步页 + headline 重置提示', async () => {
  const { ctx, vmCtx, el } = makeContext();
  /* v3.7.1：标记值必须是**新鲜时间戳**——hardResetPending() 会忽略并清除超过
     HARD_RESET_TTL_MS（2 分钟）的陈旧标记（防止永久禁写）。旧的 '123' 现在属陈旧值。 */
  ctx.localStorage.setItem('mes416_hard_reset_done', String(Date.now()));
  ctx.localStore.wipeAllCount = 0;
  vm.runInContext(BOOT_SRC, vmCtx);
  await new Promise(r => setTimeout(r, 20));   // boot 切片是 async IIFE，让 await 跑完
  assert.equal(ctx.localStore.wipeAllCount, 1, 'boot 必须补刀 wipeAll（兜底上次超时未清净的仓库）');
  assert.equal(ctx.localStorage.getItem('mes416_hard_reset_done'), null, '标记必须一次性消费');
  assert.ok(el('syncHeadline').textContent.includes('本地环境已重置'), 'headline 必须立即显示重置提示');
  // tab 切换必须延后（setTimeout 0）——避免在浮层 DOM 解析前触发 goTab→stopCamera
  const tabTimer = ctx.timers.find(t => t.ms === 0 && !t.cancelled);
  assert.ok(tabTimer, 'tab 切换必须延后到 DOM 解析完成');
  tabTimer.fn();
  assert.ok(ctx.clicked.sync >= 1, '延后执行后必须跳到同步页');
});

test('wipeAll 卡死（事务挂起）→ 15 秒超时也继续走 reload，boot 补刀兜底', async () => {
  const { ctx, vmCtx, el } = makeContext();
  ctx.localStore.wipeAll = () => new Promise(() => {});   // 永不 resolve，模拟 IDB 事务挂起
  vm.runInContext(HANDLER_SRC, vmCtx);
  await el('btnHardReset').dispatch('click');
  el('btnHardReset').dispatch('click');   // 不 await：handler 挂在 race 上，等超时定时器手动触发
  await new Promise(r => setTimeout(r, 30));
  assert.ok(ctx.timers.some(t => t.ms === 15000), '必须有 15 秒超时保护定时器');
  assert.equal(ctx.localStorage.getItem('mes416_hard_reset_done'), null, '超时前不应写标记');
  const t15 = ctx.timers.find(t => t.ms === 15000);
  t15.fn(); await new Promise(r => setTimeout(r, 30));   // 超时触发 → race 结束 → 走完剩余序列
  assert.notEqual(ctx.localStorage.getItem('mes416_hard_reset_done'), null, '超时后必须继续写完成标记');
  const reloadTimer = ctx.timers.find(t => t.ms === 600 && !t.cancelled);
  reloadTimer.fn();
  assert.equal(ctx.location.reloadCount, 1, '卡死场景也必须 reload');
});

test('boot：无标记时不动 headline', () => {
  const { ctx, vmCtx, el } = makeContext();
  vm.runInContext(BOOT_SRC, vmCtx);  assert.equal(el('syncHeadline').textContent, '', '无标记不能显示提示');
});

/* ===== v3.7.1：重置期间禁止 LS 回写（根治「重置了还是启用不了」） =====
   元凶：重置末尾 location.reload() 触发 pagehide → flushStateOnHide() 把内存里的
   **旧 state** 同步写回 LS，恰好把刚 removeItem 掉的 blob 又写回去，重置等于白做；
   叠加 load() 无条件 save() 把出厂种子（库位/容器无 status → 全 unknown）写盘，
   留下与云端错位的镜像 → 启用必然 VERSION_CONFLICT。
   修复：writeStateToLs / flushStateOnHide 在重置标记存在时一律不回写。 */
function makeGuardContext() {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const LS_KEY = 'mes416_state_v1';
  const ctx = {
    localStorage, LS_KEY,
    LS_DIRTY_KEY: 'mes416_idb_behind_v1',
    HARD_RESET_DONE_KEY: 'mes416_hard_reset_done',
    console: { warn() {}, error() {} },
    state: { locations: [{ code: 'B-01-01-01', status: 'active' }], __rev: 1 },
    itmReadOnlyTab: false, _idbPending: false,
    store,
  };
  ctx.vmCtx = vm.createContext(ctx);
  const WRITE_SRC = slice('function writeStateToLs()', 'function onLocalStorageFailure');
  const FLUSH_SRC = slice('function flushStateOnHide()', 'window.addEventListener(\'pagehide\'');
  vm.runInContext(HOISTED_CONSTS + '\n' + WRITE_SRC + '\n' + FLUSH_SRC, ctx.vmCtx);
  return ctx;
}

test('v3.7.1：重置进行中（标记新鲜）→ writeStateToLs 与 flushStateOnHide 都必须拒绝回写', () => {
  const ctx = makeGuardContext();
  ctx.localStorage.setItem(ctx.LS_KEY, 'OLD_BLOB');
  ctx.localStorage.setItem(ctx.HARD_RESET_DONE_KEY, String(Date.now()));   // 新鲜标记
  const wrote = ctx.vmCtx.writeStateToLs();
  assert.equal(wrote, false, '重置中 writeStateToLs 必须返回 false');
  assert.equal(ctx.localStorage.getItem(ctx.LS_KEY), 'OLD_BLOB', '重置中不得覆盖 LS');
  ctx.vmCtx.flushStateOnHide();
  assert.equal(ctx.localStorage.getItem(ctx.LS_KEY), 'OLD_BLOB', 'pagehide 回写同样必须被挡住');
});

test('v3.7.1：无重置标记时回写照常（不能把正常落盘一起挡掉）', () => {
  const ctx = makeGuardContext();
  ctx.vmCtx.flushStateOnHide();
  const blob = ctx.localStorage.getItem(ctx.LS_KEY);
  assert.ok(blob && blob.includes('locations'), '正常路径必须照常写盘');
});

test('v3.7.1：重置标记被消费后恢复回写（不永久禁写）', () => {
  const ctx = makeGuardContext();
  ctx.localStorage.setItem(ctx.LS_KEY, 'OLD_BLOB');
  ctx.localStorage.setItem(ctx.HARD_RESET_DONE_KEY, String(Date.now()));
  assert.equal(ctx.vmCtx.writeStateToLs(), false, '标记存在时禁写');
  ctx.localStorage.removeItem(ctx.HARD_RESET_DONE_KEY);   // boot 补刀消费标记
  ctx.vmCtx.flushStateOnHide();
  assert.notEqual(ctx.localStorage.getItem(ctx.LS_KEY), 'OLD_BLOB', '标记消费后必须恢复写盘');
});

/* TTL 兜底：若 boot 补刀因异常没跑到消费点，标记会残留 → 旧实现会**永久禁写**（用户数据不再落盘）。
   v3.7.1 给标记加有效期：过期即自动忽略并清除，落盘恢复正常。
   ⚠️ TTL 已按 TASK-04 审查意见从 2 分钟放宽到 10 分钟（避免慢启动下标记先于补刀过期，
      把本次修复又静默退回原 bug），故「陈旧」用例必须超过 10 分钟。 */
test('v3.7.1【TTL 兜底】陈旧的重置标记必须被自动清除并放行落盘（不得永久禁写）', () => {
  const ctx = makeGuardContext();
  ctx.localStorage.setItem(ctx.LS_KEY, 'OLD_BLOB');
  ctx.localStorage.setItem(ctx.HARD_RESET_DONE_KEY, String(Date.now() - 3 * HARD_RESET_TTL_MS));   // 30 分钟前
  ctx.vmCtx.flushStateOnHide();
  assert.notEqual(ctx.localStorage.getItem(ctx.LS_KEY), 'OLD_BLOB',
    '陈旧标记不得永久禁写：必须放行落盘');
  assert.equal(ctx.localStorage.getItem(ctx.HARD_RESET_DONE_KEY), null,
    '陈旧标记必须被顺手清除，避免每轮都重新判断');
});

test('v3.7.1【TTL 边界】TTL 之内的慢启动仍算有效（不能先于 boot 补刀过期）', () => {
  /* 这是 TASK-04 阻塞项的回归护栏：手机冷启动 + IDB 慢 + 首屏重时可超过 2 分钟，
     原 2 分钟 TTL 会让 load() 误判为非重置态 → 走 save() 把种子写回 LS（原 bug 复活）。 */
  const ctx = makeGuardContext();
  ctx.localStorage.setItem(ctx.LS_KEY, 'OLD_BLOB');
  ctx.localStorage.setItem(ctx.HARD_RESET_DONE_KEY, String(Date.now() - 5 * 60 * 1000));   // 5 分钟前
  assert.equal(ctx.vmCtx.writeStateToLs(), false, '5 分钟内的慢启动仍须视为重置进行中');
  assert.equal(ctx.localStorage.getItem(ctx.LS_KEY), 'OLD_BLOB', '慢启动期间仍禁止回写');
});

test('v3.7.1【TTL 边界】损坏/非数字标记视为陈旧，不得卡死落盘', () => {
  const ctx = makeGuardContext();
  ctx.localStorage.setItem(ctx.LS_KEY, 'OLD_BLOB');
  ctx.localStorage.setItem(ctx.HARD_RESET_DONE_KEY, 'not-a-number');
  ctx.vmCtx.flushStateOnHide();
  assert.notEqual(ctx.localStorage.getItem(ctx.LS_KEY), 'OLD_BLOB', '损坏标记必须被忽略并放行');
});

test('v3.7.1：load() 在重置标记存在时跳过 save()（不把出厂种子写回 LS）', () => {
  const LOAD_SRC = slice('function load()', '/**\n * 把当前 state **同步**写进 localStorage');
  assert.ok(LOAD_SRC.includes('hardResetPending()'), 'load() 必须用 hardResetPending() 判定');
  assert.ok(/检测到一键重置标记/.test(LOAD_SRC), 'load() 必须有跳过 save() 的分支');
  /* 行为断言：新鲜标记存在时不得调用 save()；无标记时必须调用。 */
  for (const [flag, shouldSave] of [[true, false], [false, true]]) {
    const ctx = makeGuardContext();
    ctx.seedState = () => ({ locations: [], containers: [], __rev: 0 });
    ctx.migrateState = () => {};
    ctx.initLocalStore = () => Promise.resolve();
    ctx.console = { warn() {}, error() {} };
    ctx.saveCount = 0;
    ctx.save = () => { ctx.saveCount++; };
    if (flag) ctx.localStorage.setItem(ctx.HARD_RESET_DONE_KEY, String(Date.now()));
    vm.runInContext(LOAD_SRC, ctx.vmCtx);
    vm.runInContext('load();', ctx.vmCtx);
    assert.equal(ctx.saveCount > 0, shouldSave,
      flag ? '重置冷启动不得 save()' : '正常启动必须 save()');
  }
});
