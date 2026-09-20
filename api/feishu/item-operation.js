'use strict';
const { createRuntime } = require('../../lib/item-runtime');
const { readBody, setCors, assertSameOrigin } = require('../../lib/feishu-api');

/* 2.63.0 Phase D-2（最小身份）：环境变量 ITM_OPERATOR_TOKENS（JSON：token→{id,roles}）。
 * 配置后，POST 必须带 X-416MES-Token，操作人记为映射的真实 id，admin/operator 分权激活；
 * 未配置则维持试运行行为（trial-unverified）。共享 token 是防误不防恶意——正式多用户
 * 走飞书 OAuth（ITM_RUNTIME.md 长期方案）。 */
const OPERATOR_TOKENS = (() => {
  try { return JSON.parse(process.env.ITM_OPERATOR_TOKENS || '{}'); } catch (e) { return {}; }
})();
function authenticateFromToken(req) {
  const tok = req.headers && req.headers['x-416mes-token'];
  if (tok && OPERATOR_TOKENS[tok]) {
    const m = OPERATOR_TOKENS[tok];
    if (m && m.id && Array.isArray(m.roles)) return { id: String(m.id), roles: m.roles.map(String) };
    return null;
  }
  if (tok) return null;                                        // 带了 token 但无效 → 拒绝
  if (Object.keys(OPERATOR_TOKENS).length === 0) {
    return { id: 'trial-unverified', roles: ['admin', 'operator'], unverified: true };   // 未配置身份 → 兼容试运行
  }
  return null;                                                 // 已配置身份但请求未带 → 必须带
}

function handlerFor(service) {
  return async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!['POST', 'GET'].includes(req.method)) return res.status(405).json({ ok: false, error: 'method not allowed' });
    if (req.method === 'POST' && !assertSameOrigin(req, res)) return;   /* 2.50.2 同源标记（审计 I-B6；GET 只读豁免） */
    const identity = authenticateFromToken(req);
    try {
      if (req.method === 'GET' && req.query && req.query.action === 'capabilities') return res.status(200).json({ ok: true, mode: service.mode || 'strict', authentication: Object.keys(OPERATOR_TOKENS).length ? 'token' : (service.mode === 'feishu-trial' ? 'none' : 'required'), concurrency: service.mode === 'feishu-trial' ? 'entity-scoped-best-effort' : 'strict', notice: '试运行请一次只操作一条，等待结果后再继续；未知结果不要重新提交。' });
      let result;
      if (req.method === 'GET') result = await service.get(req, req.query && req.query.opId);
      else {
        const body = JSON.parse((await readBody(req)) || '{}');
        result = await service.post(req, body);
      }
      return res.status(200).json({ ok: true, operation: result });
    } catch (e) { return res.status(e.status || 400).json({ ok: false, error: e.message }); }
  };
}
const mode = require('../../lib/item-mode').currentMode();
const service = mode === 'disabled'
  ? createRuntime({ mode: 'strict' })
  : createRuntime({ mode, authenticate: authenticateFromToken });
module.exports = handlerFor(service);
module.exports.handlerFor = handlerFor;
