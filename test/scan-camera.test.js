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
  const track = { stop() { stopped++; } };
  const stream = { getTracks: () => [track] };
  let pendingGet;
  const mediaDevices = opts.noMedia ? undefined : {
    getUserMedia: opts.hangMedia ? () => new Promise(r => { pendingGet = r; })
      : async () => { if (opts.mediaError) throw opts.mediaError; return stream; }
  };
  const cam = ScanCamera.attach({
    document, win: document.defaultView, mediaDevices,
    intervalMs: 2,
    capture: () => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) }),
    decode: opts.decode || (async () => null)
  });
  return { document, cam, stream, track, get stopped() { return stopped; }, resolveMedia: () => pendingGet && pendingGet(stream) };
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

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

test('持续无命中给出可见提示而不是静默', async () => {
  const { document: d, cam } = setup({ intervalMs: 1, decode: async () => null });
  await cam.open({});
  await tick(80);
  assert.match(d.getElementById('scanCamStatus').textContent, /暂未识别/);
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
