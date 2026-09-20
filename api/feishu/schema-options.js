'use strict';
/* 2.62.0（审计 B-d）：飞书单选列缺选项的一键补齐端点。
 * 只允许「新增」单选选项（不改不删）；默认 dryRun——只返回将要追加的清单。
 * 同源标记必需（X-416mes-Same-Origin），与其它写接口一致。 */
const { setCors, assertSameOrigin, readBody, tenantToken, addSelectOptions, TABLES } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res, req);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  if (!assertSameOrigin(req, res)) return;

  try {
    const p = JSON.parse((await readBody(req)) || '{}');
    const table = String(p.table || '');
    const column = String(p.column || '');
    const options = (Array.isArray(p.options) ? p.options : []).map(x => String(x || '').trim()).filter(Boolean);
    const tableId = TABLES[table];
    if (!tableId) { res.status(400).json({ ok: false, error: '未知表：' + table }); return; }
    if (!column || !options.length) { res.status(400).json({ ok: false, error: '缺 column 或 options' }); return; }

    const token = await tenantToken();
    if (p.dryRun) {
      res.status(200).json({ ok: true, dryRun: true, table, column, wouldAdd: options });
      return;
    }
    const r = await addSelectOptions(token, tableId, column, options);
    res.status(200).json({ ok: true, added: r.added, table, column });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
};
