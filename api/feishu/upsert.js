/**
 * POST /api/feishu/upsert — 8 张表通用的「按业务键新建或更新」
 *
 * 请求体：{ table: 'materials'|'members'|'workorders'|…, records: [本地对象, …], dryRun?:boolean }
 * 响应：  { ok:true, created, updated, dropped:[表里没有的列], droppedColumns:{列:原因} }
 *   dryRun=true 时只回报 wouldCreate / wouldUpdate，不写任何数据。
 *
 * 设计要点：按飞书表结构过滤字段 —— 表里没有的列直接丢掉并在 dropped 里回报，
 * 而不是让整批失败。这样工单记录缺「执行批次」列时其余字段照常同步。
 */
'use strict';
const { upsertRecords, setCors, readBody } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  try {
    const p = JSON.parse((await readBody(req)) || '{}');
    if (!p.table) { res.status(400).json({ ok: false, error: '缺 table' }); return; }
    if (!Array.isArray(p.records) || !p.records.length) { res.status(400).json({ ok: false, error: '缺 records（非空数组）' }); return; }
    /* clearFields：本地字段名数组，表示「这几列要显式清空」。
       没有它就没法把「当前库位码」这类字段清掉（空值默认不写，避免静默抹掉飞书的值）。 */
    const r = await upsertRecords(p.table, p.records, { dryRun: !!p.dryRun, clearFields: Array.isArray(p.clearFields) ? p.clearFields : [] });
    if (r.error) { res.status(400).json({ ok: false, error: r.error }); return; }
    res.status(200).json({ ok: true, table: p.table, ...r });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
