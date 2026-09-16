/**
 * GET/POST /api/feishu/nextcode — 工单取号（只读，不写任何数据）
 *
 * 为什么需要它：工单号计数器原来只在浏览器本地，另一台设备建过单本机不知道，
 * 两台设备同时建单会生成同一个工单号；而工单按业务键 upsert，
 * 结果不是「建了两张单」而是**两张单互相覆盖**。
 *
 * 请求：?prefix=LL20260915&type=LL
 * 响应：{ ok:true, prefix, max, next, source }
 *
 * 只读接口：search(工单号 desc, pageSize 500, filter 类型 is X) 取最大号，
 * 不产生任何写入，可以放心反复调。
 */
'use strict';
const { maxCodeSuffix, setCors, readBody } = require('../../lib/feishu-api.js');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    let p = {};
    if (req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      p = {
        prefix: u.searchParams.get('prefix') || '',
        type: u.searchParams.get('type') || '',
        column: u.searchParams.get('column') || undefined,
        typeColumn: u.searchParams.get('typeColumn') || undefined
      };
    } else if (req.method === 'POST') {
      p = JSON.parse((await readBody(req)) || '{}');
    } else {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }
    if (!p.prefix) { res.status(400).json({ ok: false, error: '缺 prefix（如 LL20260915）' }); return; }

    const r = await maxCodeSuffix(p);
    res.status(200).json(Object.assign({ ok: true }, r));
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
};
