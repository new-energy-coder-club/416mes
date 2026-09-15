/**
 * POST /api/feishu/reconcile — 8 张表的「本地 vs 飞书」只读差异核查
 *
 * 请求体：{ state: { materials:[…], members:[…], … } }   网页端把本地 8 张表发过来
 * 响应：  { ok:true, report: { summary, tables: { materials:{…}, … } } }
 *
 * 这个接口**绝不写数据**，可以放心在生产上反复调。它回答三个问题：
 *   1. 飞书表里缺哪些列？（缺的列，网页端怎么改都同步不上去）
 *   2. 哪些单选值飞书没这个选项？（写了会被丢掉 —— 例如工单「部分执行」）
 *   3. 哪些记录只在一侧？（localOnly = 还没推上去；remoteOnly = 该拉下来）
 */
'use strict';
const { reconcile, setCors, readBody } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  try {
    const p = JSON.parse((await readBody(req)) || '{}');
    const report = await reconcile(p.state || {});
    res.status(200).json({ ok: true, report });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
