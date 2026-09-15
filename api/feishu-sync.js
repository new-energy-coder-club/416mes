/**
 * GET /api/feishu-sync — 416MES 云端实时同步接口
 * 读取飞书多维表后端全部 8 张表，输出与「导出备份 JSON」同构的 { state: {...} }，
 * 网页端「☁️ 云端同步」按钮 / 打开页面自动同步调用本接口后走与「导入合并」相同的合并逻辑。
 *
 * 环境变量（Vercel Project Settings → Environment Variables）：
 *   FEISHU_APP_ID      自建应用 App ID（cli_xxx）
 *   FEISHU_APP_SECRET  自建应用 App Secret
 * 应用需具备 base:record:read 权限，且已加入该 Base。
 */

const BASE_TOKEN = 'NpWBb0RXYayqfosYqnScWdlDnMb';
const TABLES = {
  materials: 'tblorMKz5gejPLLj',    // 物料台账
  locations: 'tblI4J48v6GvLZZ2',    // 库位
  containers: 'tblf726XegK4za9v',   // 容器
  members: 'tblsGk6xsuc8Kw16',      // 人员
  items: 'tblpq4NZYc0H1Npk',        // 物品
  manuals: 'tblPHdO374WlnoAk',      // 手册
  workorders: 'tbl2kiNypgfXR7aY',   // 工单记录
  transactions: 'tblQti83n32djsiB'  // 库存流水
};

/* ---------- 与 feishu-sync.mjs 一致的字段归一化 ---------- */
const pad = (n, w) => String(n).padStart(w, '0');
function T(v) { if (v == null) return ''; if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : ((x && (x.text || x.name)) || '')).join(''); return String(v); }
function N(v) { if (v == null || v === '') return 0; const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function toDate(v) {
  if (v == null || v === '') return null;
  const d = (typeof v === 'number' || /^\d+$/.test(String(v))) ? new Date(N(v)) : new Date(v);
  return isNaN(d) ? null : d;
}
function D(v) { const d = toDate(v); return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) : ''; }
function DT(v) { const d = toDate(v); return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) : ''; }

const WIP_TYPE_CODES = { 'LL 领料': 'LL', 'BH 补货': 'BH', 'JH 拣货': 'JH', 'TL 退料': 'TL' };
const DOWN = {
  materials: f => ({ code: T(f['物料码']), name: T(f['名称']), spec: T(f['规格型号']), xy: T(f['闲鱼XY编号']), loc: T(f['当前库位码']), container: T(f['容器码']), qty: N(f['库存数量']), minQty: N(f['安全库存']), cost: N(f['成本']) }),
  locations: f => ({ code: T(f['库位码']), kind: T(f['类型']), desc: T(f['说明']), grants: T(f['授权人员']) }),
  containers: f => ({ code: T(f['容器码']), type: T(f['容器类型']), spec: T(f['规格']), loc: T(f['当前库位码']) }),
  members: f => ({ code: T(f['编号']), name: T(f['姓名']), sid: T(f['学号']), dept: T(f['部门/SIG']), role: T(f['职务']) || '成员', phone: T(f['电话']), note: T(f['备注']), group: T(f['标签']) }),
  items: f => ({ code: T(f['物品码']), name: T(f['名称']), spec: T(f['规格型号']), loc: T(f['库位码']) }),
  manuals: f => ({ code: T(f['手册码']), name: T(f['名称']), ver: T(f['版本']), loc: T(f['库位码']) }),
  workorders: f => ({
    code: T(f['工单号']), type: WIP_TYPE_CODES[T(f['类型'])] || T(f['类型']) || 'LL', date: D(f['日期']),
    status: T(f['状态']) || '未执行', execTime: DT(f['执行时间']),
    items: T(f['明细']).split(';').map(s => s.trim()).filter(Boolean).map(s => { const m = s.match(/^(.+?)[x×](\d+(?:\.\d+)?)$/); return m ? { matCode: m[1], qty: +m[2] } : null; }).filter(Boolean)
  }),
  transactions: f => {
    const d = toDate(f['时间']);
    return {
      seq: parseInt(T(f['流水号']).replace('#', ''), 10) || null,
      ts: d ? d.toISOString() : '',
      time: d ? d.toLocaleString() : '',
      device: 'feishu', operator: T(f['操作人']), type: T(f['类型']), matCode: T(f['物料码']),
      delta: N(f['变动']), balance: f['余量'] == null ? '' : N(f['余量']), ref: T(f['关联单']), reason: T(f['原因/备注'])
    };
  }
};

/* ---------- 飞书 API ---------- */
async function tenantToken() {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('获取 tenant_access_token 失败: ' + (j.msg || j.code));
  return j.tenant_access_token;
}
async function listAll(token, tableId) {
  const items = [];
  let pageToken = '';
  do {
    const u = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records`);
    u.searchParams.set('page_size', '500');
    if (pageToken) u.searchParams.set('page_token', pageToken);
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j.code !== 0) throw new Error('读取表 ' + tableId + ' 失败: ' + (j.msg || j.code));
    items.push(...(j.data.items || []));
    pageToken = j.data.has_more ? j.data.page_token : '';
  } while (pageToken);
  return items.map(it => it.fields || {});
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');   // 允许 file:// 本地页跨域调用
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    res.status(500).json({ error: '服务端未配置 FEISHU_APP_ID / FEISHU_APP_SECRET' }); return;
  }
  try {
    const token = await tenantToken();
    const state = { materials: [], locations: [], containers: [], members: [], items: [], manuals: [], workorders: [], transactions: [], serials: {}, necOrders: [], necSerials: {}, scanLog: [] };
    for (const [key, tableId] of Object.entries(TABLES)) {
      const recs = await listAll(token, tableId);
      state[key] = recs.map(DOWN[key]).filter(r => r.code || r.seq != null);
    }
    state.txnSeq = Math.max(0, ...state.transactions.map(t => t.seq || 0));
    res.status(200).json({ state, deviceId: 'feishu-cloud', pulledAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
