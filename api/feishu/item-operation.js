'use strict';
const { createRuntime } = require('../../lib/item-runtime');
const { readBody, setCors } = require('../../lib/feishu-api');
function handlerFor(service) {
  return async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!['POST', 'GET'].includes(req.method)) return res.status(405).json({ ok: false, error: 'method not allowed' });
    try {
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
// No environment-only switch can turn an unverified in-memory lock into shared coordination.
// Deployment must supply a reviewed adapter and server-authenticated principal. Default denies.
const service = createRuntime({ enabled: false, authenticate: async () => null });
module.exports = handlerFor(service);
module.exports.handlerFor = handlerFor;
