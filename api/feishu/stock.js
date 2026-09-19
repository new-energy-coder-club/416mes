/**
 * POST /api/feishu/stock — 库存直写飞书（云端版）
 *
 * 与本地 feishu-server.mjs 的同名接口语义一致，但底层用应用凭证调飞书 REST，
 * 因此云端部署自己就能写，不需要本机跑服务、不需要 lark-cli。
 *
 * 请求体：{ matCode, qty?, delta?, opId?, operator?, type?, reason?, ref?, dryRun? }
 * 响应：  { ok:true, seq, balance, duplicate? } | { ok:false, error, warning? }
 *
 * qty 与 delta 至少给一个：**多设备并发时请给 delta**（服务端按「当前值 + delta」
 * 并结合账本收敛），给 qty 只是保留给旧调用方的兼容路径。
 *
 * 前端 fsPushStock() 在同一个源下 POST 到这里；失败则进离线队列，恢复后重放。
 * 重放会带上同一个 opId，服务端按「库存流水.操作ID」查重，不会重复记账。
 */
'use strict';
const { writeStock, setCors, readBody } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
  /* 2.50.1（审计 R7）：G3 物料台账只读归档后，页面层已无 MAT 写入口；服务端保留这个
     环境闸给部署方兜底——设 MAT_LEDGER_FROZEN=1 即彻底停写（审计/回放等只读不受影响）。 */
  if (process.env.MAT_LEDGER_FROZEN === '1') { res.status(503).json({ ok: false, error: 'MAT 数量账已冻结（MAT_LEDGER_FROZEN=1），存量只读' }); return; }

  try {
    const raw = await readBody(req);
    const p = JSON.parse(raw || '{}');
    if (!p.matCode) { res.status(400).json({ ok: false, error: '缺 matCode' }); return; }
    const hasQty = typeof p.qty === 'number' && isFinite(p.qty);
    const hasDelta = typeof p.delta === 'number' && isFinite(p.delta);
    if (!hasQty && !hasDelta) { res.status(400).json({ ok: false, error: '缺 qty 或 delta（至少给一个，多设备并发请用 delta）' }); return; }

    // dryRun=true 时只按表结构校验格式、不写任何数据（飞书没有 dry-run 接口，这里自己校验）
    const r = await writeStock(p);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    // 鉴权/权限/网络等异常：明确回错，让前端进入离线队列而不是静默丢弃
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
