/* scan-camera.js — 统一扫码浮层（查询/作业/后续扫码工作台共用，UMD 双端）
 *
 * 解决的问题（用户实测反馈）：
 *   · ITM 页把 <video> 直接嵌在页面下方，体验差；现统一为全屏浮层（复用扫码工作台
 *     cam-overlay 的视觉/焦点/ESC/错误常驻模式）。
 *   · 扫到码直接执行 —— 现统一弹确认卡：显示码制/码值/对象摘要，点「确定填入」才回调。
 *   · 每帧解码失败被静默吞掉 —— 现有「正在识别 / 暂未识别」可见状态。
 *
 * P0（摄像头扫码算法优化方案 §4）：
 *   · P0-1 帧管线：双常驻离屏 canvas，快路径 frameScale（默认 0.5）降采样 960×540，
 *     慢路径每 fullFrameEvery（默认 4）帧全帧兜小码；opts.pipeline='legacy' 回退；
 *     opts.capture 注入时跳过整个内置管线。
 *   · P0-2 帧驱动：requestVideoFrameCallback 优先（同帧不重解、decode 在途跳帧），
 *     回退 setTimeout；opts.legacyLoop=true 强制旧循环；回调 try/catch 兜底。
 *   · P0-3 相机能力探测：focusMode continuous 请求（二重校验+getSettings 回读）、
 *     zoom 记录、torch 不默认开（miss≥24 帧且环境偏暗给「打开照明」按钮）、
 *     miss≥6/≥18 分级引导文案；全失败静默零 console 错误；会话中不改分辨率。
 *   · P0-4 埋点：perf 累计 captureMs/decodeMs/missCount/hitCount/engineName/firstHitMs，
 *     close() 挂 window.__scanPerf 调试口，不外发。
 *
 * P1（多码识别与选码交互）：
 *   · P1-1 多码检测层：defaultDecode 升级为消费 decodeAll（首个结果即 decode 兼容
 *     语义）；引擎链 BarcodeDetector → zxing-wasm → jsQR+ItemBarcode（lib/scan-engine.js，
 *     上一级抛错自动降级并记 engineName）；opts.decodeAll 注入点 + opts.multiEngine
 *     ('on' 默认 / 'off' 回退纯第 3 级)；首次 open() 后台预热 zxing-wasm，未就绪不阻塞。
 *   · P1-2 候选优先级 + 多帧投票：score = 2×跨帧出现次数 + (1−中心归一化距离) +
 *     0.5×面积占比；同 text 最近 3 帧窗口出现 ≥ voteThreshold（默认 2）才进候选
 *     （单帧孤证不弹卡，=1 即 P0 现状语义）；候选按 score 降序，首选自动选最高；
 *     describe ok:false 的码仍进候选但排后并禁用其「确定」。
 *   · P1-3 框选重扫：多码候选 ≥2 或连续 miss ≥12 帧时显示入口；点预览区域 → 以该点
 *     为中心 crop 1/4 视野放大 720×720 → 只喂解码引擎重试；track 支持 zoom 时同步
 *     applyConstraints({advanced:[{zoom: min(max, 2×当前)}]})（三态全 try/catch 静默）。
 *
 * 依赖全部可注入（window/jsQR/ItemBarcode/mediaDevices/ScanEngine 由调用方给），Node 端用
 * linkedom + 假媒体流可完整单测。业务协议（accept/queryScan/token）不变。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    try { module.exports = factory(require('./scan-engine')); }
    catch (_) { module.exports = factory(null); }
  }
  else root.ScanCamera = factory(root.ScanEngine || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ScanEngine) {
  'use strict';

  /* P1-1：默认 decode 消费 decodeAll（首个结果即旧单结果语义）。 */
  function defaultDecode(win, decodeAll) {
    const all = decodeAll || defaultDecodeAll(win);
    return async function decode(image) {
      const hits = await all(image);
      return (hits && hits.length) ? hits[0] : null;
    };
  }

  /* 无 ScanEngine 时的最小 decodeAll（纯第 3 级，与 P0 行为一致）。 */
  function defaultDecodeAll(win) {
    return async function decodeAll(image) {
      const out = [];
      if (!image || !image.width) return out;
      if (win.jsQR) {
        try {
          const qr = win.jsQR(image.data, image.width, image.height);
          if (qr && qr.data) out.push({ text: qr.data, format: '二维码' });
        } catch (_) { /* 本帧无二维码 */ }
      }
      if (win.ItemBarcode && win.ItemBarcode.frame) {
        try {
          const r = await win.ItemBarcode.frame(image);
          const text = r && (typeof r === 'string' ? r : r.text);
          if (text) out.push({ text, format: (typeof r === 'object' && r.format) || '条形码' });
        } catch (_) { /* 本帧无一维码 */ }
      }
      return out;
    };
  }

  function attach(opts) {
    const doc = opts.document, win = opts.win || (doc && doc.defaultView) || {};
    const el = id => doc.getElementById(id);
    const overlay = el('scanCamOverlay'), video = el('scanCamVideo'), hint = el('scanCamHint');
    const err = el('scanCamErr'), confirmBox = el('scanCamConfirm');
    const confirmValue = el('scanCamValue'), confirmMeta = el('scanCamMeta');
    const statusEl = el('scanCamStatus');
    /* 项 2（2.93）：诊断行 —— 常驻弱化小字，每 ~500ms 刷新引擎/解码ms/档位/命中数。
       节点缺失（旧 index.html）静默不显示；opts.debugHud===false 可关。 */
    const hudEl = el('scanCamHud');
    const hudOn = hudEl && opts.debugHud !== false;
    const btnYes = el('scanCamYes'), btnRetry = el('scanCamRetry'), btnClose = el('scanCamClose');
    const candidatesEl = el('scanCamCandidates');
    const cropBtn = el('scanCamCrop');
    if (!overlay || !video) throw new Error('scan-camera：页面缺少 scanCam* 浮层结构');

    /* P0-1 帧管线：两个常驻离屏 canvas（快/慢各一，尺寸变化时才写入）。 */
    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext && canvas.getContext('2d', { willReadFrequently: true });
    const fullCanvas = doc.createElement('canvas');
    const fullCtx = fullCanvas.getContext && fullCanvas.getContext('2d', { willReadFrequently: true });
    /* P1-3：框选重扫专用 canvas（crop → 720×720）。 */
    const cropCanvas = doc.createElement('canvas');
    const cropCtx = cropCanvas.getContext && cropCanvas.getContext('2d', { willReadFrequently: true });
    const intervalMs = opts.intervalMs == null ? 250 : opts.intervalMs;
    const pipeline = opts.pipeline === 'legacy' ? 'legacy' : 'fast';
    const baseFrameScale = opts.frameScale > 0 && opts.frameScale <= 1 ? opts.frameScale : 0.5;
    /* 项 2（2.99）：miss 自动升清 —— 原生连续 miss ≥10 帧临时 0.5→0.67（约 1280×720），
       hit 或 miss 清零后降回 base；perf.tier 如实显示。 */
    let frameScale = baseFrameScale;
    let frameBoosted = false;
    const fullFrameEvery = opts.fullFrameEvery >= 1 ? Math.floor(opts.fullFrameEvery) : 4;
    const legacyLoop = !!opts.legacyLoop;
    /* P1-2：多帧投票阈值（默认 2；=1 即 P0 现状语义：单帧即弹卡）。
       项 2a：按码制分级 —— 二维码 Reed-Solomon 误读率≈0 → 默认单帧即弹（省一帧延迟）；
       一维码校验弱 → 保持 2 帧。opts.voteThreshold 仍作一维码阈值，voteThresholdQR
       作二维码阈值。 */
    const voteThreshold = opts.voteThreshold >= 1 ? Math.floor(opts.voteThreshold) : 2;
    const voteThresholdQR = opts.voteThresholdQR >= 1 ? Math.floor(opts.voteThresholdQR) : 1;
    /* P1-2：投票窗口（帧数）。 */
    const voteWindow = opts.voteWindow >= 2 ? Math.floor(opts.voteWindow) : 3;

    /* P1-1：引擎链。opts.decodeAll 注入（测试假引擎）> opts.decode 单结果注入（P0 兼容）
       > ScanEngine.createChain > 内置纯第 3 级。opts.decode 注入时完全等价 P0 行为。 */
    let chain = null;
    if (opts.decodeAll) {
      chain = { decodeAll: opts.decodeAll, warmUp: async () => false, engineName: () => 'injected' };
    } else if (opts.decode) {
      const single = opts.decode;
      chain = {
        decodeAll: async image => { const h = await single(image); return h && h.text ? [h] : []; },
        warmUp: async () => false,
        engineName: () => 'injected'
      };
    } else if (ScanEngine && typeof ScanEngine.createChain === 'function') {
      chain = ScanEngine.createChain({
        win, document: doc,
        multiEngine: opts.multiEngine,
        onEngineName: n => { perf.engineName = n; }
      });
    } else {
      chain = { decodeAll: defaultDecodeAll(win), warmUp: async () => false, engineName: () => 'jsQR+ItemBarcode' }
    }

    /* P1-4：Worker 桥。win.Worker 可用且 opts.worker!==false 且未注入 decode/decodeAll
       时，decode 全部转发 worker（transferable），主线程只做取帧。worker 构造失败 /
       回 error / 单帧 decode 超时（>2s）→ 回退主线程引擎链（chain 原样保留）；
       close() 必须 terminate() 防泄漏（pagehide 也走 close）。桥是会话级：
       close() 销毁，下次 open() 重建（worker 无状态，重建 = 一次 importScripts）。 */
    let workerBridge = null;
    let scanOpened = false;   // 2.96：真正进入取流才置位，close 据此决定是否归零 stage
    /* 项 2 v3（2.97）：浏览器崩溃自愈 —— 三态阶段计数，标记迁 localStorage。
       sessionStorage 在某些 WebView 进程被杀死时随会话丢失（百度浏览器实证：
       每次进来 stage=0 继续崩）；localStorage 同步写入即持久，进程死亡也保住。
       attach 时读 stage=parseInt(localStorage['mes.scanStage']||'0')；
       open() 通过拦截检查后、取流/worker 构造之前立即写 stage+1。
       分级：stage=0 全功能；stage=1 兼容模式（禁 worker/wasm）；
       stage≥2 不调 getUserMedia、不构造 worker，引导文案 + 「仍要尝试」脱困。
       clean close() 归零；stage≥2 拦截路径不归零（防崩溃循环）。
       旧 key 双清理：localStorage/sessionStorage 里的 mes.scanActive 与
       sessionStorage 里的 mes.scanStage（v2.96 及更早的遗留）一并删除。
       localStorage 抛错（隐私模式）→ 整体静默跳过。 */
    let scanStage = 0;
    let scanGuardOk = false;
    try {
      const ls = win.localStorage;
      if (ls) {
        scanGuardOk = true;
        /* 旧 key 迁移清理（一次性）。 */
        try { ls.removeItem('mes.scanActive'); } catch (_) {}
        try { if (win.sessionStorage) {
          win.sessionStorage.removeItem('mes.scanActive');
          win.sessionStorage.removeItem('mes.scanStage');   // v2.96 遗留
        } } catch (_) {}
        scanStage = parseInt(ls.getItem('mes.scanStage') || '0', 10) || 0;
      }
    } catch (_) { scanGuardOk = false; scanStage = 0; }
    let compatMode = scanStage === 1;   // stage=1：兼容模式（禁 worker），retry 可复位
    function markScanStage() {
      /* open() 通过拦截后、取流前调用：读旧值+1 立即写回（崩溃也拦不住）。 */
      if (!scanGuardOk) return;
      try {
        const cur = parseInt(win.localStorage.getItem('mes.scanStage') || '0', 10) || 0;
        win.localStorage.setItem('mes.scanStage', String(cur + 1));
      } catch (_) {}
    }
    function clearScanStage() {
      if (!scanGuardOk) return;
      try { win.localStorage.removeItem('mes.scanStage'); } catch (_) {}
    }

    function makeWorkerBridge() {
      if (workerBridge) return workerBridge;
      if (compatMode) return null;   // 2.96：stage=1 兼容模式禁用 worker（崩溃自愈）
      if (opts.worker === false) return null;
      if (opts.decode || opts.decodeAll) return null;   // 注入优先，不走 worker
      if (typeof win.Worker !== 'function') return null;
      let w;
      try {
        const base = (doc.baseURI || (win.location && win.location.href) || '').split('?')[0].replace(/[^/]*$/, '');
        w = new win.Worker(base + 'lib/scan-decode-worker.js');
      } catch (_) { return null; }
      let dead = false;
      let nextId = 1;
      const pending = new Map();
      w.onmessage = ev => {
        const m = ev && ev.data;
        if (!m || typeof m.id !== 'number') return;
        const p = pending.get(m.id);
        if (!p) return;   // 迟到/未知 id 丢弃
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error('worker: ' + m.error));
        else p.resolve(m.hits || []);
      };
      w.onerror = () => {
        dead = true;
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('worker onerror')); }
        pending.clear();
        try { w.terminate(); } catch (_) {}
      };
      workerBridge = {
        decodeAll(image) {
          if (dead) return Promise.reject(new Error('worker dead'));
          return new Promise((resolve, reject) => {
            const id = nextId++;
            /* 修 D：直接 transfer image.data.buffer（getImageData 已是独立副本，不再
               slice 二次复制）。发送后 image.data 即 detached（length 0）——回退分支
               由 decodeAllVia 负责重新取帧，不得把 detached image 传给主线程链。 */
            const buf = image.data.buffer;
            const payload = { id, image: { width: image.width, height: image.height, data: buf } };
            const timer = setTimeout(() => {
              pending.delete(id);
              dead = true;   // 超时视为 worker 失效，回退主线程链
              reject(new Error('worker decode timeout'));
            }, 2000);
            pending.set(id, { resolve, reject, timer });
            try { w.postMessage(payload, [buf]); }
            catch (e) {
              clearTimeout(timer); pending.delete(id);
              dead = true;
              reject(e);
            }
          });
        },
        /* P1-4 热修自检：用主线程 ZXing.QRCodeWriter 编码固定文本 → RGBA 帧 → 走同一
           bridge.decodeAll 发 worker。命中 ≥1 = 通过；0 命中 / error / 2s 超时 = dead
           永久回退主线程链（用户最多损失 worker 加速，绝不损失可用性）。 */
        async selfTest() {
          if (dead) return false;
          try {
            const ZX = win.ZXing;
            if (!ZX || typeof ZX.QRCodeWriter !== 'function') return true;   // 无 ZXing 跳过（不阻断）
            const writer = new ZX.QRCodeWriter();
            const hints = typeof Map === 'function' ? new Map() : undefined;
            const matrix = hints ? writer.encode('SCAN-SELFTEST', ZX.BarcodeFormat.QR_CODE, 21, 21, hints)
                                 : writer.encode('SCAN-SELFTEST', ZX.BarcodeFormat.QR_CODE, 21, 21);
            const mw = matrix.width, mh = matrix.height;
            const S = 4, Q = 4;
            const n = (mw + Q * 2) * S;
            const rgba = new Uint8ClampedArray(n * n * 4);
            for (let y = 0; y < n; y++) {
              for (let x = 0; x < n; x++) {
                const mx = Math.floor(x / S) - Q, my = Math.floor(y / S) - Q;
                const black = mx >= 0 && my >= 0 && mx < mw && my < mh && !!matrix.get(mx, my);
                const i = (y * n + x) * 4;
                rgba[i] = rgba[i + 1] = rgba[i + 2] = black ? 0 : 255;
                rgba[i + 3] = 255;
              }
            }
            const hits = await workerBridge.decodeAll({ width: n, height: n, data: rgba });
            if (dead || !hits || !hits.length) { dead = true; return false; }
            return true;
          } catch (_) { dead = true; return false; }
        },
        terminate() {
          dead = true;
          for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('terminated')); }
          pending.clear();
          try { w.terminate(); } catch (_) {}
        },
        alive: () => !dead
      };
      return workerBridge;
    }

    /* 项 1（2.93）：原生 BarcodeDetector 第 1 级 —— 主线程硬件加速 ~10-30ms。
       detect(canvas) 直接吃 CanvasImageSource，免 getImageData 回读。
       抛错/超时（>500ms）一次 → nativeDead 本会话永久走 worker（不反复探测）。
       项 1（2.97）：双实例 —— 快车道 QR-only（formats:['qr_code']，每帧 detect
       显著提速，本系统 95% 是二维码）；慢车道独立实例保留 13 码制全量
       （一维码兜底靠慢车道 + 一维码引擎）。 */
    const FAST_FORMATS = ['qr_code'];
    const SLOW_FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upca', 'upce', 'code_93', 'codabar', 'itf', 'datamatrix', 'pdf417', 'aztec'];
    let nativeDead = false;
    let videoFeedFails = 0;   // 项 3（2.99）：直喂 video 连续抛错计数
    let nativeDetectorFast = null;   // 快车道：QR-only
    let nativeDetectorSlow = null;   // 慢车道：全量码制
    function nativeFormats(kind) {
      /* getSupportedFormats 交集校验：按各自码制清单过滤。 */
      try {
        const supported = win.BarcodeDetector.getSupportedFormats() || [];
        const want = kind === 'fast' ? FAST_FORMATS : SLOW_FORMATS;
        const have = want.filter(f => supported.indexOf(f) >= 0);
        return have.length ? have : null;
      } catch (_) { return null; }
    }
    function nativeAvailable() {
      return !nativeDead && typeof win.BarcodeDetector === 'function' &&
        !!win.BarcodeDetector.getSupportedFormats;
    }
    function getNativeDetector(kind) {
      if (!nativeAvailable()) return null;
      if (kind === 'fast') {
        if (!nativeDetectorFast) {
          const fmts = nativeFormats('fast');
          if (!fmts) { nativeDead = true; return null; }
          try { nativeDetectorFast = new win.BarcodeDetector({ formats: fmts }); }
          catch (_) { nativeDead = true; return null; }
        }
        return nativeDetectorFast;
      }
      if (!nativeDetectorSlow) {
        const fmts = nativeFormats('slow');
        if (!fmts) { nativeDead = true; return null; }
        try { nativeDetectorSlow = new win.BarcodeDetector({ formats: fmts }); }
        catch (_) { nativeDead = true; return null; }
      }
      return nativeDetectorSlow;
    }
    async function nativeDecode(source, kind) {
      const detector = getNativeDetector(kind || 'fast');
      if (!detector) return null;   // null = 原生不可用，调用方走 worker
      const t0 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      try {
        const results = await detector.detect(source);
        const t1 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        if (t1 - t0 > 500) { nativeDead = true; return null; }   // 超时视为不可用
        perf.engineName = 'BarcodeDetector';
        if (!Array.isArray(results)) return [];
        if (results.length) perf.nativeHit++;
        return results.map(r => ({
          text: String(r.rawValue != null ? r.rawValue : ''),
          format: r.format === 'qr_code' ? '二维码' : (r.format || '条码'),
          box: r.boundingBox ? { x: r.boundingBox.x, y: r.boundingBox.y, w: r.boundingBox.width, h: r.boundingBox.height } : undefined
        })).filter(r => r.text);
      } catch (_) {
        /* 项 3（2.99）：直喂 video 抛错按次记录，连续 3 次 → nativeDead。 */
        videoFeedFails++;
        if (videoFeedFails >= 3 || kind !== 'fast') nativeDead = true;
        return null;
      }
    }

    /* P1-4：统一 decodeAll 入口 —— 项 1（2.93）三级顺序：
       第 1 级原生 BarcodeDetector（detect(canvas)，命中即返回，免回读）→
       miss/不可用 → 第 2/3 级 worker（zxing-wasm+jsQR，需 image getImageData）→
       worker 死 → 主线程链 2/3 级兜底（重新取帧，绝不传 detached）。
       frame = {canvas, image, isSlow}；image 为 null 表示原生可用时未回读，
       需要喂 worker 时才补 getImageData。 */
    /* 项 3（2.99）：直喂 video 时 wasm 兜底需要 image —— 才 drawImage+getImageData
       （快通道不再每帧画 canvas，省 5-10ms）。 */
    function buildFastImage() {
      if (!ctx || !video.videoWidth) return null;
      const vw = video.videoWidth, vh = video.videoHeight;
      const fw = Math.max(1, Math.round(vw * frameScale));
      const fh = Math.max(1, Math.round(vh * frameScale));
      if (canvas.width !== fw) canvas.width = fw;
      if (canvas.height !== fh) canvas.height = fh;
      ctx.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh);
      try { return ctx.getImageData(0, 0, fw, fh); } catch (_) { return null; }
    }

    /* 项 1（2.94）：wasm 兜底车道 —— 原生 miss 时 fire-and-forget 发 worker，
       不 await（帧流程当场结束）；250ms 节流 + 在途去重（不排队）。
       结果异步到达 → 校验 generation/stream/awaiting → 照常 absorbHits。
       原生不可用（nativeDead/无 BarcodeDetector）时不启用：worker 是唯一引擎，
       保持每帧串行现状语义（由 decodeAllVia 的 await 路径承担）。 */
    let wasmInFlight = false;
    let lastWasmStart = 0;
    function maybeWasmFallback(frame, captured, imgW, imgH, myGen) {
      if (nativeAvailable()) return;   // 原生活着：wasm 只是兜底，原生 miss 才发
      if (wasmInFlight) return;        // 在途不排队
      const now = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      if (lastWasmStart && now - lastWasmStart < 250) return;   // 250ms 节流
      let img = frame.image;
      if (!img && frame.canvas) {
        try {
          img = frame.canvas.getContext('2d').getImageData(0, 0, frame.canvas.width, frame.canvas.height);
        } catch (_) { img = null; }
      }
      /* 项 3（2.99）：直喂 video 无 canvas —— 按需补画（尺寸随快通道 frameScale）。 */
      if (!img && frame.lazyImage) img = frame.lazyImage();
      if (!img) return;
      const bridge = makeWorkerBridge();
      if (!bridge || !bridge.alive()) return;
      lastWasmStart = now;
      wasmInFlight = true;
      bridge.decodeAll(img).then(hits => {
        wasmInFlight = false;
        if (myGen !== generation || !stream) return;   // 迟到/已关闭丢弃
        if (awaiting) return;                          // 已在确认卡，丢弃兜底结果
        if (hits && hits.length) {
          perf.workerHit++;
          perf.engineName = 'worker(zxing/jsQR)';
          resetMisses();
          absorbHits(hits, captured, imgW, imgH);
          updateCropEntry();
        }
      }).catch(() => { wasmInFlight = false; });
    }

    /* P1-4：统一 decodeAll 入口 —— 慢车道/回退用（await 全链：原生→worker→主链）。
       快车道 processFrame 不走这里（原生 await + maybeWasmFallback 分级）。 */
    async function decodeAllVia(frame) {
      const canvas = frame.canvas, image = frame.image;
      /* 第 1 级：原生。命中即返回；miss（[]）→ 落到 worker（zxing 可能仍能解）。 */
      if (canvas && nativeAvailable()) {
        const hits = await nativeDecode(canvas, 'slow');
        if (hits !== null && hits.length) return hits;
        /* nativeDead 刚被置位或 miss → 落到 worker。 */
      }
      /* 第 2/3 级：worker。 */
      let img = image;
      if (!img && canvas) {
        try {
          const w = canvas.width, h = canvas.height;
          img = canvas.getContext('2d').getImageData(0, 0, w, h);
        } catch (_) { img = null; }
      }
      if (!img) return null;
      const bridge = makeWorkerBridge();
      if (bridge && bridge.alive()) {
        try {
          const hits = await bridge.decodeAll(img);
          perf.engineName = 'worker(zxing/jsQR)';
          if (hits && hits.length) perf.workerHit++;
          return hits;
        } catch (_) { /* 永久回退主线程链（用新帧） */ }
        const fresh0 = captureFrame();
        if (!fresh0) return null;
        return chain.decodeAll(fresh0.image || (fresh0.canvas && fresh0.canvas.getContext('2d').getImageData(0, 0, fresh0.canvas.width, fresh0.canvas.height)));
      }
      return chain.decodeAll(img);
    }
    const decode = defaultDecode(win, async frame => {
      const r = await decodeAllVia(frame);
      return r;
    });

    let stream = null, timer = null, generation = 0, current = null, awaiting = false;
    let misses = 0, missNotified = false;
    /* 项 2（3.0）：定向提示 —— 连续 3 个不同 text 的候选被 describe 判 ok:false
       → status 显示 describe.action（有）或通用文案。任一 ok:true 或 close/重扫清零。 */
    let badCandTexts = [];
    let badCandNotified = false;
    let badCandAction = '';
    function resetBadCands() { badCandTexts = []; badCandNotified = false; badCandAction = ''; }
    function noteCandidateDescribe(text) {
      if (badCandNotified) return;
      const e = seen.get(text);
      if (!e || !e.eligible) return;
      const d = describeOf(e.hit);
      if (d.ok) { resetBadCands(); return; }   // 任一 ok:true 清零
      if (badCandTexts.indexOf(text) >= 0) return;   // 同 text 重复只算 1 次
      badCandTexts.push(text);
      if (badCandTexts.length >= 3) {
        badCandNotified = true;
        badCandAction = d.action || '';
        setStatus(badCandAction || '当前步骤需要其他类型的码，请核对后扫描');
      }
    }
    let guideLevel = 0;
    let torchOffered = false;
    let lumaAvg = 255;
    let camCaps = null;
    let rafId = 0;
    let decoding = false;
    let lastPresented = null;
    let frameNo = 0;
    let skipFastDraw = false;   // 项 3（2.99）：原生快帧免 drawImage
    /* P1-2：会话帧序号（投票窗口用）。 */
    let frameSeq = 0;
    /* P1-3：框选重扫在途标志（防连点）。 */
    let cropBusy = false;
    /* 项 1：自适应自动变焦状态 —— lastZoomAt 防拉锯（800ms 内不再变）。 */
    let lastZoomAt = 0;
    let zoomHintShown = false;
    const perf = { captureMs: 0, decodeMs: 0, missCount: 0, hitCount: 0, engineName: 'jsQR+ItemBarcode', firstHitMs: 0, nativeHit: 0, workerHit: 0, tier: '540p' };
    /* 项 2（2.93）：诊断行 —— 最近一帧解码耗时（HUD 用）。 */
    let lastDecodeMs = 0;
    let openAt = 0;
    /* P1-2：seen 值结构扩展 —— {hit, count, frames[], box, score, eligible}。
       候选 = eligible（投票通过）的项；确认卡候选按钮按 score 降序。 */
    let seen = new Map(), selectedText = '', selectedToken = undefined;
    let lastDetected = null;

    function showErr(msg) {
      err.textContent = msg; err.hidden = false;
      if (win.requestAnimationFrame) win.requestAnimationFrame(() => btnClose.focus());
      else btnClose.focus();
    }
    function clearErr() { err.hidden = true; err.textContent = ''; }
    function setStatus(text) { statusEl.textContent = text; }

    function stopStream() {
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null; video.srcObject = null;
    }

    function publishPerf() {
      try {
        if (win && typeof win === 'object') win.__scanPerf = Object.assign({}, perf);
      } catch (_) { /* 调试口失败不影响功能 */ }
    }

    function close(reason) {
      generation++; clearTimeout(timer); timer = null;
      if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null; }
      pulseActive = false; pulseCount = 0;
      zscanStop(true);   // 项 1（3.1）：推近扫描中止并回 1×
      if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
      if (rafId && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(rafId); } catch (_) {} }
      rafId = 0; decoding = false; lastPresented = null; cropBusy = false;
      /* 项 2 v2（2.96）：真正 open 过的 clean close 才归零 stage；
         stage≥2 拦截路径（未真正 open）保持标记，防重新进入崩溃循环。 */
      if (scanOpened) clearScanStage();
      /* P1-4：收口必须 terminate worker，防泄漏（pagehide 也走 close）。 */
      if (workerBridge) { workerBridge.terminate(); workerBridge = null; }
      /* 项 1 收尾：zoom 重置回 1（在 stopStream 前，track 还活着）。 */
      resetZoom();
      const had = !!current; const wasConfirmed = reason === 'confirmed';
      const unconfirmed = wasConfirmed ? null : lastDetected;
      lastDetected = null;
      stopStream();
      overlay.style.display = 'none';
      confirmBox.hidden = true;
      publishPerf();
      const opts = current; current = null; awaiting = false; pendingReset();
      if (had && !wasConfirmed && opts && opts.onCancel) opts.onCancel(reason || 'closed', unconfirmed);
    }

    function pendingReset() {
      resetMisses(); torchOffered = false;
      resetBadCands();   // 项 2（3.0）：重扫/close 清零定向提示
      frameSeq = 0;
      seen = new Map(); selectedText = ''; selectedToken = undefined;
      lastRenderSig = '';   // 修 A：重扫后签名清零，强制重渲染
      lastProcessAt = 0;    // 修 B：重扫后节流清零，首帧立即处理
      lastZoomAt = 0; zoomHintShown = false;   // 项 1：变焦防拉锯/文案重置
    }

    /* P1-2：score = 2×跨帧出现次数 + (1−中心归一化距离) + 0.5×面积占比。
       无 box 时中心距离按 0.5（中性）、面积占比按 0 计。 */
    function scoreOf(entry, imgW, imgH) {
      const b = entry.box;
      let centerScore = 0.5, areaScore = 0;
      if (b && imgW && imgH) {
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const dx = (cx - imgW / 2) / (imgW / 2), dy = (cy - imgH / 2) / (imgH / 2);
        const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;   // 0(中心) ~ 1(角)
        centerScore = 1 - Math.min(1, Math.max(0, dist));
        areaScore = Math.min(1, (b.w * b.h) / (imgW * imgH)) * 4;   // 面积占比 ×4 封顶 1
      }
      return 2 * entry.count + centerScore + 0.5 * areaScore;
    }

    /* P1-2：describe 校验（排后 + 禁用确定用）。结果按 text 缓存在 entry 上——
       修 A：码停留画面时 describe 每帧被调是卡顿主犯之一；候选达标（fresh）时
       在 absorbHits 里主动刷新缓存。同会话内同一 text 的 describe 结果视为稳定
       （describeScanHit 是同步查找），状态翻转风险见遗留说明。 */
    function describeOf(hit) {
      const e = seen.get(hit.text);
      if (e && e._dOk !== undefined) return { ok: e._dOk, text: e._dText, action: e._dAction };
      const d = current.describe && current.describe(hit);
      const out = (typeof d === 'string') ? { ok: true, text: d }
        : (d && typeof d === 'object') ? { ok: d.ok !== false, text: d.text || '', action: d.action }
        : { ok: true, text: '' };
      if (e) { e._dOk = out.ok; e._dText = out.text; e._dAction = out.action; }
      return out;
    }
    function refreshDescribe(entry) {
      entry._dOk = undefined;
      describeOf(entry.hit);
    }

    /* P1-2：候选列表 = eligible 项，按 score 降序；describe ok:false 排后。 */
    function candidateList(imgW, imgH) {
      const arr = [];
      for (const [text, e] of seen) {
        if (!e.eligible) continue;
        const d = describeOf(e.hit);
        arr.push({ text, entry: e, score: scoreOf(e, imgW, imgH), ok: d.ok });
      }
      arr.sort((a, b2) => {
        if (a.ok !== b2.ok) return a.ok ? -1 : 1;          // describe 拒绝排后
        return b2.score - a.score;                          // score 降序
      });
      return arr;
    }

    /* 修 A：渲染签名 = 选中项 + 各候选 text + describe ok 标志。签名未变 → 跳过
       整个 renderConfirm（candidateList/describe/DOM 全跳）。码停留画面时每帧
       absorbHits→renderConfirm 但签名稳定 → 零 DOM 操作。 */
    let lastRenderSig = '';
    function renderConfirm(force) {
      const imgW = video.videoWidth || 0, imgH = video.videoHeight || 0;
      const cands = candidateList(imgW, imgH);
      const sig = selectedText + '|' + cands.map(c => c.text + ':' + (c.ok ? 1 : 0)).join(',');
      if (!force && sig === lastRenderSig) return;
      lastRenderSig = sig;
      const cur = seen.get(selectedText);
      if (!cur || !cur.eligible) {
        /* 首选自动选 score 最高者（仅在尚无选中或选中项失效时）。 */
        if (cands.length) { selectedText = cands[0].text; }
      }
      const hit = seen.get(selectedText);
      if (!hit) return;
      const d = describeOf(hit.hit);
      confirmValue.textContent = hit.hit.text;
      confirmMeta.textContent = hit.hit.format + ' · ' + d.text;
      btnYes.disabled = !d.ok;
      btnYes.textContent = d.ok ? '确定填入' : (d.action || '类型不符，请重扫');
      candidatesEl.replaceChildren();
      const candHint = el('scanCamCandidatesHint');
      if (cands.length > 1) {
        if (candHint) candHint.textContent = '画面里识别到多个码，点下面候选切换（已按优先级排序），一次只填入一个：';
        for (const c of cands) {
          if (c.text === selectedText) continue;
          const b = doc.createElement('button');
          b.type = 'button'; b.className = 'btn small ghost';
          b.textContent = '改选 ' + c.text + (c.ok ? '' : '（类型不符）');
          if (!c.ok) b.disabled = true;
          b.onclick = () => { selectedText = c.text; renderConfirm(); };
          candidatesEl.appendChild(b);
        }
      } else if (candHint) candHint.textContent = '';
      updateCropEntry();
    }

    /* P1-2：一帧多命中汇入。每个 hit 更新 seen（计票），达投票阈值的进候选。
       skipVote=true（P1-3 框选重扫）：用户显式点选区域，意图即投票，单帧命中直接进候选。 */
    function absorbHits(hits, captured, imgW, imgH, skipVote) {
      let fresh = false;
      for (const h of hits) {
        if (!h || !h.text) continue;
        lastDetected = h.text;
        let e = seen.get(h.text);
        if (!e) { e = { hit: h, count: 0, frames: [], box: h.box, eligible: false }; seen.set(h.text, e); }
        e.count++;
        e.frames.push(frameSeq);
        /* 窗口裁剪：丢掉间隔 ≥ voteWindow 的旧票（窗口外不计票）。 */
        while (e.frames.length && frameSeq - e.frames[0] >= voteWindow) e.frames.shift();
        if (h.box) e.box = h.box;
        e.hit = h;   // 保留最新 hit（format/box 可能更全）
        /* 投票：窗口内票数 ≥ 阈值才进候选（skipVote 时直接进）。
           项 2a：二维码阈值 voteThresholdQR（默认 1），一维码 voteThreshold（默认 2）。 */
        const thr = (h.format === '二维码') ? voteThresholdQR : voteThreshold;
        if (!e.eligible && (skipVote || e.frames.length >= thr)) {
          e.eligible = true;
          fresh = true;
          refreshDescribe(e);   // 修 A：候选达标时刷新 describe 缓存
          noteCandidateDescribe(h.text);   // 项 2（3.0）：定向提示计数
        }
      }
      if (fresh) {
        perf.hitCount++;
        if (!perf.firstHitMs) {
          perf.firstHitMs = ((win.performance && win.performance.now) ? win.performance.now() : Date.now()) - openAt;
        }
        if (!awaiting) {
          awaiting = true; selectedToken = captured;
          /* 首选自动选 score 最高。 */
          const cands = candidateList(imgW, imgH);
          if (cands.length) selectedText = cands[0].text;
          setStatus('已识别，请确认');
        } else setStatus('识别到多个码，请选择要填入的一个');
        /* 项 2（3.0）：定向提示优先于「已识别」——用户需要知道码型不对。 */
        if (badCandNotified) setStatus(badCandAction || '当前步骤需要其他类型的码，请核对后扫描');
        /* 项 1：小码自动变焦（近中心才变；边缘给文案盖在「已识别」之上）。 */
        maybeAutoZoom(hits, imgW, imgH);
        renderConfirm();
        confirmBox.hidden = false;
        wireConfirmButtons();
      } else if (awaiting) {
        /* 已在候选展示中：新达标的候选刷新列表。 */
        renderConfirm();
      }
    }

    function wireConfirmButtons() {
      btnYes.onclick = () => {
        const opts2 = current, text = selectedText, token = selectedToken, chosen = seen.get(selectedText);
        close('confirmed');
        if (opts2 && opts2.onConfirm && chosen) opts2.onConfirm(text, token, chosen.hit);
      };
      btnRetry.onclick = () => { confirmBox.hidden = true; awaiting = false; pendingReset(); setStatus('正在识别…'); updateCropEntry(); };
      if (!awaiting || seen.size === 1) btnYes.focus();
    }

    /* P0-3：miss 分级引导。 */
    function missGuide() {
      if (badCandNotified) return;   // 项 2（3.0）：定向提示优先，miss 引导不覆盖
      if (misses >= 18 && guideLevel < 2) {
        guideLevel = 2;
        setStatus('靠太近了，稍微拿远一点');
      } else if (misses >= 6 && guideLevel < 1) {
        guideLevel = 1;
        setStatus('请将码放入框内，保持 10~15cm');
      } else if (misses >= 12 && !missNotified) {
        missNotified = true;
        setStatus('暂未识别到码，请对准后稍等；支持二维码与常见一维条形码');
      }
    }

    function maybeOfferTorch() {
      if (torchOffered || misses < 24 || !camCaps || !camCaps.torch) return;
      if (lumaAvg >= 90) return;
      torchOffered = true;
      const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      if (!track) return;
      const b = doc.createElement('button');
      b.type = 'button'; b.className = 'btn small ghost';
      b.textContent = '💡 打开照明';
      b.onclick = () => {
        b.remove();
        try {
          const p = track.applyConstraints({ advanced: [{ torch: true }] });
          if (p && p.catch) p.catch(() => { try { setStatus('照明开启失败，请手动调亮环境光'); } catch (_) {} });
        } catch (_) { try { setStatus('照明开启失败，请手动调亮环境光'); } catch (__) {} }
      };
      statusEl.parentNode && statusEl.parentNode.insertBefore(b, statusEl.nextSibling);
    }

    /* 项 1：自适应自动变焦（微信式小码放大）。
       触发：hit 带 box 且 box 宽 < 画面宽 20%（小码）且 box 中心距画面中心归一化
       < 0.25（近中心——track.zoom 只向画面中心裁切，边缘变焦反而丢码）。
       变焦：factor = clamp(画面宽×0.35 / box宽, 1.5, zoom.max)，目标 = min(max,
       当前 × min(factor, 2.5))；800ms 防拉锯；三态 try/catch 静默。
       无 zoom 能力：box 宽 <8% 画面宽 → cropZoomRetake（穷版超分）。 */
    function maybeAutoZoom(hits, imgW, imgH) {
      if (!imgW || !imgH) return;
      const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      if (!track) return;
      const now = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      for (const h of hits) {
        if (!h || !h.box) continue;
        const bw = h.box.w, bh = h.box.h;
        if (!bw || !bh) continue;
        const cx = h.box.x + bw / 2, cy = h.box.y + bh / 2;
        const dx = (cx - imgW / 2) / (imgW / 2), dy = (cy - imgH / 2) / (imgH / 2);
        const centerDist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;   // 0~1
        const small = bw < imgW * 0.20;
        if (!small) continue;
        if (centerDist >= 0.25) {
          /* 边缘小码：变焦会丢码 → 一次性文案引导。 */
          if (!zoomHintShown) {
            zoomHintShown = true;
            setStatus('检测到小码，请把它移到画面中心');
          }
          continue;
        }
        if (camCaps && camCaps.zoom) {
          if (lastZoomAt && now - lastZoomAt < 800) continue;   // 防拉锯（首帧 lastZoomAt=0 放行）
          try {
            const cur = (track.getSettings && track.getSettings() && track.getSettings().zoom) || 1;
            const factor = Math.min(Math.max(imgW * 0.35 / bw, 1.5), camCaps.zoom.max);
            const z = Math.min(camCaps.zoom.max, cur * Math.min(factor, 2.5));
            if (z <= cur) continue;
            const p = track.applyConstraints({ advanced: [{ zoom: z }] });
            if (p && p.catch) p.catch(() => {});
            lastZoomAt = now;
            pulseYieldToAutoZoom();   // 项 1（2.99）：AutoZoom 抢占脉冲回退
          } catch (_) { /* 静默 */ }
        } else if (bw < imgW * 0.20) {
          /* 项 3（2.93）：阈值与变焦触发统一放宽到 20% —— 小码命中即 crop 放大重解。 */
          cropZoomRetake(h.box, imgW, imgH);
        }
      }
    }

    /* 项 1（2.99）：变焦脉冲对焦助推 —— 连续 miss 大概率没合焦，变焦约束变化
       会倒逼 Camera2 重新触发 AF 收敛（微信/支付宝同款思路）。
       触发：miss ≥12 且距 open ≥2s 且 zoom 能力存在 且非 awaiting 且无脉冲在途；
       动作：zoom 升到 min(max, cur+max(0.2,cur*0.15)) → 700ms 后回退原值；
       每个 miss 段（清零前）最多 2 次（防拉风箱）；三态 try/catch 静默。
       与 maybeAutoZoom 不冲突：脉冲只在无 hit 的 miss 段触发，AutoZoom 只在 hit 后；
       脉冲进行中 AutoZoom 触发 → 立即终止回退计时（以 AutoZoom 为准）。 */
    let pulseActive = false;      // 脉冲在途（含回退计时）
    let pulseCount = 0;           // 当前 miss 段已脉冲次数
    let pulseTimer = null;        // 回退计时器
    let pulseRestoreZoom = null;  // 回退目标值
    function maybeFocusPulse() {
      if (pulseActive || awaiting || zscanActive) return;   // 3.1：推近期间脉冲暂停
      if (!camCaps || !camCaps.zoom) return;
      if (misses < 12) return;
      if (pulseCount >= 2) return;   // 每 miss 段最多 2 次
      const now = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      if (!openAt || now - openAt < 2000) return;
      const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      if (!track || !track.applyConstraints) return;
      let cur = 1;
      try { cur = (track.getSettings && track.getSettings() && track.getSettings().zoom) || 1; } catch (_) {}
      const z = Math.min(camCaps.zoom.max, cur + Math.max(0.2, cur * 0.15));
      if (z <= cur) return;
      pulseActive = true;
      pulseCount++;
      pulseRestoreZoom = cur;
      try {
        const p = track.applyConstraints({ advanced: [{ zoom: z }] });
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* 静默 */ }
      pulseTimer = setTimeout(() => {
        pulseTimer = null;
        /* 回退时若 AutoZoom 已接管（pulseActive 被置 false）则跳过。 */
        if (!pulseActive) return;
        pulseActive = false;
        const t2 = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
        if (!t2 || !t2.applyConstraints) return;
        try {
          const p2 = t2.applyConstraints({ advanced: [{ zoom: pulseRestoreZoom }] });
          if (p2 && p2.catch) p2.catch(() => {});
        } catch (_) { /* 静默 */ }
      }, 700);
    }
    /* AutoZoom 触发时抢占：终止脉冲回退计时（以 AutoZoom 的变焦为准）。 */
    function pulseYieldToAutoZoom() {
      if (!pulseActive) return;
      pulseActive = false;
      if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null; }
    }

    /* 项 1（3.1）：miss 渐进光学推近（变焦扫描）—— 远小码 540p 检测不到拿不到
       box，autoZoom 永不启动（鸡生蛋）。连续 miss ≥16 且 zoom 能力存在且非
       awaiting 且距上次扫描 ≥3s → 1×→×1.5（~1.2s）→×2.0（~1.2s）→回 1×。
       任何 hit 打断：停当前 zoom 交 maybeAutoZoom 接续；awaiting/close 中止回 1×。
       推近期间对焦脉冲暂停（变焦变化本身即 AF 刺激），共用 lastZoomAt 防拉锯。 */
    const ZSCAN_STEPS = [1.5, 2.0];
    const ZSCAN_HOLD_MS = 1200;
    const ZSCAN_COOLDOWN_MS = 3000;
    let zscanActive = false;
    let zscanStepIdx = 0;
    let zscanTimer = null;
    let zscanLastEndAt = -1;  // 上次扫描结束（冷却起点；-1 = 未扫描过，以 open 时间起算）
    let zscanCropDoneAt = 0;  // 当前档位停留期已跑过中心裁切
    function zscanStop(restore) {
      if (zscanTimer) { clearTimeout(zscanTimer); zscanTimer = null; }
      const wasActive = zscanActive;
      zscanActive = false;
      zscanStepIdx = 0;
      if (wasActive) {
        zscanLastEndAt = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        if (restore) resetZoom();
      }
    }
    function zscanAdvance() {
      if (!zscanActive || !stream) { zscanStop(false); return; }
      if (zscanStepIdx >= ZSCAN_STEPS.length) { zscanStop(true); return; }   // 序列完 → 回 1×
      const track = stream.getVideoTracks && stream.getVideoTracks()[0];
      if (!track || !track.applyConstraints) { zscanStop(true); return; }
      const z = Math.min(camCaps.zoom.max, ZSCAN_STEPS[zscanStepIdx]);
      zscanCropDoneAt = 0;   // 新档位：中心裁切可再跑一次
      try {
        const p = track.applyConstraints({ advanced: [{ zoom: z }] });
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* 静默 */ }
      const now = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      lastZoomAt = now;
      zscanStepIdx++;
      zscanTimer = setTimeout(zscanAdvance, ZSCAN_HOLD_MS);
    }
    function maybeZoomScan() {
      if (opts.autoApproach === false) return;   // 显式关闭（测试/嵌入方）
      if (zscanActive || awaiting) return;
      if (!camCaps || !camCaps.zoom) return;
      if (misses < 16) return;
      const now = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      /* 冷却：首次以 open 时间（openAt）起算，之后以上次扫描结束起算。 */
      const cooldownFrom = zscanLastEndAt >= 0 ? zscanLastEndAt : openAt;
      if (now - cooldownFrom < ZSCAN_COOLDOWN_MS) return;
      zscanActive = true;
      zscanStepIdx = 0;
      setStatus('正在自动拉近寻找二维码…');
      zscanAdvance();
    }

    /* 项 2（3.1）：miss 中心裁切放大重解 —— 正中心 crop 1/2 视野 → 放大 2× →
       decodeAllVia（skipVote）。zoom 能力存在时在推近每级停留期各 1 次；无 zoom 时
       每 ~1.2s 1 次；cropZoomBusy 复用防重入。 */
    let centerCropLastAt = 0;
    function maybeCenterCrop() {
      if (opts.autoApproach === false) return;   // 显式关闭（测试/嵌入方）
      if (cropZoomBusy || awaiting || !stream || !video.videoWidth) return;
      if (misses < 16) return;
      const now = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      if (zscanActive) {
        /* 推近停留期：每档位最多 1 次（zscanCropDoneAt 按档位清零）。 */
        if (zscanCropDoneAt) return;
        zscanCropDoneAt = now;
      } else {
        if (!camCaps || camCaps.zoom) return;   // 有 zoom 时无推近不主动裁（推近已覆盖）
        if (now - centerCropLastAt < 1200) return;   // 无 zoom：1.2s 节流
        centerCropLastAt = now;
      }
      centerCropRetry();
    }
    async function centerCropRetry() {
      if (cropZoomBusy || !stream) return false;
      cropZoomBusy = true;
      try {
        if (!fullCtx || !video.videoWidth) return false;
        const vw = video.videoWidth, vh = video.videoHeight;
        /* 中心 1/2 视野。 */
        const cw = Math.round(vw / 2), ch = Math.round(vh / 2);
        const cx = Math.round((vw - cw) / 2), cy = Math.round((vh - ch) / 2);
        const dw = cw * 2, dh = ch * 2;   // 放大 2×
        if (fullCanvas.width !== dw) fullCanvas.width = dw;
        if (fullCanvas.height !== dh) fullCanvas.height = dh;
        fullCtx.drawImage(video, cx, cy, cw, ch, 0, 0, dw, dh);
        const image = fullCtx.getImageData(0, 0, dw, dh);
        const r = await decodeAllVia({ canvas: fullCanvas, image, isSlow: false });
        if (!stream) return false;
        if (r && r.hits && r.hits.length) {
          const captured = current && current.captureToken ? current.captureToken() : undefined;
          absorbHits(r.hits, captured, dw, dh, true);
          return true;
        }
        return false;
      } catch (_) { return false; }
      finally { cropZoomBusy = false; }
    }

    /* 项 1 无 zoom 降级：从当前全尺寸帧 crop box 外扩 25% → 放大 2~3 倍重解。 */
    let cropZoomBusy = false;
    async function cropZoomRetake(box, imgW, imgH) {
      if (cropZoomBusy || !stream) return false;
      cropZoomBusy = true;
      try {
        if (!fullCtx || !video.videoWidth) return false;
        const vw = video.videoWidth, vh = video.videoHeight;
        /* box 是解码帧坐标（可能 960×540），换算到全尺寸 video 坐标。 */
        const sx = (box.x / imgW) * vw, sy = (box.y / imgH) * vh;
        const sw = (box.w / imgW) * vw, sh = (box.h / imgH) * vh;
        const padX = sw * 0.25, padY = sh * 0.25;
        const cx = Math.min(Math.max(Math.round(sx - padX), 0), vw);
        const cy = Math.min(Math.max(Math.round(sy - padY), 0), vh);
        const cw = Math.min(Math.round(sw + padX * 2), vw - cx);
        const ch = Math.min(Math.round(sh + padY * 2), vh - cy);
        if (cw < 8 || ch < 8) return false;
        /* 放大倍数：目标短边 720~1080。 */
        const scale = Math.min(3, Math.max(2, 720 / Math.min(cw, ch)));
        const dw = Math.round(cw * scale), dh = Math.round(ch * scale);
        if (fullCanvas.width !== dw) fullCanvas.width = dw;
        if (fullCanvas.height !== dh) fullCanvas.height = dh;
        fullCtx.drawImage(video, cx, cy, cw, ch, 0, 0, dw, dh);
        const image = fullCtx.getImageData(0, 0, dw, dh);
        const r = await decodeAllVia({ canvas: fullCanvas, image, isSlow: false });
        if (!stream) return false;
        if (r && r.hits && r.hits.length) {
          const captured = current && current.captureToken ? current.captureToken() : undefined;
          absorbHits(r.hits, captured, dw, dh, true);
          return true;
        }
        return false;
      } catch (_) { return false; }
      finally { cropZoomBusy = false; }
    }

    /* 项 1 收尾：zoom 重置回 1（close/open 调用）。 */
    function resetZoom() {
      try {
        if (!camCaps || !camCaps.zoom) return;
        const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
        if (!track || !track.applyConstraints) return;
        const cur = (track.getSettings && track.getSettings() && track.getSettings().zoom) || 1;
        if (cur <= 1) return;
        const p = track.applyConstraints({ advanced: [{ zoom: 1 }] });
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* 静默 */ }
    }

    function applyCameraEnhancements(acquired) {
      camCaps = null;
      const track = acquired && acquired.getVideoTracks && acquired.getVideoTracks()[0];
      if (!track) return;
      const caps = { focus: false, zoom: null, torch: false };
      try {
        const supported = (win.navigator && win.navigator.mediaDevices && win.navigator.mediaDevices.getSupportedConstraints) || null;
        const supportedMap = supported ? supported() : null;
        const c = track.getCapabilities ? track.getCapabilities() : null;
        if (c && c.focusMode && c.focusMode.indexOf && c.focusMode.indexOf('continuous') >= 0) {
          const ok = !supportedMap || !('focusMode' in supportedMap) || !!supportedMap.focusMode;
          if (ok) {
            try {
              const p = track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
              if (p && p.then) {
                p.then(() => {
                  try {
                    const s = track.getSettings && track.getSettings();
                    if (s && s.focusMode === 'continuous') caps.focus = true;
                  } catch (_) {}
                }).catch(() => {});
              } else {
                try {
                  const s = track.getSettings && track.getSettings();
                  if (s && s.focusMode === 'continuous') caps.focus = true;
                } catch (_) {}
              }
            } catch (_) { /* applyConstraints 同步抛错也静默 */ }
          }
        }
        if (c && c.zoom && typeof c.zoom.min === 'number' && typeof c.zoom.max === 'number') {
          caps.zoom = { min: c.zoom.min, max: c.zoom.max };
        }
        if (c && c.torch) caps.torch = true;
      } catch (_) { /* 任何探测失败都静默 */ }
      camCaps = caps;
    }

    /* P0-1：取帧。opts.capture 注入时跳过整个内置管线。
       修 C：awaiting（确认卡展示中）不走 fullFrameEvery 全帧慢路径——已有候选，
       不需要全帧找小码，快路径即可。
       项 2b/2c：返回 {image, isSlow}；慢帧尺寸 = 原生 BarcodeDetector 可用时全帧
       （原生 1080p 也快），否则 1280×720 中档（省解码时间）。 */
    function nativeSlowAvailable() {
      /* 2.93：统一走 nativeAvailable（nativeDead 会话级标记）。 */
      return nativeAvailable();
    }
    /* P0-1 取帧：返回 {canvas, image, isSlow}。
       项 1（2.93）：原生可用时 image=null（免 getImageData 回读，detect 直接吃
       canvas）；需要喂 worker/链时才由 decodeAllVia 补读。opts.capture 注入时
       无 canvas，image 必给。 */
    function captureFrame() {
      if (!video.videoWidth) return null;
      if (opts.capture) {
        const image = opts.capture(video);
        return image ? { canvas: null, image, isSlow: false } : null;
      }
      const vw = video.videoWidth, vh = video.videoHeight;
      /* 项 2（2.97）：原生慢车道减负 —— 慢帧统一 720p（min(1,1280/vw)）+
         原生时慢帧间隔 6（wasm 慢车道维持 fullFrameEvery 现状）；
         自适应变焦已兜小码，1080p 慢帧不再是小码唯一指望。 */
      const slowEvery = (nativeAvailable() ? 6 : fullFrameEvery) + slowEveryExtra;
      if (pipeline === 'legacy' || (!awaiting && ++frameNo % slowEvery === 0)) {
        if (!fullCtx) return null;
        const sc = Math.min(1, 1280 / vw);
        const dw = Math.round(vw * sc), dh = Math.round(vh * sc);
        if (fullCanvas.width !== dw) fullCanvas.width = dw;
        if (fullCanvas.height !== dh) fullCanvas.height = dh;
        if (dw === vw && dh === vh) fullCtx.drawImage(video, 0, 0);
        else fullCtx.drawImage(video, 0, 0, vw, vh, 0, 0, dw, dh);
        return {
          canvas: fullCanvas,
          image: nativeAvailable() ? null : fullCtx.getImageData(0, 0, dw, dh),
          isSlow: true
        };
      }
      /* 项 2（2.99）：升清时 tier 如实显示。 */
      perf.tier = frameBoosted ? '720p(临时)' : '540p';
      const fw = Math.max(1, Math.round(vw * frameScale));
      const fh = Math.max(1, Math.round(vh * frameScale));
      /* 项 3（2.99）：原生快帧直喂 video —— 免 drawImage，canvas 仅登记尺寸。 */
      if (skipFastDraw && nativeAvailable()) {
        syncTier();
        return { canvas: null, image: null, isSlow: false, lazyImage: buildFastImage, videoDirect: true, fw, fh };
      }
      if (!ctx) return null;
      if (canvas.width !== fw) canvas.width = fw;
      if (canvas.height !== fh) canvas.height = fh;
      ctx.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh);
      return {
        canvas,
        image: nativeAvailable() ? null : ctx.getImageData(0, 0, fw, fh),
        isSlow: false
      };
    }

    /* 项 2b：慢帧独立通道标志（2.93 起慢/快都经 decodeAllVia 三级，仅单飞区分）。 */
    let slowBusy = false;

    /* 项 1（3.0）：弱机自适应降档 360p —— 滚动 12 帧 captureMs+decodeMs 中位>40ms
       → 本会话降档 frameScale=1/3（640×360）+ fullFrameEvery+2。单向降档（不回升），
       open() 重置；显式 opts.frameScale/opts.frameTier 锁定时不自动降。
       三档状态机 360p/540p/720p(临时)：升清只发生在 540p 档（弱机降 360p 后不再升）。 */
    const tierLocked = !!(opts.frameScale || opts.frameTier);
    let degraded = false;          // 已降档（会话内单向）
    let slowEveryExtra = 0;        // 降档后 fullFrameEvery 增量
    let frameCostRing = [];        // 滚动 12 帧 captureMs+decodeMs
    function frameCostMedian() {
      const a = frameCostRing.slice().sort((x, y) => x - y);
      return a.length ? a[Math.floor(a.length / 2)] : 0;
    }
    function maybeDegradeFrame(cost) {
      if (tierLocked || degraded) return;
      frameCostRing.push(cost);
      if (frameCostRing.length > 12) frameCostRing.shift();
      if (frameCostRing.length < 12) return;
      if (frameCostMedian() <= 40) return;
      degraded = true;
      frameBoosted = false;   // 降档清空升清态（360p 档不再升 720p）
      frameScale = 1 / 3;
      slowEveryExtra = 2;
      frameCostRing = [];   // 降档后重新收集，防止立即再评估
      syncTier();
    }

    /* 项 2（2.99）：miss 升清/降回。hit 或 miss 清零时降回 baseFrameScale。
       3.0：升清只发生在 540p 档（degraded 360p 不再升 720p）。 */
    function unboostFrame() {
      if (!frameBoosted) return;
      frameBoosted = false;
      frameScale = degraded ? 1 / 3 : baseFrameScale;
      syncTier();
    }
    function syncTier() {
      perf.tier = frameBoosted ? '720p(临时)' : (degraded ? '360p' : '540p');
    }
    function resetMisses() {
      misses = 0; missNotified = false; guideLevel = 0;
      pulseCount = 0;   // 项 1（2.99）：miss 段清零 → 脉冲计数复位
      unboostFrame();
      /* 项 1（3.1）：hit 打断推近扫描 —— 停当前 zoom（不回 1×），交 maybeAutoZoom。 */
      if (zscanActive) zscanStop(false);
    }
    function maybeBoostFrame() {
      /* 原生快通道连续 miss ≥10 帧 → 临时升清 0.67（约 1280×720）。仅 540p 档。 */
      if (frameBoosted || degraded) return;
      if (misses < 10) return;
      frameBoosted = true;
      frameScale = Math.min(1, baseFrameScale * (0.67 / 0.5));
      syncTier();
    }

    /* P1-3：框选重扫 —— 以 (fx, fy)（0~1 归一化）为中心 crop 1/4 视野 → 720×720 →
       只喂解码引擎重试。命中走正常 absorbHits 流程。 */
    async function cropRetake(fx, fy) {
      if (cropBusy || !stream) return false;
      cropBusy = true;
      try {
        if (!cropCtx || !video.videoWidth) return false;
        const vw = video.videoWidth, vh = video.videoHeight;
        const cw = Math.round(vw / 4), ch = Math.round(vh / 4);
        const cx = Math.min(Math.max(Math.round(fx * vw - cw / 2), 0), vw - cw);
        const cy = Math.min(Math.max(Math.round(fy * vh - ch / 2), 0), vh - ch);
        if (cropCanvas.width !== 720) cropCanvas.width = 720;
        if (cropCanvas.height !== 720) cropCanvas.height = 720;
        cropCtx.drawImage(video, cx, cy, cw, ch, 0, 0, 720, 720);
        const image = cropCtx.getImageData(0, 0, 720, 720);
        /* P1-3：track 支持 zoom 时同步引导真变焦（2× 当前，封顶 max；三态全静默）。 */
        tryZoom();
        const t1 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        const hits = await decodeAllVia({ canvas: cropCanvas, image, isSlow: false });
        const t2 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        perf.decodeMs += t2 - t1;
        if (!stream) return false;   // 迟到结果丢弃
        if (hits && hits.length) {
          const captured = current && current.captureToken ? current.captureToken() : undefined;
          absorbHits(hits, captured, 720, 720, true);
          return true;
        }
        return false;
      } catch (_) { return false; }
      finally { cropBusy = false; updateCropEntry(); }
    }

    /* P1-3：zoom 约束三态（能力有/无/reject）全 try/catch 静默。 */
    function tryZoom() {
      try {
        if (!camCaps || !camCaps.zoom) return;
        const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
        if (!track || !track.applyConstraints) return;
        const cur = (track.getSettings && track.getSettings() && track.getSettings().zoom) || 1;
        const z = Math.min(camCaps.zoom.max, cur * 2);
        if (z <= cur) return;
        const p = track.applyConstraints({ advanced: [{ zoom: z }] });
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* 静默 */ }
    }

    /* P1-3：入口可见性 —— 多码候选 ≥2 或连续 miss ≥12 帧时显示。 */
    function updateCropEntry() {
      if (!cropBtn) return;
      const show = !!stream && !cropBusy && (seen.size >= 2 || misses >= 12);
      cropBtn.hidden = !show;
    }

    /* 单帧处理：取帧 → 按通道解码（快=worker/主链，慢=原生独立通道）→ absorbHits。
       修 B：确认卡展示期间降频 —— 距上次实际处理 <200ms 的帧直接跳过。
       项 2b：快/慢各自单飞（fastBusy/slowBusy），慢帧在途不阻塞快帧。 */
    let lastProcessAt = 0;
    let fastBusy = false;
    let hudTimer = null;
    async function processFrame(myGen) {
      if (myGen !== generation || !stream) return false;
      const now0 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      if (awaiting && lastProcessAt && now0 - lastProcessAt < 200) return false;
      lastProcessAt = now0;
      const t0 = now0;
      try {
        /* 项 3（2.99）：原生快车道直喂 video —— captureFrame 在原生快帧跳过
           drawImage（skipFastDraw），detect(video) 直接吃 HTMLVideoElement；
           wasm 兜底需要 image 时才按需补画（buildFastImage）。慢车道 canvas 不变。 */
        skipFastDraw = nativeAvailable() && pipeline !== 'legacy';
        const captured0 = captureFrame();
        skipFastDraw = false;
        if (!captured0) return false;
        const image = captured0.image, isSlow = captured0.isSlow;
        /* 尺寸：image 可能为 null（原生免回读），用 canvas 尺寸。 */
        const imgW = image ? image.width : (captured0.canvas ? captured0.canvas.width : 0);
        const imgH = image ? image.height : (captured0.canvas ? captured0.canvas.height : 0);
        const captured = current.captureToken ? current.captureToken() : undefined;
        const t1 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        perf.captureMs += t1 - t0;
        if (isSlow) {
          /* 慢帧独立通道：decodeAllVia 三级（原生→worker→链），与快帧互不阻塞。 */
          if (slowBusy) return false;
          slowBusy = true;
          try {
            const hits = await decodeAllVia(captured0);
            const t2 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
            perf.decodeMs += t2 - t1; lastDecodeMs = t2 - t1;
            maybeDegradeFrame((t1 - t0) + (t2 - t1));   // 项 1（3.0）：弱机降档信号
            if (myGen !== generation || !stream) return true;
            frameSeq++;
            if (hits && hits.length) {
              resetMisses();
              absorbHits(hits, captured, imgW, imgH);
            } else {
              perf.missCount++;
              misses++;
              if (image) sampleLuma(image);
              missGuide();
              maybeOfferTorch();
            }
          } finally { slowBusy = false; }
          updateCropEntry();
          return true;
        }
        /* 快通道（2.94 三车道）：原生 await（10-30ms）→ 命中即 absorb 返回；
           miss → maybeWasmFallback fire-and-forget（不 await，帧流程当场结束）。 */
        if (fastBusy) return false;
        fastBusy = true;
        try {
          if ((captured0.canvas || captured0.videoDirect) && nativeAvailable()) {
            /* 项 3（2.99）：videoDirect 时 detect(video) 直喂（免 drawImage）。 */
            const tN0 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
            const nhits = await nativeDecode(captured0.videoDirect ? video : captured0.canvas, 'fast');
            const tN1 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
            perf.decodeMs += tN1 - tN0; lastDecodeMs = tN1 - tN0;
            maybeDegradeFrame((t1 - t0) + (tN1 - tN0));   // 项 1（3.0）：弱机降档信号
            if (myGen !== generation || !stream) return true;
            frameSeq++;
            if (nhits !== null && nhits.length) {
              resetMisses();
              absorbHits(nhits, captured, imgW, imgH);
            } else {
              perf.missCount++;
              misses++;
              maybeBoostFrame();   // 项 2（2.99）：连续 miss 升清
              if (image) sampleLuma(image);
              missGuide();
              maybeOfferTorch();
              /* 项 1（2.99）：变焦脉冲对焦助推（拉风箱重对焦）。 */
              /* 项 1（3.1）：推近期间对焦脉冲暂停（变焦本身即 AF 刺激）。 */
              if (!zscanActive) maybeFocusPulse();
              /* 项 1/2（3.1）：渐进光学推近 + 中心裁切重解（远小码鸡生蛋破局）。 */
              maybeZoomScan();
              maybeCenterCrop();
              /* wasm 兜底车道：fire-and-forget，不阻塞下一帧。 */
              maybeWasmFallback(captured0, captured, imgW, imgH, myGen);
            }
            updateCropEntry();
            return true;
          }
          /* 原生不可用：worker 每帧串行（唯一引擎，保持现状语义）。 */
          const hits = await decodeAllVia(captured0);
          const t2 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
          perf.decodeMs += t2 - t1; lastDecodeMs = t2 - t1;
          maybeDegradeFrame((t1 - t0) + (t2 - t1));   // 项 1（3.0）：弱机降档信号
          if (myGen !== generation || !stream) return true;   // 迟到结果丢弃
          frameSeq++;
          if (hits && hits.length) {
            resetMisses();
            absorbHits(hits, captured, imgW, imgH);
          } else {
            perf.missCount++;
            misses++;
            if (image) sampleLuma(image);
            missGuide();
            maybeOfferTorch();
          }
        } finally { fastBusy = false; }
      } catch (_) {
        perf.missCount++;
        misses++;
        missGuide();
      }
      updateCropEntry();
      return true;
    }

    function sampleLuma(image) {
      try {
        const d = image.data, n = d.length;
        if (!n) return;
        let sum = 0, cnt = 0;
        for (let i = 0; i + 2 < n; i += 16 * 4) {
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          cnt++;
        }
        if (!cnt) return;
        const y = sum / cnt;
        lumaAvg = lumaAvg === 255 ? y : lumaAvg * 0.9 + y * 0.1;
      } catch (_) { /* 亮度采样失败不影响主流程 */ }
    }

    function rvfcLoop(myGen) {
      if (myGen !== generation || !stream) return;
      if (!video.requestVideoFrameCallback) { timerLoop(myGen); return; }
      let cb;
      try {
        cb = video.requestVideoFrameCallback(function onFrame(now, metadata) {
          if (myGen !== generation || !stream) return;
          try {
            const meta = metadata || {};
            const presented = meta.presentedFrames != null ? meta.presentedFrames : (meta.currentTime != null ? meta.currentTime : null);
            if (presented !== null && presented === lastPresented) return rvfcLoop(myGen);
            lastPresented = presented;
            /* 项 2b：通道单飞在 processFrame 内部（fastBusy/slowBusy），此处不再全局闸。 */
            const p = processFrame(myGen);
            if (p && p.catch) p.catch(() => {});
          } catch (_) { timerLoop(myGen); return; }
          rvfcLoop(myGen);
        });
      } catch (_) { timerLoop(myGen); return; }
      rafId = cb;
    }

    function timerLoop(myGen) {
      if (myGen !== generation || !stream) return;
      timer = setTimeout(() => {
        if (myGen !== generation || !stream) return;
        /* 项 2b：不 await —— 慢帧在途不阻塞下一拍（通道单飞在 processFrame 内）。 */
        try { const p = processFrame(myGen); if (p && p.catch) p.catch(() => {}); } catch (_) {}
        timerLoop(myGen);
      }, intervalMs);
    }

    function loop(myGen) {
      if (legacyLoop || !video.requestVideoFrameCallback) timerLoop(myGen);
      else rvfcLoop(myGen);
    }

    async function open(openOpts) {
      close('reopen');
      generation++;
      const myGen = generation;
      /* 项（2.98）：UA 相机门禁 —— 已知崩溃浏览器（百度系实证：崩在 getUserMedia
         本身且进程死亡丢标记，stage 机制救不到）默认不碰相机。
         命中且未显式 force → open 走与 stage≥2 相同的拦截分支（共用渲染）。
         脱困：「仍要尝试」→ localStorage['mes.scanForceCamera']='1' 记住选择。
         存储不可用 → 命中 UA 时每次都拦截（安全方向，静默跳过）。 */
      const CRASHY_UA_RE = /(baidu)/i;
      let uaBlocked = false;
      try {
        uaBlocked = CRASHY_UA_RE.test(String((win.navigator && win.navigator.userAgent) || '')) &&
          !(scanGuardOk && win.localStorage && win.localStorage.getItem('mes.scanForceCamera') === '1');
      } catch (_) { uaBlocked = false; }
      /* 共用拦截渲染：stage≥2 与 UA 门禁两处调用（不复制粘贴）。 */
      function renderCameraBlocked(openOpts, message, onRetry) {
        scanOpened = false;   // 拦截路径：未真正 open，close 不归零
        current = openOpts; awaiting = false;
        overlay.style.display = 'flex';
        if (win.requestAnimationFrame) win.requestAnimationFrame(() => btnClose.focus()); else btnClose.focus();
        showErr(message);
        const retry = doc.createElement('button');
        retry.type = 'button'; retry.className = 'btn small ghost';
        retry.textContent = '仍要尝试打开相机';
        retry.onclick = onRetry;
        err.parentNode && err.parentNode.insertBefore(retry, err.nextSibling);
      }
      /* UA 门禁优先于 stage 判定。 */
      if (uaBlocked) {
        renderCameraBlocked(openOpts,
          '检测到当前浏览器（百度系）相机扫码会崩溃，已默认停用相机。请改用微信/系统浏览器打开本页，或使用手动输入/扫码枪。',
          () => {
            try { win.localStorage.setItem('mes.scanForceCamera', '1'); } catch (_) {}
            open(openOpts);
          });
        return;
      }
      /* stage≥2：连续异常退出 → 不调 getUserMedia、不构造 worker，直接引导。
         这次拦截不算 clean close（保持 stage 不归零，防重新进入崩溃循环）；
         「仍要尝试」按钮 = 脱困口：归零并重新 open（全功能）。 */
      if (scanGuardOk && scanStage >= 2) {
        renderCameraBlocked(openOpts,
          '当前浏览器无法使用相机扫码（已连续异常退出）。请用微信或系统浏览器打开本页，或改用手动输入/扫码枪。',
          () => {
            try { win.localStorage.removeItem('mes.scanStage'); } catch (_) {}
            scanStage = 0; compatMode = false;
            open(openOpts);
          });
        return;
      }
      scanOpened = true;   // 真正进入取流：close 视为 clean，归零 stage
      /* 项 2 v2（2.96）：标记前置 —— 取流/worker 构造之前立即写 stage+1，
         崩在 getUserMedia/worker 阶段也拦不住已写入的标记。 */
      markScanStage();
      current = openOpts; awaiting = false; pendingReset();
      perf.captureMs = 0; perf.decodeMs = 0; perf.missCount = 0; perf.hitCount = 0; perf.firstHitMs = 0;
      lastDecodeMs = 0;
      /* 项 2（2.93）：诊断行 500ms 刷新。 */
      if (hudOn && !hudTimer) {
        const renderHud = () => {
          try {
            hudEl.textContent = '引擎 ' + perf.engineName + ' · 解码 ' + Math.round(lastDecodeMs) + 'ms · 档位 ' + (perf.tier || '540p') + ' · 已识别 ' + perf.hitCount;
          } catch (_) {}
        };
        renderHud();
        hudTimer = setInterval(renderHud, 500);
      }
      frameNo = 0; lumaAvg = 255;
      /* 项 1（3.0）：降档状态 open 重置（会话级单向降档不跨 open）。 */
      degraded = false; slowEveryExtra = 0; frameCostRing = []; frameBoosted = false;
      if (!tierLocked) frameScale = baseFrameScale;
      syncTier();
      openAt = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      clearErr();
      confirmBox.hidden = true;
      hint.innerHTML = openOpts.hint || '对准二维码或条形码，识别后需确认才填入';
      setStatus('正在打开摄像头…');
      overlay.style.display = 'flex';
      if (win.requestAnimationFrame) win.requestAnimationFrame(() => btnClose.focus()); else btnClose.focus();
      const devices = opts.mediaDevices || (win.navigator && win.navigator.mediaDevices);
      if (!devices || !devices.getUserMedia) {
        showErr('当前浏览器不支持摄像头（需 HTTPS 或 localhost）。请改用扫码枪或手动输入。');
        return;
      }
      try {
        const acquired = await devices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
        if (myGen !== generation) { acquired.getTracks().forEach(t => t.stop()); return; }
        stream = acquired;
        video.srcObject = stream;
        try { await video.play(); }
        catch (e) {
          stopStream();
          showErr('相机画面启动失败，设备已释放。请改用扫码枪或手动输入。');
          return;
        }
        try { applyCameraEnhancements(acquired); } catch (_) {}
        /* 兼容模式提示放 hint 区（missGuide 会覆盖 statusEl，hint 常驻）。 */
        if (compatMode) hint.innerHTML += '<br><small style="opacity:.7">已自动切换兼容模式（上次扫码异常退出），识别稍慢</small>';
        /* P1-1：首次 open() 后台预热 zxing-wasm（不阻塞取流与第 3 级解码）。 */
        try { chain.warmUp(); } catch (_) {}
        /* P1-4 热修：worker 开机自检（异步不阻塞取流）。自检期间正常收帧——
           若自检失败会立即掐掉 worker 桥，后续帧自动落主线程链。 */
        try {
          const bridge = makeWorkerBridge();
          if (bridge && typeof bridge.selfTest === 'function') bridge.selfTest();
        } catch (_) {}
        setStatus('正在识别…');
        loop(myGen);
      } catch (e) {
        showErr('无法打开摄像头：' + ((e && e.message) || e) + '。请检查浏览器权限后重试，或改用扫码枪/手动输入。');
      }
    }

    btnClose.onclick = () => close('user');
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.style.display && overlay.style.display !== 'none') { e.preventDefault(); close('escape'); }
    });
    if (win.addEventListener) win.addEventListener('pagehide', () => close('pagehide'));

    /* P1-3：「框选重扫」入口 —— 点击按钮后点预览区域（或直接点按钮用画面中心）。 */
    if (cropBtn) {
      cropBtn.type = 'button';
      cropBtn.className = 'btn small ghost';
      cropBtn.textContent = '🔍 框选重扫';
      cropBtn.hidden = true;
      cropBtn.onclick = () => {
        /* 直接点击 = 以画面中心重扫；要框选具体位置请直接点预览画面。 */
        cropRetake(0.5, 0.5);
      };
      /* 预览层点选热区：点画面任意位置以该点为中心重扫。 */
      overlay.addEventListener('click', e => {
        if (cropBusy || !stream || cropBtn.hidden) return;
        if (e.target === btnClose || e.target === btnYes || e.target === btnRetry) return;
        if (confirmBox && !confirmBox.hidden && confirmBox.contains(e.target)) return;
        if (candidatesEl && candidatesEl.contains(e.target)) return;
        const r = overlay.getBoundingClientRect && overlay.getBoundingClientRect();
        if (!r || !r.width || !r.height) { cropRetake(0.5, 0.5); return; }
        cropRetake((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      });
    }

    return { open, close, isOpen: () => !!current && overlay.style.display !== 'none' };
  }

  const byDoc = typeof WeakMap === 'function' ? new WeakMap() : null;
  function forDocument(opts) {
    if (!byDoc || !opts.document) return attach(opts);
    let inst = byDoc.get(opts.document);
    if (!inst) { inst = attach(opts); byDoc.set(opts.document, inst); }
    return inst;
  }

  return { attach, forDocument, defaultDecode };
});
