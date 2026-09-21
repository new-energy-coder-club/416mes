/* scan-engine.js — 多码检测层：三级引擎链 + CDN/本地兜底加载器（UMD 双端）
 *
 * P1-1（摄像头扫码算法优化方案 §4）：
 *   引擎链（每级返回 [{text, format, box?}]，全部未命中返回 []）：
 *     1. 原生 BarcodeDetector（'BarcodeDetector' in window + getSupportedFormats 校验，
 *        安卓零体积、系统级多码；iOS/桌面 Windows 无 → 自动跳过）
 *     2. zxing-wasm reader（IIFE window.ZXingWASM.readBarcodes，maxNumberOfSymbols:8，
 *        tryDownscale，喂 540p 降采样帧；wasm 走 CDN 优先 + 本地 vendor 兜底）
 *     3. 现有 jsQR + ItemBarcode（离线兜底，原逻辑原样保留）
 *   上一级抛错/不可用自动降下一级并记 engineName；第 3 级永不离线失效。
 *
 *   加载策略（§5）：首次 open() 后台预热（不阻塞取流与第 3 级解码）；
 *   loadScriptWithFallback(urls[], 5s 超时竞速)；wasm 路径经 setZXingModuleOverrides
 *   locateFile 指向本地 vendor。全部失败静默降级到第 3 级。
 *
 * 一切可注入：opts.decodeAll 直接替换整条链（Node 测试用假引擎）；
 * opts.multiEngine='off' 一键回到纯第 3 级（P0 现状语义）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScanEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CDN_JS = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.4/dist/iife/reader/index.js';
  const CDN_WASM_DIR = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.4/dist/reader/';
  const LOCAL_JS = 'vendor/zxing-wasm-iife-reader-3.1.4.js';
  const LOCAL_WASM_DIR = 'vendor/';
  /* BarcodeDetector 请求的格式（二维码 + 常见一维码；getSupportedFormats 二次校验交集）。 */
  const WANTED_FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_93', 'codabar', 'itf', 'data_matrix', 'pdf417', 'aztec'];

  /* 动态 <script> 逐个尝试：任一成功 resolve(true)，全部失败/超时 resolve(false)。
     可注入 doc（Node 测试传假 document）。 */
  function loadScriptWithFallback(doc, urls, timeoutMs) {
    const u = (urls || []).slice();
    const t = timeoutMs || 5000;
    return new Promise(resolve => {
      if (!u.length || !doc || !doc.createElement) return resolve(false);
      let settled = false;
      const done = ok => { if (!settled) { settled = true; resolve(ok); } };
      const tryNext = () => {
        if (!u.length) return done(false);
        const url = u.shift();
        let el;
        try { el = doc.createElement('script'); } catch (_) { return done(false); }
        if (!el || !el.addEventListener) return done(false);
        let timer = null;
        const onOk = () => { if (timer) clearTimeout(timer); done(true); };
        const onErr = () => { if (timer) clearTimeout(timer); tryNext(); };
        try {
          el.addEventListener('load', onOk, { once: true });
          el.addEventListener('error', onErr, { once: true });
          el.src = url;
          (doc.head || doc.body || doc.documentElement || doc).appendChild(el);
          timer = setTimeout(() => { try { el.remove(); } catch (_) {} tryNext(); }, t);
        } catch (_) { tryNext(); }
      };
      tryNext();
    });
  }

  /* 第 3 级：现有 jsQR + ItemBarcode（原 P0 逻辑原样保留，单结果 → 数组化）。 */
  function legacyLevel(win) {
    return async function legacyDecode(image) {
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

  /* 构造三级引擎链。opts：
     { win, document, multiEngine('on'/'off'), formats?, onEngineName(name)? }
     返回 { decodeAll(image), warmUp(), engineName() }。 */
  function createChain(opts) {
    const win = opts.win || {};
    const doc = opts.document || (win.document) || null;
    const multi = opts.multiEngine !== 'off';
    const legacy = legacyLevel(win);
    let engineName = 'jsQR+ItemBarcode';
    let detector = null, detectorFailed = false;
    let zxingReady = false, zxingLoading = null;
    const onName = typeof opts.onEngineName === 'function' ? opts.onEngineName : null;

    function setName(n) { engineName = n; if (onName) { try { onName(n); } catch (_) {} } }

    /* 第 1 级：原生 BarcodeDetector。特性探测 + getSupportedFormats 交集校验。 */
    function getDetector() {
      if (detector || detectorFailed) return detector;
      try {
        if (typeof win.BarcodeDetector !== 'function') { detectorFailed = true; return null; }
        let supported = null;
        try { supported = win.BarcodeDetector.getSupportedFormats && win.BarcodeDetector.getSupportedFormats(); } catch (_) {}
        const formats = Array.isArray(supported)
          ? WANTED_FORMATS.filter(f => supported.indexOf(f) >= 0)
          : WANTED_FORMATS.slice();
        if (!formats.length) { detectorFailed = true; return null; }
        detector = new win.BarcodeDetector({ formats });
        return detector;
      } catch (_) { detectorFailed = true; return null; }
    }

    /* BarcodeDetector 需要 canvas/ImageBitmap；Node 测试注入的 image 是 {width,height,data}
       时 detect(imageData) 也可（安卓实现接受 ImageData），不行就抛错降级。 */
    async function detectAll(image) {
      const d = getDetector();
      if (!d) return null;   // 不可用：返回 null 让链降级
      const list = await d.detect(image.data ? image : (image.canvas || image));
      if (!Array.isArray(list) || !list.length) return [];
      return list.map(r => ({
        text: String(r.rawValue != null ? r.rawValue : (r.displayValue || '')),
        format: (r.format === 'qr_code' ? '二维码' : (r.format || '条码')),
        box: r.boundingBox ? { x: r.boundingBox.x, y: r.boundingBox.y, w: r.boundingBox.width, h: r.boundingBox.height } : undefined
      })).filter(r => r.text);
    }

    /* 第 2 级：zxing-wasm。未就绪返回 null 让链降级（预热完成前用户无感走第 3 级）。 */
    async function zxingAll(image) {
      if (!zxingReady) return null;
      try {
        const Z = win.ZXingWASM;
        if (!Z || typeof Z.readBarcodes !== 'function') { zxingReady = false; return null; }
        const results = await Z.readBarcodes(image, {
          tryDownscale: true,
          maxNumberOfSymbols: 8,
          formats: opts.zxingFormats || ['qrcode', 'code128', 'code39', 'ean13', 'ean8', 'upca', 'upce', 'code93', 'codabar', 'itf', 'datamatrix', 'pdf417', 'aztec']
        });
        if (!Array.isArray(results)) return [];
        return results.map(r => ({
          text: String(r.text != null ? r.text : ''),
          format: r.format === 'qrcode' ? '二维码' : (r.format || '条码'),
          box: r.position && r.position.topLeft ? (function () {
            const xs = [r.position.topLeft.x, r.position.topRight.x, r.position.bottomLeft.x, r.position.bottomRight.x];
            const ys = [r.position.topLeft.y, r.position.topRight.y, r.position.bottomLeft.y, r.position.bottomRight.y];
            const x = Math.min.apply(null, xs), y = Math.min.apply(null, ys);
            return { x, y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
          })() : undefined
        })).filter(r => r.text);
      } catch (_) { zxingReady = false; return null; }
    }

    /* 后台预热：CDN 优先 → 本地 vendor 兜底；wasm 路径 locateFile 同步指向本地
       （CDN js 加载成功但 wasm 拉取失败时，emscripten 会按 locateFile 重试本地）。 */
    async function warmUp() {
      if (!multi || zxingReady || zxingLoading) return zxingReady;
      zxingLoading = (async () => {
        try {
          const Z0 = win.ZXingWASM;
          if (Z0 && typeof Z0.readBarcodes === 'function') { zxingReady = true; return true; }
          /* wasm 路径回退：优先本地 vendor（离线可用），CDN 仅作在线加速。 */
          try {
            if (Z0 && typeof Z0.setZXingModuleOverrides === 'function') {
              Z0.setZXingModuleOverrides({ locateFile: (p, prefix) => {
                if (/\.wasm$/.test(p)) return LOCAL_WASM_DIR + p;
                return (prefix || '') + p;
              } });
            }
          } catch (_) {}
          const ok = await loadScriptWithFallback(doc, [CDN_JS, LOCAL_JS], 5000);
          if (!ok) return false;
          const Z = win.ZXingWASM;
          if (Z && typeof Z.readBarcodes === 'function') { zxingReady = true; return true; }
          return false;
        } catch (_) { return false; }
      })();
      try { return await zxingLoading; }
      catch (_) { return false; }
      finally { zxingLoading = null; }
    }

    /* decodeAll：按 1→2→3 顺序；null 表示该级不可用（降级），[] 表示该级确定无码。 */
    async function decodeAll(image) {
      if (!image || !image.width) return [];
      if (!multi) { setName('jsQR+ItemBarcode'); return legacy(image); }
      /* 第 1 级 */
      try {
        const r = await detectAll(image);
        if (r !== null) { setName('BarcodeDetector'); return r; }
      } catch (_) { /* 降级 */ }
      /* 第 2 级 */
      try {
        const r = await zxingAll(image);
        if (r !== null) { setName('zxing-wasm'); return r; }
      } catch (_) { /* 降级 */ }
      /* 第 3 级（永不离线失效） */
      setName('jsQR+ItemBarcode');
      return legacy(image);
    }

    return {
      decodeAll,
      warmUp,
      engineName: () => engineName,
      /* 测试钩子：直接置第 2 级就绪状态。 */
      _setZxingReady: v => { zxingReady = !!v; }
    };
  }

  return { createChain, loadScriptWithFallback, legacyLevel, CDN_JS, LOCAL_JS, CDN_WASM_DIR, LOCAL_WASM_DIR };
});
