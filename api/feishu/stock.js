/**
 * POST /api/feishu/stock — 库存直写飞书（云端版）
 *
 * 与本地 feishu-server.mjs 的同名接口语义一致，但底层用应用凭证调飞书 REST，
 * 因此云端部署自己就能写，不需要本机跑服务、不需要 lark-cli。
 *
 * 请求体：{ matCode, qty, delta?, operator?, type?, reason?, ref? }
 * 响应：  { ok:true, seq } | { ok:false, error }
 *
 * 前端 fsPushStock() 在同一个源下 POST 到这里；失败则进离线队列，恢复后重放。
 */
'use strict';
const { writeStock, setCors, readBody } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }

  try {
    const raw = await readBody(req);
    const p = JSON.parse(raw || '{}');
    if (!p.matCode) { res.status(400).json({ ok: false, error: '缺 matCode' }); return; }
    if (typeof p.qty !== 'number' || !isFinite(p.qty)) { res.status(400).json({ ok: false, error: '缺 qty（必须是数字）' }); return; }

    // dryRun=true 时只按表结构校验格式、不写任何数据（飞书没有 dry-run 接口，这里自己校验）
    const r = await writeStock(p);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    // 鉴权/权限/网络等异常：明确回错，让前端进入离线队列而不是静默丢弃
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
