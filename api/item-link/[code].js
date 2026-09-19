'use strict';
/**
 * GET /api/item-link/:code — 物品二维码短链转跳端点（v1：纯本地解码，不依赖飞书）
 *
 * 二维码内容 https://mes.newenergycoder.club/i/XXXXXXXX → 302 到网页端物品详情
 * （index.html#item/WP-xxx，启动深链由前端处理）。结构化短码本地可解，飞书宕机也能跳。
 * 解码失败/未知码 → 404 提示页（不泄露内部结构）。?to=feishu 变体留待 v2。
 */
const { decode, toItemCode } = require('../../lib/item-link');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).end('Method Not Allowed'); return; }
  const code = (req.query && req.query.code) || '';
  const itemCode = toItemCode(decode(code));
  if (itemCode) {
    res.setHeader('Cache-Control', 'public, max-age=3600');   // 码值永不变，可缓存
    res.status(302).setHeader('Location', '/index.html#item/' + encodeURIComponent(itemCode)).end();
    return;
  }
  res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8').end(
    '<!doctype html><meta charset="utf-8"><title>未找到物品</title>' +
    '<body style="font-family:sans-serif;padding:24px;text-align:center">' +
    '<h3>未找到对应物品</h3><p>这个二维码可能已作废或印刷有误，请联系管理员核对物品标签。</p></body>');
};
