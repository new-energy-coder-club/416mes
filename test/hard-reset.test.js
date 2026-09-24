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
    state: o.state || { deviceId: 'dev-test', materials: [{ code: 'A' }], __syncedKeys: { x: 1 }, scanLog: [] },
    localStore: { wipeAllCount: 0, async wipeAll() { this.wipeAllCount++; } },
    itmReadOnlyTab: !!o.readOnly,
    _pollTimer: 777,
    _saveCount: 0,
    save() { ctx._saveCount++; },
    _idbCount: 0,
    async persistStateToIdb() { ctx._idbCount++; }
  };
  ctx.location = { reloadCount: 0, reload() { ctx.location.reloadCount++; } };
  return { ctx, vmCtx: vm.createContext(ctx), el };
}

const HANDLER_SRC = slice('const HARD_RESET_LS_KEYS', '/* ================= 库存工单管理');
const BOOT_SRC = '(async()=>{' + slice('// v3.6.0 一键重置完成后的一次性提示', 'fsBoot();   // 飞书真源') + '})();';

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
  ctx.localStorage.setItem('mes416_hard_reset_done', '123');
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
  vm.runInContext(BOOT_SRC, vmCtx);
  assert.equal(el('syncHeadline').textContent, '', '无标记不能显示提示');
});
