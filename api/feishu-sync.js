/**
 * GET /api/feishu-sync — 【兼容保留】旧的全量读接口
 *
 * 这个接口与 /api/feishu/state 功能完全重复，已改为直接复用 lib/feishu-api.js，
 * 避免两份实现漂移。新代码请用 /api/feishu/state。
 *
 * 保留原因：线上可能还有旧页面缓存 / 外部脚本在调它。
 */
'use strict';
const { pullState, setCors } = require('../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  try {
    const state = await pullState();
    // 保持旧响应形态（无 ok 字段、带 deviceId），避免调用方解析失败
    res.status(200).json({ state, deviceId: 'feishu-cloud', pulledAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
