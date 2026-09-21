'use strict';
/* P1-4 热修回归：真 QR 穿真 worker onmessage 协议 + 真 jsQR 解码（修前红 → 修后绿）。
 *
 * 背景：主线程 postMessage 的 image.data 是裸 ArrayBuffer（transfer 后 worker 收到
 * 也是 ArrayBuffer），worker 端旧适配条件对裸 ArrayBuffer 永不适配（ArrayBuffer.buffer
 * === undefined）→ jsQR/zxing 拿到 ArrayBuffer 索引不到 → 0 命中 → worker 回「成功但
 * 空」→ 主线程三级链永不被咨询 → 真机所有帧全 miss = 扫不出来。
 *
 * 本测试在 Node 里搭「假 worker 环境」真实执行 lib/scan-decode-worker.js 的 onmessage：
 *   global.importScripts = stub（真 require jsqr.min.js 挂到 global.jsQR）
 *   捕获 onmessage 赋值、postMessage 捕获回复
 * 用 qrcode 包生成真 QR RGBA 帧，data 分别传裸 ArrayBuffer / 偏移视图形状。
 * 修前：hits=[]（红）；修后：jsQR 真解出 text（绿）。
 */
const test = require('node:test'), assert = require('node:assert/strict');

/* 真 jsQR（UMD，Node 直接 require）。 */
const realJsQR = require('../jsqr.min.js');

/* 真 QR RGBA 帧生成（qrcode 包 → Uint8ClampedArray RGBA，6px/模块 + 4 模块静区）。
   29×29 单像素模块 jsQR 解不出（采样/反相尝试需要冗余），6px 实测稳解。 */
async function makeQrFrame(text) {
  const QRCode = require('qrcode');
  const matrix = await QRCode.create(text, { errorCorrectionLevel: 'M' });
  const mods = matrix.modules;
  const S = 6, Q = 4;
  const n = (mods.size + Q * 2) * S;
  const frame = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const mx = Math.floor(x / S) - Q, my = Math.floor(y / S) - Q;
      const black = mx >= 0 && my >= 0 && mx < mods.size && my < mods.size && mods.data[my * mods.size + mx];
      const i = (y * n + x) * 4;
      frame[i] = frame[i + 1] = frame[i + 2] = black ? 0 : 255;
      frame[i + 3] = 255;
    }
  }
  return { width: n, height: n, data: frame };
}

/* 假 worker 环境：真实执行 lib/scan-decode-worker.js 的 onmessage。 */
function runWorkerOnMessage(imagePayload) {
  const replies = [];
  const g = globalThis;
  const savedImportScripts = g.importScripts;
  const savedPostMessage = g.postMessage;
  const savedOnmessageDesc = Object.getOwnPropertyDescriptor(g, 'onmessage');
  const savedJsQR = g.jsQR, savedZXing = g.ZXingWASM;
  /* importScripts stub：真 jsQR 挂上；zxing-wasm 模拟缺失（Node 无 wasm）。 */
  g.importScripts = url => {
    if (/jsqr/.test(url)) g.jsQR = realJsQR;
    else if (/zxing-wasm/.test(url)) g.ZXingWASM = undefined;
    else throw new Error('unexpected importScripts: ' + url);
  };
  g.postMessage = msg => replies.push(msg);
  let onmessageHandler = null;
  Object.defineProperty(g, 'onmessage', {
    get: () => onmessageHandler,
    set: fn => { onmessageHandler = fn; },
    configurable: true
  });
  try {
    delete require.cache[require.resolve('../lib/scan-decode-worker.js')];
    require('../lib/scan-decode-worker.js');
    assert.equal(typeof onmessageHandler, 'function', 'worker 脚本应注册 onmessage');
    return Promise.resolve(onmessageHandler({ data: imagePayload })).then(() => ({ replies }));
  } finally {
    if (savedImportScripts === undefined) delete g.importScripts; else g.importScripts = savedImportScripts;
    if (savedPostMessage === undefined) delete g.postMessage; else g.postMessage = savedPostMessage;
    if (savedOnmessageDesc) Object.defineProperty(g, 'onmessage', savedOnmessageDesc); else delete g.onmessage;
    if (savedJsQR === undefined) delete g.jsQR; else g.jsQR = savedJsQR;
    if (savedZXing === undefined) delete g.ZXingWASM; else g.ZXingWASM = savedZXing;
  }
}

test('P1-4 热修回归(a)：真 QR 帧 data=裸 ArrayBuffer（transfer 形状）→ jsQR 真解码命中', async () => {
  const frame = await makeQrFrame('SCAN-SELFTEST-123');
  /* 精确模拟主线程 transfer：payload.image.data = 裸 ArrayBuffer。 */
  const payload = { id: 1, image: { width: frame.width, height: frame.height, data: frame.data.buffer } };
  const { replies } = await runWorkerOnMessage(payload);
  assert.equal(replies.length, 1, 'worker 应回一条消息');
  assert.ok(!replies[0].error, 'worker 不得回 error，实测 ' + replies[0].error);
  assert.ok(replies[0].hits && replies[0].hits.length >= 1,
    '修后 jsQR 应真解出 QR（修前裸 ArrayBuffer 适配失败 → hits=[] 即生产事故），实测 hits=' + JSON.stringify(replies[0].hits));
  assert.equal(replies[0].hits[0].text, 'SCAN-SELFTEST-123');
});

test('P1-4 热修回归(b)：偏移视图形状（buffer+byteOffset/byteLength）→ 同样命中', async () => {
  const frame = await makeQrFrame('SCAN-SELFTEST-123');
  const big = new ArrayBuffer(frame.data.buffer.byteLength + 64);
  const view = new Uint8ClampedArray(big, 32, frame.data.length);
  view.set(frame.data);
  const payload = { id: 2, image: { width: frame.width, height: frame.height, data: big, byteOffset: 32, byteLength: frame.data.length } };
  const { replies } = await runWorkerOnMessage(payload);
  assert.equal(replies.length, 1);
  assert.ok(!replies[0].error, '偏移视图形状不得 error，实测 ' + replies[0].error);
  assert.ok(replies[0].hits && replies[0].hits.length >= 1,
    '偏移视图形状应解出 QR，实测 hits=' + JSON.stringify(replies[0].hits));
});

/* (c)(d) 自检与发出形状：需要 scan-camera 的桥，放 scan-camera.test.js 的 setupWorker
   模式这里复刻一份轻量版（避免跨文件依赖）。 */
const fs2 = require('node:fs'), path2 = require('node:path');
const { parseHTML } = require('linkedom');
const ScanCamera2 = require('../lib/scan-camera');

function setupWorker2(opts = {}) {
  const html = fs2.readFileSync(path2.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = parseHTML(html);
  const video = document.getElementById('scanCamVideo');
  video.videoWidth = 640; video.videoHeight = 480;
  video.play = async () => {};
  const track = { stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const instances = [];
  class FakeWorker {
    constructor(url) {
      this.url = url; this.posted = []; this.transfers = []; this.terminated = false;
      this.onmessage = null; this.onerror = null;
      instances.push(this);
    }
    postMessage(payload, transfer) {
      this.posted.push(payload); this.transfers.push(transfer);
      const msg = typeof opts.reply === 'function' ? opts.reply(payload) : opts.reply;
      if (msg) setTimeout(() => {
        if (this.terminated) return;
        this.onmessage && this.onmessage({ data: msg });
      }, opts.asyncReplyMs || 1);
    }
    terminate() { this.terminated = true; }
  }
  const win = Object.assign({}, document.defaultView, { Worker: FakeWorker });
  if (opts.winExtra) Object.assign(win, opts.winExtra);
  const cam = ScanCamera2.attach({
    document, win,
    mediaDevices: { getUserMedia: async () => stream },
    intervalMs: 2, legacyLoop: true,
    capture: () => ({ width: 640, height: 480, data: new Uint8ClampedArray(4) })
  });
  return { document, cam, win, instances };
}

test('P1-4 热修(c)：自检失败（worker 对自检回 0 命中）→ bridge dead，后续走主线程链', async () => {
  /* 假 ZXing：QRCodeWriter.encode 返回 21×21 全白 BitMatrix（自检帧无码 → worker 回
     0 命中 → 自检失败 → dead → 回退主线程链）。 */
  const fakeZXing = {
    BarcodeFormat: { QR_CODE: 11 },
    QRCodeWriter: function () {
      return { encode: () => ({ width: 21, height: 21, get: () => false }) };
    }
  };
  const { document: d, cam, instances } = setupWorker2({
    reply: p => ({ id: p.id, hits: [] }),   // 一切请求都回 0 命中 → 自检必失败
    winExtra: { jsQR: () => ({ data: 'LOC:MAIN' }), ZXing: fakeZXing }
  });
  await cam.open({});
  /* 等自检完成（2s 内自检 decodeAll 回 [] → dead）。 */
  await new Promise(r => setTimeout(r, 100));
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000),
    '自检失败后应回退主线程链出卡');
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:MAIN');
  cam.close('test');
});

test('P1-4 热修(c2)：自检通过（worker 回命中）→ worker 路径正常出卡', async () => {
  const { document: d, cam } = setupWorker2({
    reply: p => ({ id: p.id, hits: [{ text: 'LOC:W-OK', format: '二维码' }] })
  });
  await cam.open({});
  assert.ok(await waitFor(() => !d.getElementById('scanCamConfirm').hidden, 3000),
    '自检通过后 worker 路径应正常出卡');
  assert.equal(d.getElementById('scanCamValue').textContent, 'LOC:W-OK');
  cam.close('test');
});

test('P1-4 热修(d)：主线程 postMessage payload 形状 —— data 是 ArrayBuffer 且 transfer 对齐', async () => {
  const { cam, instances } = setupWorker2({
    reply: p => ({ id: p.id, hits: [{ text: 'X', format: '二维码' }] })
  });
  await cam.open({});
  await new Promise(r => setTimeout(r, 100));
  const w = instances[0];
  assert.ok(w && w.posted.length >= 1, '应有 postMessage 发出');
  const payload = w.posted[0];
  assert.equal(typeof payload.id, 'number', '协议应带数字 id');
  assert.ok(payload.image.data instanceof ArrayBuffer,
    '主线程发出的 image.data 必须是 ArrayBuffer（transferable 形状，worker 端适配对齐），实测 ' + Object.prototype.toString.call(payload.image.data));
  assert.ok(w.transfers[0] && w.transfers[0][0] === payload.image.data,
    'transfer 列表应含同一 buffer（零拷贝转移）');
  cam.close('test');
});

async function waitFor(fn, timeoutMs, stepMs) {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return true; } catch (_) {}
    if (Date.now() - t0 > (timeoutMs || 2000)) return false;
    await new Promise(r => setTimeout(r, stepMs || 20));
  }
}
