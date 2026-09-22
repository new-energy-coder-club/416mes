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
    decode: opts.decode, decodeAll: opts.decodeAll,
    multiEngine: opts.multiEngine, voteThreshold: opts.voteThreshold, voteWindow: opts.voteWindow,
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

test('画面出现多个码：候选列表逐个选择，确定只填入选中的码（P1-1 decodeAll 多命中 + P1-2 投票）', async () => {
  const confirmed = [];
  /* P1-2 投票序列：第 1 帧 A、第 2 帧 B+C、第 3 帧起 A+B+C（A/B/C 均 ≥2 次进候选）。 */
  const A = { text: 'LOC:L-A', format: '二维码' };
  const B = { text: 'ITM:WP-001', format: '二维码' };
  const C = { text: 'CTN:C-A', format: '二维码' };
  let frame = 0;
  const { document: d, cam } = setup({
    decodeAll: async () => {
      frame++;
      if (frame === 1) return [A];
      if (frame === 2) return [B, C];
      return [A, B, C];
    }
  });
  await cam.open({ onConfirm: t => confirmed.push(t) });
  assert.ok(await waitFor(() => d.getElementById('scanCamCandidates').children.length >= 2, 3000),
    '应有 2 个「改选」候选按钮（3 个候选去掉选中项），实测 ' + d.getElementById('scanCamCandidates').children.length);
  assert.match(d.getElementById('scanCamCandidatesHint').textContent, /多个码/);
  /* 首选 = score 最高者（A/B/C 均 count 2、无 box → 同分，按插入序 A 首选）。 */
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:L-A');
  /* 点第 1 个候选按钮（B）→ 确认值切换为 B。 */
  d.getElementById('scanCamCandidates').querySelector('button').click();
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
  assert.ok(await waitFor(() => /请将码放入框内|靠太近了|暂未识别/.test(d.getElementById('scanCamStatus').textContent)),
    '无命中时应给出分级引导或兜底提示');
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
  assert.ok(await waitFor(() => sizes.length >= 2, 3000), '应至少取帧 2 次，实测 ' + sizes.length);
  cam.close('test');
  assert.equal(sizes[0], '960x540', '首帧应走快路径 960×540，实测 ' + sizes[0]);
  assert.equal(sizes[1], '960x540', '第 2 帧应走快路径 960×540，实测 ' + sizes[1]);
});

test('P0-1 慢路径：每 4 帧跑一次全帧 1920×1080 兜小码', async () => {
  const { cam, sizes } = setupPipeline({ frameScale: 0.5, fullFrameEvery: 4 });
  await cam.open({});
  assert.ok(await waitFor(() => sizes.length >= 5, 3000), '应至少取帧 5 次，实测 ' + sizes.length);
  cam.close('test');
  assert.equal(sizes[3], '1920x1080', '第 4 帧应走慢路径全帧，实测 ' + sizes[3]);
  assert.equal(sizes[4], '960x540', '第 5 帧应回到快路径，实测 ' + sizes[4]);
});

test('P0-1 fullFrameEvery 可调：每 2 帧一次全帧', async () => {
  const { cam, sizes } = setupPipeline({ frameScale: 0.5, fullFrameEvery: 2 });
  await cam.open({});
  assert.ok(await waitFor(() => sizes.length >= 3, 3000), '应至少取帧 3 次，实测 ' + sizes.length);
  cam.close('test');
  assert.equal(sizes[1], '1920x1080', '第 2 帧应走慢路径全帧，实测 ' + sizes[1]);
  assert.equal(sizes[2], '960x540', '第 3 帧应回到快路径，实测 ' + sizes[2]);
});

test('P0-1 pipeline:legacy 回归：全部帧走旧全帧路径 1920×1080', async () => {
  const { cam, sizes } = setupPipeline({ pipeline: 'legacy' });
  await cam.open({});
  assert.ok(await waitFor(() => sizes.length >= 2, 3000), '应至少取帧 2 次，实测 ' + sizes.length);
  cam.close('test');
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
  assert.ok(await waitFor(() => sizes.length >= 2, 3000), '注入 capture 应被逐帧调用，实测 ' + sizes.length);
  cam.close('test');
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
  assert.ok(await waitFor(() => calls >= 2, 3000), '应至少调用 decode 2 次，实测 ' + calls);
  cam.close('test');
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
  assert.ok(await waitFor(() => s.counts.decodeCalls >= 2, 3000), 'legacyLoop 应由 setTimeout 驱动解码，实测 ' + s.counts.decodeCalls + ' 次');
  assert.equal(s.rafcRegistrations, 0, 'legacyLoop 下不得注册 rVFC 回调，实测 ' + s.rafcRegistrations + ' 次');
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
  assert.ok(await waitFor(() => [...d.querySelectorAll('button')].some(b => /打开照明/.test(b.textContent))),
    'miss≥24 帧（暗环境）应给出「打开照明」按钮');
  const btn = [...d.querySelectorAll('button')].find(b => /打开照明/.test(b.textContent));
  btn.click();
  await tick(5);
  assert.ok(applied.some(c => c.advanced && c.advanced[0] && c.advanced[0].torch === true),
    '点击后应申请 torch:true，实测 ' + JSON.stringify(applied));
  cam.close('test');
});

/* 轮询直到条件满足或超时（比固定 tick 更抗 CI/负载抖动）。 */
async function waitFor(fn, timeoutMs = 2000, stepMs = 10) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await tick(stepMs);
  }
}

test('P0-3 miss≥6 帧分级引导文案：先距离提示，持续 miss 升级拿远提示', async () => {
  const { document: d, cam } = setup({ intervalMs: 1, decode: async () => null });
  await cam.open({});
  assert.ok(await waitFor(() => /请将码放入框内|暂未识别/.test(d.getElementById('scanCamStatus').textContent)),
    '≥6 帧 miss 应给出第一级引导');
  assert.ok(await waitFor(() => /靠太近了/.test(d.getElementById('scanCamStatus').textContent)),
    '≥18 帧 miss 应升级第二级引导');
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
  /* P1-2 投票阈值 2：第 3 帧首现计票，第 4 帧才达标进候选（hitCount 在达标时累计）。 */
  assert.ok(await waitFor(() => n >= 4, 3000), '应至少 decode 4 次（第 4 帧投票达标），实测 ' + n);
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

/* ================= P1-1 多码检测层：引擎链（lib/scan-engine.js） ================= */

const ScanEngine = require('../lib/scan-engine');

test('P1-1 引擎链：BarcodeDetector 可用时走原生多码路径并记 engineName', async () => {
  const calls = [];
  const fakeDetector = {
    detect: async image => {
      calls.push(image);
      return [
        { rawValue: 'LOC:L-A', format: 'qr_code', boundingBox: { x: 10, y: 10, width: 80, height: 80 } },
        { rawValue: 'ITM:WP-001', format: 'qr_code', boundingBox: { x: 300, y: 200, width: 60, height: 60 } }
      ];
    }
  };
  const win = {
    BarcodeDetector: function (cfg) { this.cfg = cfg; return fakeDetector; }
  };
  win.BarcodeDetector.getSupportedFormats = () => ['qr_code', 'code_128', 'ean_13'];
  const chain = ScanEngine.createChain({ win, document: null, multiEngine: 'on' });
  const image = { width: 640, height: 480, data: new Uint8ClampedArray(4) };
  const hits = await chain.decodeAll(image);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].text, 'LOC:L-A');
  assert.equal(hits[0].format, '二维码');
  assert.ok(hits[0].box && hits[0].box.w === 80, '原生路径应带 box');
  assert.equal(chain.engineName(), 'BarcodeDetector');
});

test('P1-1 引擎链：BarcodeDetector 抛错自动降级到第 3 级 jsQR 并记 engineName', async () => {
  const win = {
    jsQR: (data, w, h) => (w === 640 ? { data: 'LOC:L-A' } : null),
    BarcodeDetector: function () {
      return { detect: async () => { throw new Error('native boom'); } };
    }
  };
  win.BarcodeDetector.getSupportedFormats = () => ['qr_code'];
  const chain = ScanEngine.createChain({ win, document: null, multiEngine: 'on' });
  const hits = await chain.decodeAll({ width: 640, height: 480, data: new Uint8ClampedArray(4) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'LOC:L-A');
  assert.equal(chain.engineName(), 'jsQR+ItemBarcode');
});

test('P1-1 引擎链：BarcodeDetector 不可用（无 getSupportedFormats 交集）→ 跳过到第 3 级', async () => {
  const win = {
    jsQR: () => ({ data: 'MAT:GJ-1' }),
    BarcodeDetector: function () { return { detect: async () => [] }; }
  };
  win.BarcodeDetector.getSupportedFormats = () => ['maxicode'];   // 与 WANTED_FORMATS 无交集
  const chain = ScanEngine.createChain({ win, document: null, multiEngine: 'on' });
  const hits = await chain.decodeAll({ width: 640, height: 480, data: new Uint8ClampedArray(4) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'MAT:GJ-1');
  assert.equal(chain.engineName(), 'jsQR+ItemBarcode');
});

test('P1-1 引擎链：multiEngine=off 时只用第 3 级（即使原生可用）', async () => {
  let nativeCalls = 0;
  const win = {
    jsQR: () => ({ data: 'LOC:L-A' }),
    BarcodeDetector: function () { nativeCalls++; return { detect: async () => [{ rawValue: 'X', format: 'qr_code' }] }; }
  };
  win.BarcodeDetector.getSupportedFormats = () => ['qr_code'];
  const chain = ScanEngine.createChain({ win, document: null, multiEngine: 'off' });
  const hits = await chain.decodeAll({ width: 640, height: 480, data: new Uint8ClampedArray(4) });
  assert.equal(nativeCalls, 0, 'off 模式不得实例化 BarcodeDetector');
  assert.equal(hits[0].text, 'LOC:L-A');
});

test('P1-1 zxing-wasm 就绪后走第 2 级；抛错降级第 3 级', async () => {
  const win = { jsQR: () => ({ data: 'LOC:L-A' }) };
  const chain = ScanEngine.createChain({ win, document: null, multiEngine: 'on' });
  /* 未预热：直接第 3 级。 */
  let hits = await chain.decodeAll({ width: 640, height: 480, data: new Uint8ClampedArray(4) });
  assert.equal(chain.engineName(), 'jsQR+ItemBarcode');
  /* 模拟预热完成（真机由 warmUp 加载；测试直接挂全局）。 */
  win.ZXingWASM = {
    readBarcodes: async (image, opts) => {
      assert.equal(opts.maxNumberOfSymbols, 8);
      assert.equal(opts.tryDownscale, true);
      return [{ text: 'ITM:WP-001', format: 'qrcode', position: { topLeft: { x: 5, y: 5 }, topRight: { x: 55, y: 5 }, bottomLeft: { x: 5, y: 55 }, bottomRight: { x: 55, y: 55 } } }];
    }
  };
  chain._setZxingReady(true);
  hits = await chain.decodeAll({ width: 640, height: 480, data: new Uint8ClampedArray(4) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'ITM:WP-001');
  assert.equal(hits[0].format, '二维码');
  assert.ok(hits[0].box && hits[0].box.w === 50, 'zxing position 应换算成 box');
  assert.equal(chain.engineName(), 'zxing-wasm');
  /* 第 2 级抛错 → 降级第 3 级。 */
  win.ZXingWASM.readBarcodes = async () => { throw new Error('wasm boom'); };
  hits = await chain.decodeAll({ width: 640, height: 480, data: new Uint8ClampedArray(4) });
  assert.equal(hits[0].text, 'LOC:L-A');
  assert.equal(chain.engineName(), 'jsQR+ItemBarcode');
});

test('P1-1 loadScriptWithFallback：CDN 失败 → 本地成功；双失败 → false', async () => {
  /* 假 document：第一个 script 触发 error，第二个 load。 */
  function fakeDoc(behaviors) {
    return {
      createElement: () => {
        const el = { addEventListener: (ev, cb) => { el['on' + ev] = cb; }, set src(v) { el._src = v; }, get src() { return el._src; }, remove() {} };
        return el;
      },
      head: { appendChild: el => { const b = behaviors.shift(); setTimeout(() => el['on' + b] && el['on' + b](), 0); } }
    };
  }
  /* CDN error → 本地 load。 */
  let ok = await ScanEngine.loadScriptWithFallback(fakeDoc(['error', 'load']), ['cdn.js', 'local.js'], 1000);
  assert.equal(ok, true);
  /* 双 error → false。 */
  ok = await ScanEngine.loadScriptWithFallback(fakeDoc(['error', 'error']), ['cdn.js', 'local.js'], 1000);
  assert.equal(ok, false);
});

test('P1-1 scan-camera 集成：opts.decodeAll 注入一帧 4 命中 → seen 4 项、候选 3 按钮、选中即确认项', async () => {
  const hits4 = ['LOC:L-A', 'ITM:WP-001', 'CTN:C-A', 'MAT:GJ-1'].map(t => ({ text: t, format: '二维码' }));
  const { document: d, cam } = setup({
    decodeAll: async () => hits4.slice()
  });
  await cam.open({ onConfirm: () => {} });
  assert.ok(await waitFor(() => d.getElementById('scanCamCandidates').children.length >= 3, 3000),
    '4 候选应渲染 3 个「改选」按钮，实测 ' + d.getElementById('scanCamCandidates').children.length);
  /* 同分无 box → 候选按插入序：选中 LOC:L-A，按钮序 [ITM, CTN, MAT]。
     点第 1 个候选按钮 → 确认值变为 ITM:WP-001。 */
  const btns = d.getElementById('scanCamCandidates').querySelectorAll('button');
  assert.equal(btns.length, 3);
  btns[0].click();
  await tick(5);
  assert.equal(d.getElementById('scanCamValue').textContent, 'ITM:WP-001');
  cam.close('test');
});

/* ================= P1-2 多帧投票与排序 ================= */

test('P1-2 投票阈值边界：单帧孤证不弹卡，连续 2 帧（默认阈值 2）弹出', async () => {
  /* 阈值 2：第 1 帧注入假阳性 → 不弹；第 2 帧同码 → 弹。
     用阻塞门控确定性推进帧序列（不受计时器速度影响）。 */
  let frames = 0;
  let release; const hold = new Promise(r => { release = r; });
  const { document: d, cam } = setup({
    voteThreshold: 2,
    decodeAll: async () => {
      frames++;
      if (frames === 1) return [{ text: 'GHOST:1', format: '二维码' }];
      await hold;   // 第 2 帧起阻塞，直到断言完单帧行为后放行
      return [{ text: 'GHOST:1', format: '二维码' }];
    }
  });
  await cam.open({});
  assert.ok(await waitFor(() => frames >= 1, 2000), '第 1 帧应已处理');
  await tick(30);
  assert.equal(d.getElementById('scanCamConfirm').hidden, true, '单帧孤证不得弹确认卡');
  release();   // 放行第 2 帧
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 2000),
    '第 2 帧同码出现应弹确认卡');
  cam.close('test');
});

test('P1-2 voteThreshold=1 即 P0 现状语义：单帧即弹卡', async () => {
  const { document: d, cam } = setup({
    voteThreshold: 1,
    decodeAll: async () => [{ text: 'LOC:L-A', format: '二维码' }]
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 2000),
    '阈值 1 应单帧即弹卡（P0 兼容语义）');
  cam.close('test');
});

test('P1-2 score 排序：中心码排第一，边缘码排后；describe 拒绝排最后且禁用', async () => {
  /* 三码：CENTER（画面中心，面积大）/ EDGE（角落，小）/ BAD（describe 拒绝）。
     均连续 3 帧出现（count 相同），score 差异来自中心距离与面积。 */
  const CENTER = { text: 'LOC:CENTER', format: '二维码', box: { x: 280, y: 200, w: 80, h: 80 } };
  const EDGE = { text: 'LOC:EDGE', format: '二维码', box: { x: 10, y: 10, w: 30, h: 30 } };
  const BAD = { text: 'ITM:BAD', format: '二维码', box: { x: 290, y: 210, w: 60, h: 60 } };
  const { document: d, cam } = setup({
    decodeAll: async () => [EDGE, BAD, CENTER]   // 插入序故意打乱
  });
  await cam.open({
    describe: hit => hit.text === 'ITM:BAD' ? { text: '类型不符', ok: false } : { text: 'ok' }
  });
  assert.ok(await waitFor(() => d.getElementById('scanCamCandidates').children.length >= 2, 3000));
  /* 首选 = CENTER（中心 + 大框，score 最高；BAD describe 拒绝排最后）。 */
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:CENTER');
  const btns = [...d.getElementById('scanCamCandidates').querySelectorAll('button')];
  assert.equal(btns.length, 2);
  assert.match(btns[0].textContent, /LOC:EDGE/, '第 1 候选按钮应是 EDGE（BAD 排后）');
  assert.match(btns[1].textContent, /ITM:BAD/, '第 2 候选按钮应是 BAD');
  assert.equal(btns[1].disabled, true, 'describe 拒绝的候选按钮应禁用');
  /* 选中 BAD → 确定禁用。 */
  const badEntry = [...d.getElementById('scanCamCandidates').children].find(b => /BAD/.test(b.textContent));
  badEntry.click();
  await tick(5);
  assert.equal(d.getElementById('scanCamYes').disabled, true);
  assert.match(d.getElementById('scanCamMeta').textContent, /类型不符/);
  cam.close('test');
});

test('P1-2 投票窗口：同码间隔 ≥3 帧不出现视为新票（窗口外旧票不计）', async () => {
  /* 帧序列：A, 空, 空, A → 第 1 帧与第 4 帧间隔 3 帧（=voteWindow），旧票被挤出窗口，
     第 4 帧时窗口内只有 1 票 → 不弹；第 5 帧再来 A → 窗口内 2 票 → 弹。 */
  let frame = 0;
  const seq = { 1: 'A', 4: 'A', 5: 'A' };
  let release; const hold = new Promise(r => { release = r; });
  const { document: d, cam } = setup({
    voteThreshold: 2, voteWindow: 3,
    decodeAll: async () => {
      frame++;
      if (frame === 5) await hold;   // 第 5 帧阻塞，直到「第 4 帧不弹卡」断言完成
      const t = seq[frame];
      return t ? [{ text: t, format: '二维码' }] : [];
    }
  });
  await cam.open({});
  /* 等到第 4 帧处理完（第 5 帧被门控阻塞，不会越权弹卡）。 */
  await waitFor(() => frame >= 4, 2000);
  await tick(30);
  assert.equal(d.getElementById('scanCamConfirm').hidden, true, '窗口外旧票不得累计成候选');
  release();
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 2000),
    '第 5 帧同码回窗应累计成候选');
  cam.close('test');
});

/* ================= P1-3 框选重扫 + zoom 三态 ================= */

/* P1-3 测试夹具：假 canvas（支持 drawImage/getImageData 记录）+ 可控 decodeAll。 */
function setupCrop(opts = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 1920; video.videoHeight = 1080;
  video.play = async () => {};
  const create = document.createElement.bind(document);
  const cropDraws = [];
  document.createElement = tag => {
    const elc = create(tag);
    if (String(tag).toLowerCase() === 'canvas') {
      elc.getContext = () => ({
        drawImage: (v, sx, sy, sw, sh, dx, dy, dw, dh) => {
          if (dw === 720) cropDraws.push({ sx, sy, sw, sh, dw, dh });
        },
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      });
    }
    return elc;
  };
  let stopped = 0;
  const applied = [];
  const track = Object.assign({
    stop() { stopped++; },
    getCapabilities: () => {
      const c = {};
      if (opts.zoomCaps) c.zoom = opts.zoomCaps;
      return c;
    },
    applyConstraints: opts.zoomReject ? (async () => { throw new Error('zoom rejected'); }) : (async c => { applied.push(c); }),
    getSettings: () => ({ zoom: opts.currentZoom || 1 })
  }, opts.trackExtra || {});
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let fullFrameCalls = 0, cropCalls = 0;
  const cam = ScanCamera.attach({
    document, win: document.defaultView,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true,
    capture: () => { fullFrameCalls++; return { width: 960, height: 540, data: new Uint8ClampedArray(4) }; },
    decodeAll: async image => {
      if (image.width === 720) { cropCalls++; return opts.cropHits || []; }
      return opts.fullHits || [];
    }
  });
  return { document, cam, cropDraws, applied, get stopped() { return stopped; }, get fullFrameCalls() { return fullFrameCalls; }, get cropCalls() { return cropCalls; } };
}

test('P1-3 连续 miss ≥12 帧显示「框选重扫」入口；点击中心 crop 720×720 重解命中', async () => {
  const { document: d, cam, cropDraws } = setupCrop({
    fullHits: [],
    cropHits: [{ text: 'LOC:SMALL', format: '二维码' }]
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamCrop').hidden, 3000),
    'miss ≥12 帧应显示框选重扫入口');
  d.getElementById('scanCamCrop').click();   // 点击 = 以画面中心重扫
  assert.ok(await waitFor(() => cropDraws.length >= 1, 3000), '点击后应执行 crop');
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000),
    'crop 重解命中应弹确认卡');
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:SMALL');
  /* crop 几何：中心点 (0.5,0.5) → 源矩形 1/4 视野居中。 */
  assert.equal(cropDraws[0].sw, 480, 'crop 源宽 = 1920/4');
  assert.equal(cropDraws[0].sh, 270, 'crop 源高 = 1080/4');
  assert.equal(cropDraws[0].dw, 720);
  cam.close('test');
});

test('P1-3 多码候选 ≥2 时也显示入口（即便 miss <12）', async () => {
  const two = [{ text: 'LOC:A', format: '二维码' }, { text: 'LOC:B', format: '二维码' }];
  const { document: d, cam } = setupCrop({ fullHits: two, cropHits: [] });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000));
  assert.ok(await waitFor(() => !d.getElementById('scanCamCrop').hidden, 3000),
    '多码候选时应显示框选重扫入口');
  cam.close('test');
});

test('P1-3 zoom 三态之一：能力存在 → applyConstraints({zoom: min(max, 2×当前)})', async () => {
  const { document: d, cam, applied } = setupCrop({
    zoomCaps: { min: 1, max: 4 }, currentZoom: 1.5,
    fullHits: [], cropHits: [{ text: 'LOC:Z', format: '二维码' }]
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamCrop').hidden, 3000),
    'miss ≥12 帧应显示框选重扫入口');
  d.getElementById('scanCamCrop').click();
  assert.ok(await waitFor(() => applied.length >= 1, 3000), 'crop 时应请求 zoom 约束');
  const z = applied[0].advanced[0].zoom;
  assert.equal(z, 3, 'zoom = min(max 4, 2×1.5) = 3，实测 ' + z);
  cam.close('test');
});

test('P1-3 zoom 三态之二：能力缺失 → 不请求 zoom 约束也不报错', async () => {
  const { document: d, cam, applied } = setupCrop({
    zoomCaps: null, fullHits: [], cropHits: [{ text: 'LOC:Z', format: '二维码' }]
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamCrop').hidden, 3000));
  d.getElementById('scanCamCrop').click();
  await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000);
  assert.equal(applied.filter(c => c.advanced && c.advanced[0] && 'zoom' in c.advanced[0]).length, 0,
    '无 zoom 能力时不得请求 zoom 约束');
  cam.close('test');
});

test('P1-3 zoom 三态之三：applyConstraints reject → 静默，crop 流程不受影响', async () => {
  const { document: d, cam } = setupCrop({
    zoomCaps: { min: 1, max: 4 }, zoomReject: true,
    fullHits: [], cropHits: [{ text: 'LOC:ZR', format: '二维码' }]
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamCrop').hidden, 3000),
    'miss ≥12 帧应显示框选重扫入口');
  d.getElementById('scanCamCrop').click();
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000),
    'zoom reject 应被静默兜住，crop 命中仍弹卡');
  cam.close('test');
});

test('P1-3 crop 未命中不弹卡，入口保持可用', async () => {
  const { document: d, cam, cropDraws } = setupCrop({ fullHits: [], cropHits: [] });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamCrop').hidden, 3000));
  d.getElementById('scanCamCrop').click();
  await waitFor(() => cropDraws.length >= 1, 3000);
  await tick(30);
  assert.equal(d.getElementById('scanCamConfirm').hidden, true, 'crop 未命中不得弹卡');
  assert.equal(d.getElementById('scanCamCrop').hidden, false, '入口应保持可用');
  cam.close('test');
});

/* ================= P1-4 解码 Worker 化 ================= */

/* 假 Worker 类：同步/异步回调消息，记录 postMessage 负载与 terminate。 */
function makeFakeWorker(opts = {}) {
  const instances = [];
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.posted = [];
      this.transfers = [];
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      instances.push(this);
      if (opts.constructThrow) throw new Error('construct boom');
    }
    postMessage(payload, transfer) {
      this.posted.push(payload);
      this.transfers.push(transfer);
      const msg = typeof opts.reply === 'function' ? opts.reply(payload) : opts.reply;
      if (msg) {
        const deliver = () => {
          if (this.terminated) return;
          if (msg.error && opts.deliverAsError) this.onerror && this.onerror(new Error(msg.error));
          else this.onmessage && this.onmessage({ data: msg });
        };
        if (opts.asyncReply) setTimeout(deliver, opts.asyncReplyMs || 5);
        else deliver();
      }
    }
    terminate() { this.terminated = true; if (opts.onTerminate) opts.onTerminate(this); }
  }
  return { FakeWorker, instances };
}

/* 带假 Worker 的 setup（win 注入 Worker；decode 走 worker 桥）。 */
function setupWorker(opts = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const fw = makeFakeWorker(opts.worker || {});
  const win = Object.assign({}, document.defaultView, { Worker: fw.FakeWorker });
  if (opts.winExtra) Object.assign(win, opts.winExtra);
  const cam = ScanCamera.attach({
    document, win,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true,
    worker: opts.workerFlag,   // undefined = 默认开
    capture: () => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) })
  });
  return { document, cam, win, instances: fw.instances };
}

test('P1-4 协议正确性：decode 转发 worker（{id,image} + transfer），命中弹卡', async () => {
  const { document: d, cam, instances } = setupWorker({
    worker: { reply: p => ({ id: p.id, hits: [{ text: 'LOC:W1', format: '二维码' }] }) }
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000),
    'worker 命中应弹确认卡');
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:W1');
  const w = instances[0];
  assert.ok(w, '应构造 Worker');
  assert.match(w.url, /scan-decode-worker\.js$/, 'Worker URL 应指向 lib/scan-decode-worker.js，实测 ' + w.url);
  const payload = w.posted[0];
  assert.equal(typeof payload.id, 'number', '协议应带数字 id');
  assert.equal(payload.image.width, 640);
  assert.equal(payload.image.height, 480);
  assert.ok(payload.image.data instanceof ArrayBuffer, 'image.data 应为 ArrayBuffer（transferable）');
  assert.ok(w.transfers[0] && w.transfers[0][0] === payload.image.data, 'transfer 列表应含 data buffer');
  cam.close('test');
});

test('P1-4 迟到丢弃：worker 回未知 id 不解析；close() 时 terminate 无挂起', async () => {
  const { document: d, cam, instances } = setupWorker({
    worker: { reply: p => ({ id: p.id + 999, hits: [{ text: 'GHOST', format: '二维码' }] }) }
  });
  await cam.open({});
  await tick(100);
  assert.equal(d.getElementById('scanCamConfirm').hidden, true, '未知 id 的迟到响应不得弹卡');
  cam.close('test');
  assert.equal(instances[0].terminated, true, 'close() 必须 terminate worker');
});

test('P1-4 回退触发：worker 回 error → 自动降级主线程链（win.jsQR）并继续出卡', async () => {
  const { document: d, cam, instances } = setupWorker({
    worker: { reply: p => ({ id: p.id, error: 'wasm boom' }) },
    winExtra: { jsQR: () => ({ data: 'LOC:FALLBACK' }) }
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000),
    'worker error 后应回退主线程链出卡');
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:FALLBACK');
  cam.close('test');
});

test('P1-4 回退触发：worker 构造抛错 → 静默走主线程链', async () => {
  const { document: d, cam } = setupWorker({
    worker: { constructThrow: true },
    winExtra: { jsQR: () => ({ data: 'LOC:CF' }) }
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000),
    '构造失败应静默回退主线程链');
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:CF');
  cam.close('test');
});

test('P1-4 opts.worker=false：不构造 Worker，直接主线程链', async () => {
  const { document: d, cam, instances } = setupWorker({
    workerFlag: false,
    worker: { reply: p => ({ id: p.id, hits: [{ text: 'LOC:NO', format: '二维码' }] }) },
    winExtra: { jsQR: () => ({ data: 'LOC:MAIN' }) }
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000));
  assert.equal(instances.length, 0, 'worker=false 时不得构造 Worker');
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:MAIN');
  cam.close('test');
});

test('P1-4 terminate 时机：close()/pagehide 后 worker 已 terminate，再 open 重建新实例', async () => {
  const { cam, instances } = setupWorker({
    worker: { reply: p => ({ id: p.id, hits: [] }), asyncReply: true, asyncReplyMs: 1 }
  });
  await cam.open({});
  await tick(50);
  cam.close('user');
  assert.equal(instances[0].terminated, true, 'close(user) 必须 terminate');
  await cam.open({});
  await tick(50);
  cam.close('pagehide');
  assert.equal(instances[1] && instances[1].terminated, true, '第二次会话的 worker 也必须 terminate');
  assert.ok(instances.length >= 2, '再 open 应重建新 worker 实例');
  cam.close('test');
});

test('P1-4 worker 解码超时（>2s）→ 回退主线程链', async () => {
  const { document: d, cam } = setupWorker({
    worker: { reply: null, asyncReply: false },   // 永不回复 → 超时
    winExtra: { jsQR: () => ({ data: 'LOC:TIMEOUT' }) }
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 5000),
    'worker 超时后应回退主线程链出卡');
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:TIMEOUT');
  cam.close('test');
});

/* ================= 修 A/B/C/D：确认卡性能回归 ================= */

/* 修 A：renderConfirm 签名去重 —— 相同候选集连续帧只渲染 1 次；候选集变化再渲染。 */
test('修 A：相同候选集连续帧 renderConfirm 只渲染 1 次（replaceChildren 计数）', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let replaceCount = 0;
  const origReplace = document.getElementById('scanCamCandidates').replaceChildren.bind(document.getElementById('scanCamCandidates'));
  document.getElementById('scanCamCandidates').replaceChildren = (...a) => { replaceCount++; return origReplace(...a); };
  const hits = [{ text: 'LOC:L-A', format: '二维码' }];
  const cam = ScanCamera.attach({
    document, win: document.defaultView,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true, voteThreshold: 1,
    capture: () => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) }),
    decodeAll: async () => hits.slice()
  });
  await cam.open({});
  assert.ok(await waitFor(() => replaceCount >= 1, 3000), '首帧候选应渲染 1 次');
  const afterFirst = replaceCount;
  await tick(100);   // 后续帧同候选集，签名相同 → 不再渲染
  assert.equal(replaceCount, afterFirst, '相同候选集不得重复渲染（修 A 签名去重），实测 ' + replaceCount + ' vs ' + afterFirst);
  cam.close('test');
});

test('修 A：候选集变化（新码达标）触发第 2 次渲染', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let replaceCount = 0;
  const origReplace = document.getElementById('scanCamCandidates').replaceChildren.bind(document.getElementById('scanCamCandidates'));
  document.getElementById('scanCamCandidates').replaceChildren = (...a) => { replaceCount++; return origReplace(...a); };
  let two = false;
  const cam = ScanCamera.attach({
    document, win: document.defaultView,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true, voteThreshold: 1,
    capture: () => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) }),
    decodeAll: async () => two
      ? [{ text: 'LOC:L-A', format: '二维码' }, { text: 'ITM:WP-001', format: '二维码' }]
      : [{ text: 'LOC:L-A', format: '二维码' }]
  });
  await cam.open({});
  assert.ok(await waitFor(() => replaceCount >= 1, 3000));
  two = true;
  assert.ok(await waitFor(() => replaceCount >= 2, 3000), '候选集变化应触发第 2 次渲染');
  cam.close('test');
});

/* 修 B：awaiting 期间 200ms 节流 —— 5 帧 rapid 只处理第 1 帧；>200ms 后恢复。 */
test('修 B：awaiting 确认期间 <200ms 的帧被跳过（capture 计数）', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let captures = 0, decodes = 0;
  let now = 1000;
  const fakeWin = Object.assign({}, document.defaultView, {
    performance: { now: () => now }
  });
  const cam = ScanCamera.attach({
    document, win: fakeWin,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true, voteThreshold: 1,
    capture: () => { captures++; return { width: 640, height: 480, data: new Uint8ClampedArray(4) }; },
    decodeAll: async () => { decodes++; return [{ text: 'LOC:L-A', format: '二维码' }]; }
  });
  await cam.open({});
  assert.ok(await waitFor(() => decodes >= 1, 3000), '第 1 帧应处理');
  const capAfterFirst = captures, decAfterFirst = decodes;
  /* rapid 推 5 帧（时间不动，<200ms 窗口内）→ 全被节流跳过。 */
  for (let i = 0; i < 5; i++) await tick(15);
  assert.equal(captures, capAfterFirst, 'awaiting 期间 <200ms 帧不得 capture（修 B），实测 ' + captures);
  assert.equal(decodes, decAfterFirst, 'awaiting 期间 <200ms 帧不得 decode（修 B），实测 ' + decodes);
  /* 时间推进 >200ms → 恢复处理。 */
  now += 250;
  await tick(15);
  assert.ok(await waitFor(() => decodes > decAfterFirst, 3000), '>200ms 后应恢复处理');
  cam.close('test');
});

/* 修 C：awaiting 期间不走全帧慢路径（fullFrameEvery 边界帧也走快路径尺寸）。 */
test('修 C：awaiting 期间 fullFrameEvery 边界帧仍走快路径（capture 尺寸 960×540）', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 1920; video.videoHeight = 1080;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const create = document.createElement.bind(document);
  const sizes = [];
  document.createElement = tag => {
    const elc = create(tag);
    if (String(tag).toLowerCase() === 'canvas') {
      elc.getContext = () => ({
        drawImage: (v, sx, sy, sw, sh, dx, dy, dw, dh) => sizes.push({ sw: sh === undefined ? undefined : sw, sh, dw: dh === undefined ? undefined : dw, dh }),
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      });
    }
    return elc;
  };
  const cam = ScanCamera.attach({
    document, win: document.defaultView,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true, voteThreshold: 1,
    fullFrameEvery: 2,
    decodeAll: async () => [{ text: 'LOC:L-A', format: '二维码' }]
  });
  await cam.open({});
  assert.ok(await waitFor(() => !document.getElementById('scanCamConfirm').hidden, 3000), '应进入 awaiting');
  sizes.length = 0;
  /* 修 B 节流：awaiting 中 <200ms 帧被跳过——等 >200ms 让 1 帧通过再断言尺寸。 */
  await tick(280);
  const fullSizes = sizes.filter(s => s.dw === undefined);
  assert.equal(fullSizes.length, 0, 'awaiting 期间不得有全帧 drawImage(video,0,0) 两参调用（修 C），实测 ' + fullSizes.length + ' 次，sizes=' + JSON.stringify(sizes));
  assert.ok(sizes.some(s => s.dw === 960), 'awaiting 期间应走 960×540 快路径（drawImage 8 参带目标尺寸），实测 sizes=' + JSON.stringify(sizes.slice(0, 3)));
  cam.close('test');
});

/* 修 D：worker 直 transfer（payload.data === image.data.buffer 同引用，发送后原 data
   detached）；worker 抛错回退时主线程链收到的是重新取的帧（capture 2 次，data 非空）。 */
test('修 D：worker 正常 → 直 transfer 不 slice（payload.data 同引用 + 发送后 detached）', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const instances = [];
  let lastPayload = null, lastTransfer = null;
  class FakeWorker {
    constructor(url) { this.onmessage = null; this.terminated = false; instances.push(this); }
    postMessage(payload, transfer) {
      lastPayload = payload; lastTransfer = transfer;
      /* 模拟真实 structured-clone transfer：detach transfer 列表里的每个 buffer。 */
      if (transfer) for (const buf of transfer) {
        if (buf && typeof buf.transfer === 'function') buf.transfer();
      }
      setTimeout(() => this.onmessage && this.onmessage({ data: { id: payload.id, hits: [{ text: 'LOC:W', format: '二维码' }] } }), 1);
    }
    terminate() { this.terminated = true; }
  }
  const win = Object.assign({}, document.defaultView, { Worker: FakeWorker });
  let capturedImage = null;
  const cam = ScanCamera.attach({
    document, win,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true, voteThreshold: 1,
    capture: () => { capturedImage = { width: 640, height: 480, data: new Uint8ClampedArray(4) }; return capturedImage; },
    worker: true
  });
  await cam.open({});
  assert.ok(await waitFor(() => lastPayload !== null, 3000), '应有 postMessage 发出');
  assert.equal(lastPayload.image.data, capturedImage.data.buffer,
    '修 D：payload.data 必须 === image.data.buffer（直 transfer 不 slice），实测不同引用');
  assert.ok(lastTransfer && lastTransfer[0] === capturedImage.data.buffer, 'transfer 列表应含同一 buffer');
  assert.equal(capturedImage.data.length, 0, '发送后原 image.data 应 detached（length 0）');
  cam.close('test');
});

test('修 D：worker 抛错回退 → 主线程链收到重新取的帧（capture 2 次，data 非 detached）', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  class FakeWorker {
    constructor() { this.onmessage = null; this.terminated = false; }
    postMessage(payload) {
      setTimeout(() => this.onmessage && this.onmessage({ data: { id: payload.id, error: 'boom' } }), 1);
    }
    terminate() { this.terminated = true; }
  }
  const win = Object.assign({}, document.defaultView, { Worker: FakeWorker });
  let captures = 0;
  const chainImages = [];
  let firstDetachedOk = false;
  const cam = ScanCamera.attach({
    document, win,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true, voteThreshold: 1,
    capture: () => {
      captures++;
      return { width: 640, height: 480, data: new Uint8ClampedArray(4) };
    },
    decodeAll: async image => {
      chainImages.push(image);
      return [{ text: 'LOC:MAIN', format: '二维码' }];
    }
  });
  /* decodeAll 注入时 bridge 不启用——改用 worker:true + jsQR 主链 spy。
     这里用 decode 注入（单结果）会禁用 worker；正确做法：不注入 decode，给 win.jsQR。 */
  cam.close('test');
  /* 重建：不注入 decode/decodeAll，worker 抛错 → 回退主线程 jsQR 链。 */
  const { document: d2 } = parseHTML(html);
  const video2 = d2.getElementById('scanCamVideo');
  video2.videoWidth = 640; video2.videoHeight = 480;
  video2.play = async () => {};
  const win2 = Object.assign({}, d2.defaultView, {
    Worker: FakeWorker,
    jsQR: (data, w, h) => {
      chainImages.push({ data, w, h });
      return { data: 'LOC:MAIN' };
    }
  });
  let captures2 = 0;
  const cam2 = ScanCamera.attach({
    document: d2, win: win2,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true, voteThreshold: 1,
    capture: () => { captures2++; return { width: 640, height: 480, data: new Uint8ClampedArray(4) }; }
  });
  await cam2.open({});
  assert.ok(await waitFor(() => !d2.getElementById('scanCamConfirm').hidden, 5000),
    'worker 抛错回退主线程链应出卡');
  assert.ok(captures2 >= 2, '回退必须重新取帧（capture ≥2：worker 帧 1 + 回退新帧 1），实测 ' + captures2);
  assert.ok(chainImages.length >= 1 && chainImages[0].data.length > 0,
    '主线程链收到的 image.data 不得 detached（length=' + (chainImages[0] && chainImages[0].data.length) + '）');
  assert.equal(d2.getElementById('scanCamValue').textContent, 'LOC:MAIN');
  cam2.close('test');
});
