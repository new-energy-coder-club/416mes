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
    const frameScale = opts.frameScale > 0 && opts.frameScale <= 1 ? opts.frameScale : 0.5;
    const fullFrameEvery = opts.fullFrameEvery >= 1 ? Math.floor(opts.fullFrameEvery) : 4;
    const legacyLoop = !!opts.legacyLoop;
    /* P1-2：多帧投票阈值（默认 2；=1 即 P0 现状语义：单帧即弹卡）。 */
    const voteThreshold = opts.voteThreshold >= 1 ? Math.floor(opts.voteThreshold) : 2;
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
    function makeWorkerBridge() {
      if (workerBridge) return workerBridge;
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
            /* 复制 buffer 转移（getImageData 的 data 后续还要给主线程链回退用，不能真转移走）。 */
            const buf = image.data.buffer.slice(0);
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

    /* P1-4：统一 decodeAll 入口 —— worker 优先，失败回退主线程链。 */
    async function decodeAllVia(image) {
      const bridge = makeWorkerBridge();
      if (bridge && bridge.alive()) {
        try {
          const hits = await bridge.decodeAll(image);
          perf.engineName = 'worker(zxing/jsQR)';
          return hits;
        } catch (_) { /* 永久回退主线程链 */ }
      }
      return chain.decodeAll(image);
    }
    const decode = defaultDecode(win, decodeAllVia);

    let stream = null, timer = null, generation = 0, current = null, awaiting = false;
    let misses = 0, missNotified = false;
    let guideLevel = 0;
    let torchOffered = false;
    let lumaAvg = 255;
    let camCaps = null;
    let rafId = 0;
    let decoding = false;
    let lastPresented = null;
    let frameNo = 0;
    /* P1-2：会话帧序号（投票窗口用）。 */
    let frameSeq = 0;
    /* P1-3：框选重扫在途标志（防连点）。 */
    let cropBusy = false;
    const perf = { captureMs: 0, decodeMs: 0, missCount: 0, hitCount: 0, engineName: 'jsQR+ItemBarcode', firstHitMs: 0 };
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
      if (rafId && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(rafId); } catch (_) {} }
      rafId = 0; decoding = false; lastPresented = null; cropBusy = false;
      /* P1-4：收口必须 terminate worker，防泄漏（pagehide 也走 close）。 */
      if (workerBridge) { workerBridge.terminate(); workerBridge = null; }
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
      misses = 0; missNotified = false; guideLevel = 0; torchOffered = false;
      frameSeq = 0;
      seen = new Map(); selectedText = ''; selectedToken = undefined;
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

    /* P1-2：describe 校验（排后 + 禁用确定用）。返回 {ok, text, action}。 */
    function describeOf(hit) {
      const d = current.describe && current.describe(hit);
      if (typeof d === 'string') return { ok: true, text: d };
      if (d && typeof d === 'object') return { ok: d.ok !== false, text: d.text || '', action: d.action };
      return { ok: true, text: '' };
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

    function renderConfirm() {
      const imgW = video.videoWidth || 0, imgH = video.videoHeight || 0;
      const cands = candidateList(imgW, imgH);
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
        /* 投票：窗口内票数 ≥ voteThreshold 才进候选（skipVote 时直接进）。 */
        if (!e.eligible && (skipVote || e.frames.length >= voteThreshold)) {
          e.eligible = true;
          fresh = true;
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

    /* P0-1：取帧。opts.capture 注入时跳过整个内置管线。 */
    function captureFrame() {
      if (!video.videoWidth) return null;
      if (opts.capture) return opts.capture(video);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (pipeline === 'legacy' || ++frameNo % fullFrameEvery === 0) {
        if (!fullCtx) return null;
        if (fullCanvas.width !== vw) fullCanvas.width = vw;
        if (fullCanvas.height !== vh) fullCanvas.height = vh;
        fullCtx.drawImage(video, 0, 0);
        return fullCtx.getImageData(0, 0, vw, vh);
      }
      if (!ctx) return null;
      const fw = Math.max(1, Math.round(vw * frameScale));
      const fh = Math.max(1, Math.round(vh * frameScale));
      if (canvas.width !== fw) canvas.width = fw;
      if (canvas.height !== fh) canvas.height = fh;
      ctx.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh);
      return ctx.getImageData(0, 0, fw, fh);
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
        const hits = await decodeAllVia(image);
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

    /* 单帧处理：取帧 → decodeAll → 多命中汇入/未命中状态机。 */
    async function processFrame(myGen) {
      if (myGen !== generation || !stream) return false;
      const t0 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      try {
        const image = captureFrame();
        const captured = current.captureToken ? current.captureToken() : undefined;
        if (!image) return false;
        const t1 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        perf.captureMs += t1 - t0;
        const hits = await decodeAllVia(image);
        const t2 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        perf.decodeMs += t2 - t1;
        if (myGen !== generation || !stream) return true;   // 迟到结果丢弃
        frameSeq++;
        if (hits && hits.length) {
          misses = 0; missNotified = false; guideLevel = 0;
          absorbHits(hits, captured, image.width, image.height);
        } else {
          perf.missCount++;
          misses++;
          sampleLuma(image);
          missGuide();
          maybeOfferTorch();
        }
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
            if (decoding) return rvfcLoop(myGen);
            decoding = true;
            const p = processFrame(myGen);
            if (p && p.catch && p.finally) {
              p.catch(() => {}).finally(() => { decoding = false; });
            } else decoding = false;
          } catch (_) { timerLoop(myGen); return; }
          rvfcLoop(myGen);
        });
      } catch (_) { timerLoop(myGen); return; }
      rafId = cb;
    }

    function timerLoop(myGen) {
      if (myGen !== generation || !stream) return;
      timer = setTimeout(async () => {
        if (myGen !== generation || !stream) return;
        if (!decoding) {
          decoding = true;
          try { await processFrame(myGen); }
          finally { decoding = false; }
        }
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
      current = openOpts; awaiting = false; pendingReset();
      perf.captureMs = 0; perf.decodeMs = 0; perf.missCount = 0; perf.hitCount = 0; perf.firstHitMs = 0;
      frameNo = 0; lumaAvg = 255;
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
        /* P1-1：首次 open() 后台预热 zxing-wasm（不阻塞取流与第 3 级解码）。 */
        try { chain.warmUp(); } catch (_) {}
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
