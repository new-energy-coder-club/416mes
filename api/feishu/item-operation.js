'use strict';
const { createRuntime } = require('../../lib/item-runtime');
const { readBody, setCors } = require('../../lib/feishu-api');
function handlerFor(service) {
  return async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!['POST', 'GET'].includes(req.method)) return res.status(405).json({ ok: false, error: 'method not allowed' });
    try {
      if (req.method === 'GET' && req.query && req.query.action === 'capabilities') return res.status(200).json({ ok: true, mode: service.mode || 'strict', authentication: service.mode === 'feishu-trial' ? 'none' : 'required', concurrency: service.mode === 'feishu-trial' ? 'best-effort-single-operator' : 'strict', notice: '试运行请一次只操作一条，等待结果后再继续；未知结果不要重新提交。' });
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
  : createRuntime({ mode });
module.exports = handlerFor(service);
module.exports.handlerFor = handlerFor;
