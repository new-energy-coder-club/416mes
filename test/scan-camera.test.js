'use strict';
/* scan-camera 统一浮层：真实 DOM（index.html 的 scanCam* 结构）+ 假媒体/解码。
   相机硬件路径仍属外部门禁，这里验证编排逻辑：打开/暂停/确认/重扫/关闭/迟到释放。 */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { parseHTML } = require('linkedom');
const ScanCamera = require('../lib/scan-camera');

function setup(opts = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => { if (opts.playError) throw opts.playError; };
  let stopped = 0;
  const track = opts.track || { stop() { stopped++; } };
  const stream = opts.stream || { getTracks: () => [track], getVideoTracks: () => [track] };
  let pendingGet;
  const mediaDevices = opts.noMedia ? undefined : {
    getUserMedia: opts.hangMedia ? () => new Promise(r => { pendingGet = r; })
      : async () => { if (opts.mediaError) throw opts.mediaError; return stream; }
  };
  const cam = ScanCamera.attach({
    document, win: opts.win || document.defaultView, mediaDevices,
    intervalMs: opts.intervalMs == null ? 2 : opts.intervalMs,
    capture: opts.noCapture ? undefined : (opts.capture || (() => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) }))),
    decode: opts.decode || (async () => null),
    pipeline: opts.pipeline, frameScale: opts.frameScale, fullFrameEvery: opts.fullFrameEvery,
    legacyLoop: opts.legacyLoop
  });
  return { document, cam, stream, track, get stopped() { return stopped; }, resolveMedia: () => pendingGet && pendingGet(stream) };
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

/* P0-1 帧管线测试：假 canvas（linkedom 的 getContext 返回 null）+ 假 video，
   验证快路径降采样尺寸 / 慢路径全帧频率 / legacy 回归。 */
function setupPipeline(opts = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 1920; video.videoHeight = 1080;
  video.play = async () => {};
  const draws = [];   // {sw,sh,dw,dh} 记录每次 drawImage 的源/目标尺寸
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const elc = create(tag);
    if (String(tag).toLowerCase() === 'canvas') {
      elc.getContext = () => ({
        drawImage: (_v, a, b, c2, d2) => draws.push({ sw: c2, sh: d2, dw: elc.width, dh: elc.height }),
        getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      });
    }
    return elc;
  };
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const mediaDevices = { getUserMedia: async () => stream };
  const sizes = [];   // 每次 decode 收到的 image 尺寸
  const cam = ScanCamera.attach({
    document, win: document.defaultView, mediaDevices,
    intervalMs: 2,
    pipeline: opts.pipeline, frameScale: opts.frameScale, fullFrameEvery: opts.fullFrameEvery,
    legacyLoop: true,
    decode: async image => { sizes.push(image.width + 'x' + image.height); return null; }
  });
  return { document, cam, draws, sizes };
}

test('无摄像头能力：浮层内常驻错误，不静默消失', async () => {
  const { document: d, cam } = setup({ noMedia: true });
  await cam.open({});
  assert.equal(d.getElementById('scanCamOverlay').style.display, 'flex');
  assert.match(d.getElementById('scanCamErr').textContent, /不支持摄像头|扫码枪/);
  assert.equal(d.getElementById('scanCamErr').hidden, false);
  cam.close('test');
});

test('识别到码 → 确认卡显示，点确定才回调 onConfirm，且不触发 onCancel', async () => {
  const got = []; let cancelled = 0;
  const { document: d, cam } = setup({ decode: async () => ({ text: 'LOC:L-A', format: '二维码' }) });
  await cam.open({ onConfirm: (t, tok) => got.push(t), onCancel: () => cancelled++, captureToken: () => ({ rowId: 'r1' }) });
  await tick(30);
  const box = d.getElementById('scanCamConfirm');
  assert.equal(box.hidden, false);
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:L-A');
  d.getElementById('scanCamYes').click();
  assert.deepEqual(got, ['LOC:L-A']);
  assert.equal(cancelled, 0);
  assert.equal(d.getElementById('scanCamOverlay').style.display, 'none');
});

test('重扫回到识别状态；同码连续帧去重不重复确认', async () => {
  let confirmed = 0;
  const { document: d, cam } = setup({
    decode: async () => ({ text: 'CTN:C-A', format: '条形码' })
  });
  await cam.open({ onConfirm: () => confirmed++ });
  await tick(30);
  assert.equal(d.getElementById('scanCamConfirm').hidden, false);
  await tick(30);   // 确认卡打开期间同码继续命中只算一次，不重复弹/不累计
  assert.equal(cam.isOpen(), true);
  assert.equal(d.getElementById('scanCamCandidates').children.length, 0);
  d.getElementById('scanCamRetry').click();
  assert.equal(d.getElementById('scanCamConfirm').hidden, true);
  await tick(30);
  assert.equal(d.getElementById('scanCamConfirm').hidden, false);
  d.getElementById('scanCamYes').click();
  assert.equal(confirmed, 1);
});

test('画面出现多个码：候选列表逐个选择，确定只填入选中的码', async () => {
  const confirmed = [];
  const codes = ['LOC:L-A', 'ITM:WP-001'];
  let calls = 0;
  const { document: d, cam } = setup({
    decode: async () => ({ text: codes[Math.min(calls++, codes.length - 1)], format: '二维码' })
  });
  await cam.open({ onConfirm: t => confirmed.push(t) });
  await tick(60);
  assert.equal(d.getElementById('scanCamCandidates').children.length, 1);
  assert.match(d.getElementById('scanCamCandidatesHint').textContent, /多个码/);
  d.getElementById('scanCamCandidates').querySelector('button').click();   // 改选第二个码
  await tick(5);
  assert.equal(d.getElementById('scanCamValue').textContent, 'ITM:WP-001');
  d.getElementById('scanCamYes').click();
  assert.deepEqual(confirmed, ['ITM:WP-001']);
});

test('关闭期间迟到的 getUserMedia 授权流立即释放，不残留摄像头', async () => {
  const s = setup({ hangMedia: true });
  let cancelReason = null;
  const p = s.cam.open({ onCancel: r => { cancelReason = r; } });   // open 卡在授权 Promise 上，不能 await
  s.cam.close('user');
  s.resolveMedia();
  await p;
  await tick(10);
  assert.equal(s.stopped, 1);
  assert.equal(s.document.getElementById('scanCamOverlay').style.display, 'none');
});

test('video.play 拒绝：释放设备并在浮层常驻错误', async () => {
  const s = setup({ playError: new Error('play denied') });
  await s.cam.open({});
  assert.equal(s.stopped, 1);
  assert.match(s.document.getElementById('scanCamErr').textContent, /画面启动失败/);
  s.cam.close('test');
});

test('Esc 关闭并回调 onCancel', async () => {
  let reason = null;
  const { document: d, cam } = setup({});
  await cam.open({ onCancel: r => { reason = r; } });
  const e = new d.defaultView.Event('keydown');
  Object.defineProperty(e, 'key', { value: 'Escape' });
  d.dispatchEvent(e);
  assert.equal(reason, 'escape');
  assert.equal(d.getElementById('scanCamOverlay').style.display, 'none');
});

test('captureToken 原样传给 onConfirm，describe 拦截可禁用确定', async () => {
  const received = [];
  const { document: d, cam } = setup({ decode: async () => ({ text: 'ITM:WP-001', format: '条形码' }) });
  await cam.open({
    captureToken: () => ({ rowId: 'row-9', step: 2 }),
    describe: hit => ({ text: '当前步骤需要库位码', ok: false }),
    onConfirm: (text, token) => received.push({ text, token })
  });
  await tick(30);
  assert.equal(d.getElementById('scanCamYes').disabled, true);
  assert.match(d.getElementById('scanCamMeta').textContent, /当前步骤需要库位码/);
  assert.deepEqual(received, []);
  cam.close('test');
});

test('持续无命中给出可见提示而不是静默（P0-3 分级引导：≥6 帧距离提示，≥18 帧拿远提示）', async () => {
  const { document: d, cam } = setup({ intervalMs: 1, decode: async () => null });
  await cam.open({});
  await tick(80);
  const status = d.getElementById('scanCamStatus').textContent;
  assert.match(status, /请将码放入框内|靠太近了|暂未识别/, '无命中时应给出分级引导或兜底提示');
  cam.close('test');
});
test('识别后未确认就关闭：onCancel 收到未确认码供调用方提示', async () => {
  let pending = null;
  const { cam } = setup({ decode: async () => ({ text: 'LOC:L-A', format: '二维码' }) });
  await cam.open({ onCancel: (reason, unconfirmed) => { pending = unconfirmed; } });
  await tick(30);
  cam.close('user');
  assert.equal(pending, 'LOC:L-A');
});
test('确定填入后再关闭不会报未确认', async () => {
  let pending = 'unset';
  const { document: d, cam } = setup({ decode: async () => ({ text: 'LOC:L-A', format: '二维码' }) });
  await cam.open({ onConfirm: () => {}, onCancel: (r, u) => { pending = u === undefined ? 'unset' : u; } });
  await tick(30);
  d.getElementById('scanCamYes').click();
  assert.equal(pending, 'unset');
});

test('describe 拒绝时可自定义按钮文案（如「本行已填齐，无需重扫」）', async () => {
  const { document: d, cam } = setup({ decode: async () => ({ text: 'ITM:WP-001', format: '二维码' }) });
  await cam.open({
    describe: () => ({ text: '本行步骤已填齐，无需再扫码。请点「确认本行，保存待提交」', ok: false, action: '本行已填齐，无需重扫' })
  });
  await tick(30);
  const yes = d.getElementById('scanCamYes');
  assert.equal(yes.disabled, true);
  assert.equal(yes.textContent, '本行已填齐，无需重扫', '不得误导为「类型不符，请重扫」');
  cam.close('test');
});

/* ================= P0-1 帧管线：降采样快路径 + 全帧慢路径 ================= */

test('P0-1 快路径：1920×1080 帧按 frameScale=0.5 降采样产出 960×540', async () => {
  const { cam, sizes } = setupPipeline({ frameScale: 0.5, fullFrameEvery: 4 });
  await cam.open({});
  await tick(30);
  cam.close('test');
  assert.ok(sizes.length >= 2, '应至少取帧 2 次，实测 ' + sizes.length);
  assert.equal(sizes[0], '960x540', '首帧应走快路径 960×540，实测 ' + sizes[0]);
  assert.equal(sizes[1], '960x540', '第 2 帧应走快路径 960×540，实测 ' + sizes[1]);
});

test('P0-1 慢路径：每 4 帧跑一次全帧 1920×1080 兜小码', async () => {
  const { cam, sizes } = setupPipeline({ frameScale: 0.5, fullFrameEvery: 4 });
  await cam.open({});
  await tick(60);
  cam.close('test');
  assert.ok(sizes.length >= 4, '应至少取帧 4 次，实测 ' + sizes.length);
  assert.equal(sizes[3], '1920x1080', '第 4 帧应走慢路径全帧，实测 ' + sizes[3]);
  assert.equal(sizes[4], '960x540', '第 5 帧应回到快路径，实测 ' + sizes[4]);
});

test('P0-1 fullFrameEvery 可调：每 2 帧一次全帧', async () => {
  const { cam, sizes } = setupPipeline({ frameScale: 0.5, fullFrameEvery: 2 });
  await cam.open({});
  await tick(40);
  cam.close('test');
  assert.ok(sizes.length >= 3, '应至少取帧 3 次，实测 ' + sizes.length);
  assert.equal(sizes[1], '1920x1080', '第 2 帧应走慢路径全帧，实测 ' + sizes[1]);
  assert.equal(sizes[2], '960x540', '第 3 帧应回到快路径，实测 ' + sizes[2]);
});

test('P0-1 pipeline:legacy 回归：全部帧走旧全帧路径 1920×1080', async () => {
  const { cam, sizes } = setupPipeline({ pipeline: 'legacy' });
  await cam.open({});
  await tick(30);
  cam.close('test');
  assert.ok(sizes.length >= 2, '应至少取帧 2 次，实测 ' + sizes.length);
  for (const s of sizes) assert.equal(s, '1920x1080', 'legacy 路径应全帧，实测 ' + s);
});

test('P0-1 注入 capture 时跳过整个内置管线（快/慢路径都不走）', async () => {
  const { cam, sizes } = (function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const { document } = parseHTML(html);
    const video = document.getElementById('scanCamVideo');
    video.videoWidth = 1920; video.videoHeight = 1080;
    video.play = async () => {};
    const track = { stop() {} };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const sizes2 = [];
    const cam2 = ScanCamera.attach({
      document, win: document.defaultView, mediaDevices: { getUserMedia: async () => stream },
      intervalMs: 2, legacyLoop: true,
      capture: v => { sizes2.push(v.videoWidth + 'x' + v.videoHeight); return { width: 320, height: 240, data: new Uint8ClampedArray(4) }; },
      decode: async () => null
    });
    return { document, cam: cam2, sizes: sizes2 };
  })();
  await cam.open({});
  await tick(30);
  cam.close('test');
  assert.ok(sizes.length >= 2, '注入 capture 应被逐帧调用，实测 ' + sizes.length);
  for (const s of sizes) assert.equal(s, '1920x1080', '注入 capture 收到原始 video 尺寸，实测 ' + s);
});

test('P0-1/P0-2 忙碌跳帧：decode 未返回时不重叠调用 decode（intervalMs 最小节拍仍生效）', async () => {
  let calls = 0, maxOverlap = 0, inFlight = 0;
  const { cam } = setup({
    intervalMs: 2,
    decode: async () => {
      calls++; inFlight++;
      maxOverlap = Math.max(maxOverlap, inFlight);
      await new Promise(r => setTimeout(r, 25));
      inFlight--;
      return null;
    }
  });
  await cam.open({});
  await tick(80);
  cam.close('test');
  assert.ok(calls >= 2, '应至少调用 decode 2 次，实测 ' + calls);
  assert.equal(maxOverlap, 1, 'decode 不允许重叠调用（在途跳帧），实测峰值并发 ' + maxOverlap);
});

/* ================= P0-2 帧驱动：rVFC 优先 + 回退 ================= */

/* 假 rVFC：手动队列化回调，测试可逐帧派发。 */
function setupRvfc(opts = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  let rafcId = 0, rafcRegistrations = 0;
  const pending = new Map();
  video.requestVideoFrameCallback = cb => { rafcRegistrations++; const id = ++rafcId; pending.set(id, cb); return id; };
  video.cancelVideoFrameCallback = id => { pending.delete(id); };
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const counts = { decodeCalls: 0 };
  const cam = ScanCamera.attach({
    document, win: document.defaultView,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: opts.legacyLoop,
    capture: () => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) }),
    decode: opts.decode || (async () => { counts.decodeCalls++; return null; })
  });
  /* 派发一帧：执行当前挂起的 rVFC 回调（metadata.presentedFrames 递增）。 */
  let presented = 0;
  function dispatchOne() {
    presented++;
    const cbs = [...pending.values()];
    pending.clear();
    for (const cb of cbs) cb(0, { presentedFrames: presented });
  }
  return { document, cam, video, dispatchOne, counts, get rafcRegistrations() { return rafcRegistrations; } };
}

test('P0-2 rVFC 可用时走 rVFC 循环：注册回调并派发一帧触发一次 decode', async () => {
  const { cam, video, dispatchOne, counts } = setupRvfc();
  await cam.open({});
  assert.equal(typeof video.requestVideoFrameCallback, 'function');
  await tick(30);
  assert.ok(cam.isOpen(), '会话应打开');
  assert.equal(counts.decodeCalls, 0, '未派发帧前不应 decode');
  dispatchOne();   // 第 1 帧
  await tick(10);
  assert.ok(counts.decodeCalls >= 1, '派发 1 帧应至少触发 1 次 decode，实测 ' + counts.decodeCalls);
  cam.close('test');
});

test('P0-2 rVFC 同帧（presentedFrames 相同）不重解', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  let rafcId = 0;
  const pending = new Map();
  video.requestVideoFrameCallback = cb => { const id = ++rafcId; pending.set(id, cb); return id; };
  video.cancelVideoFrameCallback = id => { pending.delete(id); };
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let decodeCalls = 0;
  const cam = ScanCamera.attach({
    document, win: document.defaultView,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2,
    capture: () => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) }),
    decode: async () => { decodeCalls++; return null; }
  });
  await cam.open({});
  await tick(10);
  /* 同一 presentedFrames 派发两次（模拟相机未出新帧）→ 只解一次。 */
  const cbs = [...pending.values()]; pending.clear();
  for (const cb of cbs) cb(0, { presentedFrames: 7 });
  await tick(20);
  const cbs2 = [...pending.values()]; pending.clear();
  for (const cb of cbs2) cb(0, { presentedFrames: 7 });
  await tick(20);
  cam.close('test');
  assert.equal(decodeCalls, 1, '同帧不得重解，实测 decode 调用 ' + decodeCalls + ' 次');
});

test('P0-2 legacyLoop=true 强制旧 setTimeout 循环（不注册 rVFC 回调）', async () => {
  const s = setupRvfc({ legacyLoop: true });
  await s.cam.open({});
  await tick(30);
  assert.equal(s.rafcRegistrations, 0, 'legacyLoop 下不得注册 rVFC 回调，实测 ' + s.rafcRegistrations + ' 次');
  assert.ok(s.counts.decodeCalls >= 2, 'legacyLoop 应由 setTimeout 驱动解码，实测 ' + s.counts.decodeCalls + ' 次');
  s.cam.close('test');
});

test('P0-2 rVFC 回调抛错时 try/catch 兜底，不中断会话', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  let rafcId = 0, failOnce = true;
  const pending = new Map();
  video.requestVideoFrameCallback = cb => {
    const id = ++rafcId; pending.set(id, cb); return id;
  };
  video.cancelVideoFrameCallback = id => { pending.delete(id); };
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let decodeCalls = 0;
  const cam = ScanCamera.attach({
    document, win: document.defaultView,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2,
    capture: () => {
      if (failOnce) { failOnce = false; throw new Error('drawImage boom'); }
      return { width: 640, height: 480, data: new Uint8ClampedArray(4) };
    },
    decode: async () => { decodeCalls++; return null; }
  });
  await cam.open({});
  await tick(10);
  const cbs = [...pending.values()]; pending.clear();
  for (const cb of cbs) cb(0, { presentedFrames: 1 });   // 这帧 capture 抛错
  await tick(20);
  const cbs2 = [...pending.values()]; pending.clear();
  for (const cb of cbs2) cb(0, { presentedFrames: 2 });  // 回退后应能继续
  await tick(20);
  assert.equal(cam.isOpen(), true, 'rVFC 回调异常应被兜住，会话不中断');
  cam.close('test');
});

/* ================= P0-3 相机能力探测：对焦三态 ================= */

function setupTrack(trackOpts = {}) {
  const track = {
    stop() {},
    getCapabilities: trackOpts.noCaps ? undefined : (() => () => {
      const c = {};
      if (trackOpts.focusModes) c.focusMode = trackOpts.focusModes;
      if (trackOpts.zoom) c.zoom = trackOpts.zoom;
      if (trackOpts.torch) c.torch = trackOpts.torch;
      return c;
    })(),
    applyConstraints: trackOpts.applyReject ? (() => { throw new Error('constraints rejected'); }) : (async () => {}),
    getSettings: trackOpts.settings || (() => ({}))
  };
  return track;
}

test('P0-3 对焦三态之一：能力缺失（无 getCapabilities）→ 静默不抛错', async () => {
  const track = setupTrack({ noCaps: true });
  const { cam } = setup({ track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } });
  await cam.open({});
  assert.equal(cam.isOpen(), true);
  cam.close('test');
});

test('P0-3 对焦三态之二：focusMode 能力不含 continuous → 不请求 applyConstraints', async () => {
  let applyCalled = 0;
  const track = setupTrack({ focusModes: ['manual'], applyReject: false });
  track.applyConstraints = async () => { applyCalled++; };
  const { cam } = setup({ track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } });
  await cam.open({});
  await tick(10);
  assert.equal(applyCalled, 0, '能力不含 continuous 时不得请求对焦约束');
  cam.close('test');
});

test('P0-3 对焦三态之三：applyConstraints reject → 静默，会话与流释放不泄漏', async () => {
  let stops = 0;
  const track = setupTrack({ focusModes: ['continuous', 'auto'], applyReject: true });
  track.stop = () => { stops++; };
  const s = setup({ track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } });
  await s.cam.open({});
  await tick(10);
  assert.equal(s.cam.isOpen(), true, 'applyConstraints reject 不得中断会话');
  s.cam.close('test');
  assert.equal(stops, 1, '关闭后 track 必须 stop，不泄漏');
});

test('P0-3 对焦成功路径：能力含 continuous → 请求约束且 getSettings 回读生效', async () => {
  let applied = null;
  const track = setupTrack({ focusModes: ['continuous', 'auto'] });
  track.applyConstraints = async c => { applied = c; };
  track.getSettings = () => ({ focusMode: 'continuous' });
  const { cam } = setup({ track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } });
  await cam.open({});
  await tick(10);
  assert.ok(applied && applied.advanced && applied.advanced[0] && applied.advanced[0].focusMode === 'continuous',
    '应请求 focusMode:continuous，实测 ' + JSON.stringify(applied));
  cam.close('test');
});

test('P0-3 torch 不默认开：能力存在也不主动 applyConstraints torch', async () => {
  let applied = [];
  const track = setupTrack({ focusModes: ['continuous'], torch: true });
  track.applyConstraints = async c => { applied.push(c); };
  track.getSettings = () => ({ focusMode: 'continuous' });
  const { cam } = setup({ track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } });
  await cam.open({});
  await tick(10);
  const torchCalls = applied.filter(c => c.advanced && c.advanced[0] && 'torch' in c.advanced[0]);
  assert.equal(torchCalls.length, 0, 'torch 不得默认开启，实测 ' + JSON.stringify(applied));
  cam.close('test');
});

test('P0-3 miss≥24 帧且能力含 torch → 给「打开照明」按钮，点击后开 torch', async () => {
  const applied = [];
  const track = setupTrack({ focusModes: ['continuous'], torch: true });
  track.applyConstraints = async c => { applied.push(c); };
  track.getSettings = () => ({ focusMode: 'continuous' });
  const { document: d, cam } = setup({
    intervalMs: 1, track,
    stream: { getTracks: () => [track], getVideoTracks: () => [track] },
    decode: async () => null
  });
  await cam.open({});
  await tick(120);   // ≥24 帧 miss
  const btn = [...d.querySelectorAll('button')].find(b => /打开照明/.test(b.textContent));
  assert.ok(btn, 'miss≥24 帧应给出「打开照明」按钮');
  btn.click();
  await tick(5);
  assert.ok(applied.some(c => c.advanced && c.advanced[0] && c.advanced[0].torch === true),
    '点击后应申请 torch:true，实测 ' + JSON.stringify(applied));
  cam.close('test');
});

test('P0-3 miss≥6 帧分级引导文案：先距离提示，持续 miss 升级拿远提示', async () => {
  const { document: d, cam } = setup({ intervalMs: 1, decode: async () => null });
  await cam.open({});
  await tick(30);   // ~30 帧 → ≥6 应已提示第一级
  const s1 = d.getElementById('scanCamStatus').textContent;
  assert.match(s1, /请将码放入框内|靠太近了|暂未识别/);
  await tick(60);   // 更多帧 → ≥18 应升级第二级
  const s2 = d.getElementById('scanCamStatus').textContent;
  assert.match(s2, /靠太近了|请将码放入框内|暂未识别/);
  cam.close('test');
});

/* ================= P0-4 观测埋点：window.__scanPerf ================= */

test('P0-4 close 后 window.__scanPerf 有完整累计（captureMs/decodeMs/missCount/hitCount/engineName/firstHitMs）', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const win = document.defaultView;
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let n = 0;
  const cam = ScanCamera.attach({
    document, win,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true,
    capture: () => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) }),
    decode: async () => { n++; return n >= 3 ? { text: 'LOC:L-A', format: '二维码' } : null; }
  });
  await cam.open({});
  await tick(60);
  cam.close('test');
  const p = win.__scanPerf;
  assert.ok(p, 'close 后应发布 __scanPerf');
  assert.ok(typeof p.captureMs === 'number' && p.captureMs >= 0, 'captureMs 应为数字');
  assert.ok(typeof p.decodeMs === 'number' && p.decodeMs >= 0, 'decodeMs 应为数字');
  assert.ok(p.missCount >= 2, '前 2 帧未命中应计入 missCount，实测 ' + p.missCount);
  assert.ok(p.hitCount >= 1, '第 3 帧命中应计入 hitCount，实测 ' + p.hitCount);
  assert.equal(p.engineName, 'jsQR+ItemBarcode');
  assert.ok(p.firstHitMs > 0, '首帧命中耗时应大于 0，实测 ' + p.firstHitMs);
});
