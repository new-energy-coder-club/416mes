/**
 * GET /api/feishu/changes — 变更检测能力探测（只读）
 *
 * 回答一个决定架构走向的问题：**飞书能不能廉价地告诉我们「有没有变过」？**
 *
 *   能 → 大数据量下可以先发一个几毫秒的探测，只有真变了才拉全量/增量
 *   不能 → 只能定时全量拉，数据一多就撑不住（现在的方案就是这种）
 *
 * 做法：对 8 张表各试一次 records/search，看排序参数是否被支持、
 * 有没有「最后更新时间」这类可排序的时间字段。
 *
 * **只读**：只调用 search / 读表结构，不写任何数据。
 * 响应：{ ok:true, report:{ tables: { materials:{…}, … } } }
 */
'use strict';
const { probeChangeDetection, dumpSearchShape, setCors } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  try {
    // ?dump=1 只转储一张表的原始 search 报文，用来确认参数是否被尊重（诊断用，只读）
    if (req.query && req.query.dump) { res.status(200).json({ ok: true, dump: await dumpSearchShape() }); return; }
    const report = await probeChangeDetection();
    res.status(200).json({ ok: true, report });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
