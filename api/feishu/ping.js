/**
 * GET /api/feishu/ping — 存活与配置探测
 * 响应：{ ok:true, feishu:boolean, base:boolean }
 *   feishu=false 表示缺少 FEISHU_APP_ID / FEISHU_APP_SECRET
 */
'use strict';
const { setCors, BASE_TOKEN } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  res.status(200).json({
    ok: true,
    feishu: !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET),
    base: !!BASE_TOKEN,
    via: 'tenant_access_token',
    at: new Date().toISOString()
  });
};
