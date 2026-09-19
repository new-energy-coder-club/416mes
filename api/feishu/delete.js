/**
 * POST /api/feishu/delete — 8 张表通用的「按业务键删除」
 *
 * 请求体：{ table: 'materials'|…, keys: ['GJ-001', …] }
 * 响应：  { ok:true, deleted }
 */
'use strict';
const { deleteRecords, setCors, assertSameOrigin, readBody } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  if (!assertSameOrigin(req, res)) return;   /* 2.50.2 同源标记（审计 I-B6） */
  try {
    const p = JSON.parse((await readBody(req)) || '{}');
    if (!p.table) { res.status(400).json({ ok: false, error: '缺 table' }); return; }
    if (!Array.isArray(p.keys) || !p.keys.length) { res.status(400).json({ ok: false, error: '缺 keys（非空数组）' }); return; }
    const r = await deleteRecords(p.table, p.keys);
    if (r.error) { res.status(400).json({ ok: false, error: r.error }); return; }
    res.status(200).json({ ok: true, table: p.table, ...r });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
