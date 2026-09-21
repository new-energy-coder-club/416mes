/* scan-decode-worker.js — 解码 Worker（classic script，无构建，双端兼容写法）
 *
 * P1-4（摄像头扫码算法优化方案 §4）：worker 线程内跑解码引擎，主线程只做
 * drawImage + getImageData + transferable postMessage，解码期间页面不卡。
 *
 * 引擎（worker 内，与主线程链互斥）：
 *   · zxing-wasm IIFE（importScripts **绝对路径** /vendor/... —— Worker 没有相对
 *     文档基准，相对路径会 404）；wasm 经 setZXingModuleOverrides({locateFile})
 *     指回 /vendor/。加载失败静默降级，只用 jsQR。
 *   · jsQR 兜底（importScripts /jsqr.min.js；失败则整个 worker 报 error 回退主线程）。
 *   · BarcodeDetector 不在 worker 里用（主线程链独占，见 lib/scan-engine.js）。
 *
 * 消息协议：
 *   主 → worker：{id, image:{width, height, data:ArrayBuffer}}（transferable 转移）
 *   worker → 主：{id, hits:[{text, format, box?}]}  或  {id, error: '...'}
 * 主线程按 id 匹配请求、迟到 id 丢弃（generation 在相机侧守）。
 *
 * 双端兼容：typeof importScripts === 'function' 时走 Worker 全局；
 * Node 端（node --test 注入假 Worker 类时不会真执行本文件，但允许 require 做语法/导出检查）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScanDecodeWorkerMain = factory();   // 浏览器主线程不直接挂全局，仅防御
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Worker 全局脚本主体：typeof importScripts === 'function' 即判定为 Worker 环境。 */
  if (typeof importScripts === 'function' && typeof postMessage === 'function' &&
      typeof onmessage !== 'undefined') {
    let zxingReady = false, zxingFailed = false;
    let jsqrReady = false;

    /* 引擎加载（全部静默降级：zxing 失败→jsQR；jsQR 也失败→每条消息回 error）。 */
    try { importScripts('/jsqr.min.js'); jsqrReady = (typeof jsQR === 'function'); }
    catch (_) { jsqrReady = false; }
    try {
      importScripts('/vendor/zxing-wasm-iife-reader-3.1.4.js');
      if (typeof ZXingWASM === 'object' && ZXingWASM && typeof ZXingWASM.readBarcodes === 'function') {
        try {
          if (typeof ZXingWASM.setZXingModuleOverrides === 'function') {
            ZXingWASM.setZXingModuleOverrides({ locateFile: p => '/vendor/' + p });
          }
        } catch (_) {}
        zxingReady = true;
      } else { zxingFailed = true; }
    } catch (_) { zxingFailed = true; }

    function jsqrDecode(image) {
      const out = [];
      if (!jsqrReady) return out;
      try {
        const qr = jsQR(image.data, image.width, image.height);
        if (qr && qr.data) out.push({ text: qr.data, format: '二维码' });
      } catch (_) { /* 本帧无二维码 */ }
      return out;
    }

    async function zxingDecode(image) {
      const results = await ZXingWASM.readBarcodes(image, {
        tryDownscale: true,
        maxNumberOfSymbols: 8,
        formats: ['qrcode', 'code128', 'code39', 'ean13', 'ean8', 'upca', 'upce', 'code93', 'codabar', 'itf', 'datamatrix', 'pdf417', 'aztec']
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
    }

    onmessage = async function (ev) {
      const msg = ev && ev.data;
      if (!msg || typeof msg.id !== 'number' || !msg.image) return;
      const id = msg.id;
      try {
        const image = msg.image;
        if (!(image.data instanceof Uint8ClampedArray) && image.data && image.data.buffer) {
          image.data = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset || 0, image.data.byteLength);
        }
        let hits = null;
        if (zxingReady && !zxingFailed) {
          try { hits = await zxingDecode(image); }
          catch (_) { zxingFailed = true; hits = null; }
        }
        if (hits === null) hits = jsqrDecode(image);
        postMessage({ id, hits });
      } catch (e) {
        try { postMessage({ id, error: String((e && e.message) || e) }); }
        catch (_) { /* 连错误都发不出就静默 */ }
      }
    };

    return {};   // Worker 环境：模块导出为空对象（逻辑全在 onmessage）
  }

  /* Node 端导出（测试/语法检查用）：Worker 脚本源码路径提示。 */
  return { WORKER_PATH: 'lib/scan-decode-worker.js' };
});
