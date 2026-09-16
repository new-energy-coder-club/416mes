/**
 * POST /api/feishu/incremental — Phase 2 增量协议（只读）
 *
 * 三层读路径，全部只读、不写任何数据：
 *   ① mode=probe   8 表廉价变更探测（每表 pageSize=1，合计约 1KB）
 *   ② mode=pull    按「最后更新时间 desc」只拉变了的行（倒序翻页到水位）
 *   ③ mode=census  键集合对账（翻完全表只取业务主键，用于发现飞书侧硬删）
 *
 * 请求体：
 *   { mode:'probe' }
 *   { mode:'pull',   table:'transactions', watermark:{ts,seen} }
 *   { mode:'census', table:'materials' }
 *
 * 为什么只用 sort 不用 filter：实测飞书 filter 的日期比较 5 种写法全部失败，
 * 而 sort 在文本与日期（含系统字段 1002）上都被验证可用。
 */
'use strict';
const { probeAllChanges, probeTableChange, pullChangesBySort, censusTable, setCors, readBody, tenantToken, TABLES } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }

  try {
    const p = JSON.parse((await readBody(req)) || '{}');
    const mode = p.mode || 'probe';

    if (mode === 'probe') {
      if (p.table) {
        if (!TABLES[p.table]) { res.status(400).json({ ok: false, error: '未知的表：' + p.table }); return; }
        const token = await tenantToken();
        const one = await probeTableChange(token, TABLES[p.table]);
        res.status(200).json({ ok: true, mode, tables: { [p.table]: one } });
        return;
      }
      res.status(200).json({ ok: true, mode, report: await probeAllChanges() });
      return;
    }

    if (mode === 'pull') {
      if (!p.table) { res.status(400).json({ ok: false, error: '缺 table' }); return; }
      const r = await pullChangesBySort(p.table, p.watermark || { ts: 0, seen: [] }, { pageSize: p.pageSize, maxPages: p.maxPages });
      // raw 里的飞书原始字段不返回给前端（体积大且前端不用），只回报计数
      res.status(200).json({
        ok: true, mode, table: p.table, watermark: r.watermark,
        records: r.records, count: r.records.length, pages: r.pages,
        complete: r.complete, reason: r.reason, columns: r.columns
      });
      return;
    }

    if (mode === 'census') {
      if (!p.table) { res.status(400).json({ ok: false, error: '缺 table' }); return; }
      const r = await censusTable(p.table, { pageSize: p.pageSize });
      res.status(r.error ? 502 : 200).json(Object.assign({ ok: !r.error, mode, table: p.table }, r));
      return;
    }

    res.status(400).json({ ok: false, error: '未知 mode：' + mode + '（应为 probe / pull / census）' });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
