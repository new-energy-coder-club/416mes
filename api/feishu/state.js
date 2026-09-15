/**
 * GET /api/feishu/state — 全量拉取 8 表（云端版）
 *
 * 与本地 feishu-server.mjs 的 /api/feishu/state 同构，前端 fsBoot() 先试同源，
 * 因此在云端部署上也能直接走通，不必依赖 Cloudflare 隧道。
 *
 * 响应：{ ok:true, state, pulledAt } | { ok:false, error }
 * 读取失败一律返回非 200 —— 绝不能把「拉取失败」伪装成「飞书表是空的」。
 */
'use strict';
const { pullState, setCors } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }

  try {
    const state = await pullState();
    res.status(200).json({ ok: true, state, pulledAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
