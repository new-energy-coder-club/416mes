/**
 * GET /api/feishu/schema — 查看 8 张表的字段名与字段类型
 *
 * 用途：飞书多维表格的列有类型（文本/数字/日期/单选/人员…），写入格式必须匹配
 * （例如日期列要传毫秒时间戳）。这个接口用来确认每列的真实类型，避免盲写。
 *
 * 响应：{ ok:true, tables: { 物料台账: [{name,typeName,options}], ... } }
 */
'use strict';
const { tenantToken, listFields, TABLES, setCors } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  try {
    const token = await tenantToken();
    const out = {};
    for (const [key, tableId] of Object.entries(TABLES)) {
      try { out[key] = await listFields(token, tableId); }
      catch (e) { out[key] = { error: String((e && e.message) || e) }; }
    }
    res.status(200).json({ ok: true, tables: out });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
