/**
 * GET /api/feishu/debug?table=members — 分阶段诊断 upsert 到底在哪一步失败
 *
 * 起因：members / workorders 的 upsert 返回 502 且**响应体为空**，说明函数在返回
 * JSON 之前就挂了（超时或未捕获异常），而不是走到我的错误处理。这个接口把每一步
 * 单独 try 起来并计时，用来定位。
 *
 * 只在需要排查时用；确认问题后可以删除。
 */
'use strict';
const lib = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  lib.setCors(res);
  const out = { steps: [], ok: true };
  const t0 = Date.now();
  const step = async (name, fn) => {
    const s = Date.now();
    try {
      const v = await fn();
      out.steps.push({ step: name, ms: Date.now() - s, ok: true, info: v });
      return v;
    } catch (e) {
      out.steps.push({ step: name, ms: Date.now() - s, ok: false, error: String((e && e.message) || e) });
      out.ok = false;
      throw e;
    }
  };

  const table = (new URL(req.url, 'http://x')).searchParams.get('table') || 'members';
  try {
    const token = await step('tenantToken', () => lib.tenantToken());
    const tableId = lib.TABLES[table];
    out.table = table; out.tableId = tableId;
    if (!tableId) throw new Error('未知表：' + table);

    const fields = await step('listFields', () => lib.listFields(token, tableId));
    out.fieldNames = fields.map(f => f.name + '[' + f.typeName + ']');

    const rows = await step('listRecords', () => lib.listRecords(token, tableId));
    out.rowCount = rows.length;

    const def = lib.TABLE_DEFS[table];
    const sample = rows[0];
    const built = def.up(def.down(sample.fields));
    out.built = built;
    out.builtTypes = Object.fromEntries(Object.entries(built).map(([k, v]) => [k, v === null ? 'null' : typeof v]));

    // 只保留表里真实存在的列
    const names = fields.map(f => f.name);
    const filtered = {};
    Object.entries(built).forEach(([k, v]) => { if (names.includes(k) && v !== null && v !== undefined) filtered[k] = v; });
    out.filtered = filtered;
    out.droppedColumns = Object.keys(built).filter(k => !names.includes(k));

    await step('batchUpdate', () => lib.batchUpdate(token, tableId, [{ record_id: sample.record_id, fields: filtered }]));

    out.totalMs = Date.now() - t0;
    res.status(200).json(out);
  } catch (e) {
    out.totalMs = Date.now() - t0;
    out.fatal = String((e && e.message) || e);
    res.status(200).json(out);   // 诊断接口一律 200，避免又变成空体 502
  }
};
