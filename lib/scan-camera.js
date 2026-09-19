/* scan-camera.js — 统一扫码浮层（查询/作业/后续扫码工作台共用，UMD 双端）
 *
 * 解决的问题（用户实测反馈）：
 *   · ITM 页把 <video> 直接嵌在页面下方，体验差；现统一为全屏浮层（复用扫码工作台
 *     cam-overlay 的视觉/焦点/ESC/错误常驻模式）。
 *   · 扫到码直接执行 —— 现统一弹确认卡：显示码制/码值/对象摘要，点「确定填入」才回调。
 *   · 每帧解码失败被静默吞掉 —— 现有「正在识别 / 暂未识别」可见状态。
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

    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext && canvas.getContext('2d', { willReadFrequently: true });
    const intervalMs = opts.intervalMs == null ? 250 : opts.intervalMs;
    let stream = null, timer = null, generation = 0, current = null, awaiting = false;
    let misses = 0, missNotified = false;
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

    /* 关闭：任何路径统一收口。confirmed 不算取消（不触发 onCancel）。 */
    function close(reason) {
      generation++; clearTimeout(timer); timer = null;
      const had = !!current; const wasConfirmed = reason === 'confirmed';
      const unconfirmed = wasConfirmed ? null : lastDetected;
      lastDetected = null;
      stopStream();
      overlay.style.display = 'none';
      confirmBox.hidden = true;
      const opts = current; current = null; awaiting = false; pendingReset();
      if (had && !wasConfirmed && opts && opts.onCancel) opts.onCancel(reason || 'closed', unconfirmed);
    }

    function pendingReset() { misses = 0; missNotified = false; seen = new Map(); selectedText = ''; selectedToken = undefined; }

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

    function captureFrame() {
      if (!video.videoWidth) return null;
      if (opts.capture) return opts.capture(video);
      if (!ctx) return null;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    function loop(myGen) {
      if (myGen !== generation || !stream) return;
      timer = setTimeout(async () => {
        if (myGen !== generation || !stream) return;
        const image = captureFrame();
        const captured = current.captureToken ? current.captureToken() : undefined;
        if (image) {
          try {
            const hit = await decode(image);
            if (myGen !== generation || !stream) return;   // 迟到结果丢弃
            /* 确认卡打开期间继续识别其它码 → 汇入候选；同码连续帧去重不重复弹。 */
            if (hit && hit.text && !seen.has(hit.text)) { misses = 0; missNotified = false; showConfirm(hit, captured); }
            else if (hit && hit.text && seen.has(hit.text)) { misses = 0; }
          } catch (_) { /* 解码异常按本帧未命中处理 */ }
          misses++;
          if (misses >= 12 && !missNotified) {   // ~3 秒无命中给一次可见提示，不刷屏
            missNotified = true;
            setStatus('暂未识别到码，请对准后稍等；支持二维码与常见一维条形码');
          }
        }
        loop(myGen);
      }, intervalMs);
    }

    async function open(openOpts) {
      close('reopen');   // 已有会话（查询/作业互相挤占）先停掉，不共享摄像头
      generation++;
      const myGen = generation;
      current = openOpts; awaiting = false; pendingReset();
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
