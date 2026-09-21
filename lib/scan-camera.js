/* scan-camera.js — 统一扫码浮层（查询/作业/后续扫码工作台共用，UMD 双端）
 *
 * 解决的问题（用户实测反馈）：
 *   · ITM 页把 <video> 直接嵌在页面下方，体验差；现统一为全屏浮层（复用扫码工作台
 *     cam-overlay 的视觉/焦点/ESC/错误常驻模式）。
 *   · 扫到码直接执行 —— 现统一弹确认卡：显示码制/码值/对象摘要，点「确定填入」才回调。
 *   · 每帧解码失败被静默吞掉 —— 现有「正在识别 / 暂未识别」可见状态。
 *
 * P0（摄像头扫码算法优化方案 §4）：
 *   · P0-1 帧管线：captureFrame → captureFrames() 双路径 —— 常驻离屏 canvas，
 *     快路径按 frameScale（默认 0.5）降采样（960×540 档，jsQR 实测 miss ~50ms），
 *     慢路径每 fullFrameEvery（默认 4）帧跑一次全帧兜小码/边缘码；
 *     opts.pipeline='legacy' 回退旧全帧路径；opts.capture 注入时跳过整个内置管线。
 *   · P0-2 帧驱动：video.requestVideoFrameCallback 优先（按相机出帧节奏驱动，
 *     同帧不重解、decode 在途跳帧防积压）；不可用回退 setTimeout 循环；
 *     opts.legacyLoop=true 强制旧循环；rVFC 回调 try/catch 兜底。
 *   · P0-3 相机能力探测：open() 成功后 applyCameraEnhancements(track) ——
 *     focusMode 含 continuous → applyConstraints（getCapabilities/getSupportedConstraints
 *     二重校验、一律 try/catch、getSettings 回读）；zoom 只记录不动；torch 不默认开，
 *     连续 miss ≥ 24 帧给「打开照明」按钮；miss ≥ 6 帧分级引导文案。
 *     iOS/桌面全失败 = 静默，零 console 错误；会话中不改分辨率。
 *   · P0-4 埋点：内部 perf 累计 captureMs/decodeMs/missCount/hitCount/engineName/
 *     首帧命中耗时，挂 window.__scanPerf 调试口，不外发。
 *
 * 依赖全部可注入（window/jsQR/ItemBarcode/mediaDevices 由调用方给），Node 端用
 * linkedom + 假媒体流可完整单测。业务协议（accept/queryScan/token）不变。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScanCamera = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 每帧解码：先二维码（jsQR），再一维码（ItemBarcode/ZXing）。
     返回 { text, format } 或 null；失败静默返回 null，由浮层负责状态提示。 */
  function defaultDecode(win) {
    return async function decode(image) {
      if (!image || !image.width) return null;
      if (win.jsQR) {
        try {
          const qr = win.jsQR(image.data, image.width, image.height);
          if (qr && qr.data) return { text: qr.data, format: '二维码' };
        } catch (_) { /* 本帧无二维码 */ }
      }
      if (win.ItemBarcode && win.ItemBarcode.frame) {
        try {
          const r = await win.ItemBarcode.frame(image);
          const text = r && (typeof r === 'string' ? r : r.text);
          if (text) return { text, format: (typeof r === 'object' && r.format) || '条形码' };
        } catch (_) { /* 本帧无一维码 */ }
      }
      return null;
    };
  }

  function attach(opts) {
    const doc = opts.document, win = opts.win || (doc && doc.defaultView) || {};
    const decode = opts.decode || defaultDecode(win);
    const el = id => doc.getElementById(id);
    const overlay = el('scanCamOverlay'), video = el('scanCamVideo'), hint = el('scanCamHint');
    const err = el('scanCamErr'), confirmBox = el('scanCamConfirm');
    const confirmValue = el('scanCamValue'), confirmMeta = el('scanCamMeta');
    const statusEl = el('scanCamStatus');
    const btnYes = el('scanCamYes'), btnRetry = el('scanCamRetry'), btnClose = el('scanCamClose');
    const candidatesEl = el('scanCamCandidates');
    if (!overlay || !video) throw new Error('scan-camera：页面缺少 scanCam* 浮层结构');

    /* P0-1 帧管线：两个常驻离屏 canvas（快/慢各一，首次取帧定尺寸后不随帧变化），
       快路径降采样 + 慢路径全帧。 */
    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext && canvas.getContext('2d', { willReadFrequently: true });
    const fullCanvas = doc.createElement('canvas');
    const fullCtx = fullCanvas.getContext && fullCanvas.getContext('2d', { willReadFrequently: true });
    const intervalMs = opts.intervalMs == null ? 250 : opts.intervalMs;
    /* P0-1 行为开关：pipeline 'fast'（默认）= 降采样快路径 + 全帧慢路径；'legacy' = 旧全帧路径。 */
    const pipeline = opts.pipeline === 'legacy' ? 'legacy' : 'fast';
    /* 快路径缩放比：默认 0.5（1080p → 540p）。极弱机可调到 0.33（→ 360p）。 */
    const frameScale = opts.frameScale > 0 && opts.frameScale <= 1 ? opts.frameScale : 0.5;
    /* 慢路径（全帧）每 N 帧跑一次，兜小码/边缘码。 */
    const fullFrameEvery = opts.fullFrameEvery >= 1 ? Math.floor(opts.fullFrameEvery) : 4;
    /* P0-2 行为开关：legacyLoop=true 强制旧 setTimeout 循环（即使 rVFC 可用）。 */
    const legacyLoop = !!opts.legacyLoop;
    let stream = null, timer = null, generation = 0, current = null, awaiting = false;
    let misses = 0, missNotified = false;
    /* P0-3：分级引导已提示到第几级（0=未提示，1=第一级，2=第二级）。 */
    let guideLevel = 0;
    /* P0-3：「打开照明」按钮是否已给出（不重复弹）。 */
    let torchOffered = false;
    /* P0-3：环境亮度滑动平均（0~255，采样 miss 帧的稀疏像素点），供 torch 按钮的
       「环境判定偏暗」条件用；亮环境下不弹照明按钮（避免误闪人脸）。 */
    let lumaAvg = 255;
    /* P0-3：相机能力探测结果（zoom 范围备用，P1 变焦用；focus 结果留作调试）。 */
    let camCaps = null;
    /* P0-2：rVFC 循环的取消句柄（cancelVideoFrameCallback）。 */
    let rafId = 0;
    /* P0-2：decode 在途标志 —— 在途时新帧直接跳过，防积压。 */
    let decoding = false;
    /* P0-2：rVFC 元数据比对基准，同帧不重解。 */
    let lastPresented = null;
    /* P0-1：帧序号（快/慢路径调度用）。 */
    let frameNo = 0;
    /* P0-4：内部 perf 累计器，close() 时挂 window.__scanPerf 调试口（不外发）。 */
    const perf = { captureMs: 0, decodeMs: 0, missCount: 0, hitCount: 0, engineName: 'jsQR+ItemBarcode', firstHitMs: 0 };
    let openAt = 0;
    /* 阶段C：一次扫码会话里出现的不同码收集为候选（跨帧去重），用户一次选一个。 */
    let seen = new Map(), selectedText = '', selectedToken = undefined;
    let lastDetected = null;   // 用于「识别了但没点确定就关掉」时给调用方一个明确提示

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

    /* P0-4：会话结束把 perf 挂到 window.__scanPerf（本地调试口，不外发）。 */
    function publishPerf() {
      try {
        if (win && typeof win === 'object') win.__scanPerf = Object.assign({}, perf);
      } catch (_) { /* 调试口失败不影响功能 */ }
    }

    /* 关闭：任何路径统一收口。confirmed 不算取消（不触发 onCancel）。 */
    function close(reason) {
      generation++; clearTimeout(timer); timer = null;
      /* P0-2：停掉 rVFC 循环。 */
      if (rafId && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(rafId); } catch (_) {} }
      rafId = 0; decoding = false; lastPresented = null;
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

    function pendingReset() { misses = 0; missNotified = false; guideLevel = 0; torchOffered = false; seen = new Map(); selectedText = ''; selectedToken = undefined; }

    function renderConfirm() {
      const hit = seen.get(selectedText);
      if (!hit) return;
      confirmValue.textContent = hit.text;
      const d = current.describe && current.describe(hit);
      let metaText = '', allowed = true;
      if (typeof d === 'string') metaText = d;
      else if (d && typeof d === 'object') { metaText = d.text || ''; if (d.ok === false) allowed = false; }
      confirmMeta.textContent = hit.format + ' · ' + metaText;
      btnYes.disabled = !allowed;
      btnYes.textContent = allowed ? '确定填入' : ((d && d.action) || '类型不符，请重扫');
      candidatesEl.replaceChildren();
      const candHint = el('scanCamCandidatesHint');
      if (seen.size > 1) {
        if (candHint) candHint.textContent = '画面里识别到多个码，点下面候选切换，一次只填入一个：';
        for (const key of seen.keys()) {
          if (key === selectedText) continue;
          const b = doc.createElement('button');
          b.type = 'button'; b.className = 'btn small ghost'; b.textContent = '改选 ' + key;
          b.onclick = () => { selectedText = key; renderConfirm(); };
          candidatesEl.appendChild(b);
        }
      } else if (candHint) candHint.textContent = '';
    }

    function showConfirm(hit, captured) {
      if (!seen.has(hit.text)) seen.set(hit.text, hit);
      lastDetected = hit.text;
      if (!awaiting) { awaiting = true; selectedText = hit.text; selectedToken = captured; setStatus('已识别，请确认'); }
      else setStatus('识别到多个码，请选择要填入的一个');
      renderConfirm();
      confirmBox.hidden = false;
      btnYes.onclick = () => {
        const opts2 = current, text = selectedText, token = selectedToken, chosen = seen.get(selectedText);
        close('confirmed');
        if (opts2 && opts2.onConfirm && chosen) opts2.onConfirm(text, token, chosen);
      };
      btnRetry.onclick = () => { confirmBox.hidden = true; awaiting = false; pendingReset(); setStatus('正在识别…'); };
      if (!awaiting || seen.size === 1) btnYes.focus();
    }

    /* P0-3：miss 状态提示分级（重扫后重置）：
       ≥6 帧 → 「请将码放入框内，保持 10~15cm」；≥18 帧 → 「靠太近了，稍微拿远一点」；
       ≥12 帧且未给分级引导时 → 原有「暂未识别到码」兜底文案（不刷屏，只给一次）。 */
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

    /* P0-3：连续 miss ≥ 24 帧（约 6s）且环境判定偏暗（平均亮度 < 90）时，给一次
       「打开照明」按钮（torch 不默认开，避免误闪人脸）。 */
    function maybeOfferTorch() {
      if (torchOffered || misses < 24 || !camCaps || !camCaps.torch) return;
      if (lumaAvg >= 90) return;   // 环境不暗：不弹照明按钮
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

    /* P0-3：相机能力探测（open() 成功后调用）。全部「探测成功才用，失败静默」：
       桌面 Chrome / iOS Safari 不支持 focusMode —— 探测失败只是回到系统默认 AF，
       零 console 错误。会话中不改分辨率（改约束会触发部分安卓机重启流，加剧拉风箱）。 */
    function applyCameraEnhancements(acquired) {
      camCaps = null;
      const track = acquired && acquired.getVideoTracks && acquired.getVideoTracks()[0];
      if (!track) return;
      const caps = { focus: false, zoom: null, torch: false };
      try {
        const supported = (win.navigator && win.navigator.mediaDevices && win.navigator.mediaDevices.getSupportedConstraints) || null;
        const supportedMap = supported ? supported() : null;
        const c = track.getCapabilities ? track.getCapabilities() : null;
        /* focusMode：能力表含 continuous 且（无 getSupportedConstraints 或其认可 focusMode）才请求。 */
        if (c && c.focusMode && c.focusMode.indexOf && c.focusMode.indexOf('continuous') >= 0) {
          const ok = !supportedMap || !('focusMode' in supportedMap) || !!supportedMap.focusMode;
          if (ok) {
            try {
              const p = track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
              if (p && p.then) {
                p.then(() => {
                  /* 假成功 ROM 防护：getSettings 回读校验。 */
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
        /* zoom：只记录范围备用（P1 变焦用），不主动改。 */
        if (c && c.zoom && typeof c.zoom.min === 'number' && typeof c.zoom.max === 'number') {
          caps.zoom = { min: c.zoom.min, max: c.zoom.max };
        }
        /* torch：探测能力存在即可（不默认开）。 */
        if (c && c.torch) caps.torch = true;
      } catch (_) { /* 任何探测失败都静默 */ }
      camCaps = caps;
    }

    /* P0-1：取帧。opts.capture 注入时跳过整个内置管线（测试与自定义取帧语义不变）。
       快路径按 frameScale 降采样；慢路径每 fullFrameEvery 帧跑一次全帧，兜小码/边缘码；
       pipeline:'legacy' 走旧全帧路径（复用慢路径 canvas）。
       两个 canvas 常驻：尺寸只在变化时写入（避免每帧重置上下文状态）。 */
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

    /* 单帧处理：取帧 → decode → 命中/未命中状态机。返回 true 表示本帧 decode 已启动。
       取帧与解码的一切异常都按「本帧未命中」处理，绝不向上抛。 */
    async function processFrame(myGen) {
      if (myGen !== generation || !stream) return false;
      const t0 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      try {
        const image = captureFrame();
        const captured = current.captureToken ? current.captureToken() : undefined;
        if (!image) return false;
        const t1 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        perf.captureMs += t1 - t0;
        const hit = await decode(image);
        const t2 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
        perf.decodeMs += t2 - t1;
        if (myGen !== generation || !stream) return true;   // 迟到结果丢弃
        /* 确认卡打开期间继续识别其它码 → 汇入候选；同码连续帧去重不重复弹。 */
        if (hit && hit.text && !seen.has(hit.text)) {
          misses = 0; missNotified = false; guideLevel = 0;
          perf.hitCount++;
          if (!perf.firstHitMs) perf.firstHitMs = t2 - openAt;
          showConfirm(hit, captured);
        } else if (hit && hit.text && seen.has(hit.text)) { misses = 0; }
        else {
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
        /* 取帧/解码异常按本帧未命中处理 */
      }
      return true;
    }

    /* P0-3：稀疏采样帧亮度（每 16 个像素取 1 个，Y = 0.299R+0.587G+0.114B），
       滑动平均 ~0.1 权重更新。亮环境不弹 torch 按钮的判断依据。 */
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

    /* P0-2：rVFC 循环 —— 按相机出帧节奏驱动；decode 在途跳帧；同帧（presentedFrames/
       currentTime）不重解；回调异常 try/catch 兜底。 */
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
            if (presented !== null && presented === lastPresented) return rvfcLoop(myGen);   // 同帧不重解
            lastPresented = presented;
            if (decoding) return rvfcLoop(myGen);   // decode 在途：跳帧防积压
            decoding = true;
            const p = processFrame(myGen);
            if (p && p.catch && p.finally) {
              /* processFrame 自身已兜住全部异常；这里再兜一层防未来改动引入未处理拒绝。 */
              p.catch(() => {}).finally(() => { decoding = false; });
            } else decoding = false;
          } catch (_) { /* rVFC 回调异常兜底：回退 setTimeout 循环 */ timerLoop(myGen); return; }
          rvfcLoop(myGen);
        });
      } catch (_) { timerLoop(myGen); return; }
      rafId = cb;
    }

    /* P0-2 回退（也是 legacyLoop 强制路径）：setTimeout 自循环，按 intervalMs 最小节拍；
       decode 在途时下一拍直接跳过（不重叠调用 decode）。 */
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
      close('reopen');   // 已有会话（查询/作业互相挤占）先停掉，不共享摄像头
      generation++;
      const myGen = generation;
      current = openOpts; awaiting = false; pendingReset();
      /* P0-4：会话级 perf 清零重计。 */
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
        /* P0-3：相机能力探测（focus 请求 / zoom 记录 / torch 探测），失败全静默。 */
        try { applyCameraEnhancements(acquired); } catch (_) {}
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

    return { open, close, isOpen: () => !!current && overlay.style.display !== 'none' };
  }

  /* 每个 document 共享一个浮层实例（查询/作业同一 DOM 结构） */
  const byDoc = typeof WeakMap === 'function' ? new WeakMap() : null;
  function forDocument(opts) {
    if (!byDoc || !opts.document) return attach(opts);
    let inst = byDoc.get(opts.document);
    if (!inst) { inst = attach(opts); byDoc.set(opts.document, inst); }
    return inst;
  }

  return { attach, forDocument, defaultDecode };
});
