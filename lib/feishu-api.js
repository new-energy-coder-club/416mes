/**
 * lib/feishu-api.js — 飞书多维表格 REST 接口共用层（读 + 写）
 *
 * 云端（Vercel Serverless）用应用凭证 tenant_access_token 直连飞书开放平台，
 * 不依赖 lark-cli、不需要本机跑服务。
 *
 * 供以下函数复用：
 *   api/feishu-sync.js    只读全量（旧路径，保持兼容）
 *   api/feishu/state.js   只读全量（与 feishu-server.mjs 的 /api/feishu/state 同构）
 *   api/feishu/stock.js   写库存 + 追加流水
 *   api/feishu/ping.js    存活探测
 *
 * 环境变量：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET   自建应用凭证（必需）
 *   FEISHU_BASE_TOKEN                   多维表格 Base token（可选，默认内置）
 *   FEISHU_TABLES                       8 张表 ID 的 JSON（可选，默认内置）
 *
 * 所需飞书权限：应用需具备多维表格的**读写**权限（bitable:app），且已加入该 Base。
 */
'use strict';

// 飞书开放平台地址；可用 FEISHU_HOST 覆盖（仅供测试指向本地 mock，生产勿改）
const FEISHU_HOST = process.env.FEISHU_HOST || 'https://open.feishu.cn';

// Base 与表 ID：优先读环境变量，便于换 Base / 不把标识写死在源码里
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN || 'NpWBb0RXYayqfosYqnScWdlDnMb';
const TABLES = process.env.FEISHU_TABLES ? JSON.parse(process.env.FEISHU_TABLES) : {
  materials: 'tblorMKz5gejPLLj',    // 物料台账
  locations: 'tblI4J48v6GvLZZ2',    // 库位
  containers: 'tblf726XegK4za9v',   // 容器
  members: 'tblsGk6xsuc8Kw16',      // 人员
  items: 'tblpq4NZYc0H1Npk',        // 物品
  manuals: 'tblPHdO374WlnoAk',      // 手册
  workorders: 'tbl2kiNypgfXR7aY',   // 工单记录
  transactions: 'tblQti83n32djsiB'  // 库存流水
};

/* ---------- CellValue 归一化（与 feishu-sync.mjs 保持一致） ---------- */
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
/** 本地时间字符串；显式指定时区，避免 Vercel 运行时（en-US）产出 12 小时制英文时间 */
function fmtLocal(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' +
    pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
}

const WIP_TYPE_CODES = { 'LL 领料': 'LL', 'BH 补货': 'BH', 'JH 拣货': 'JH', 'TL 退料': 'TL' };
const DOWN = {
  materials: f => ({ code: T(f['物料码']), name: T(f['名称']), spec: T(f['规格型号']), xy: T(f['闲鱼XY编号']), loc: T(f['当前库位码']), container: T(f['容器码']), qty: N(f['库存数量']), minQty: N(f['安全库存']), cost: N(f['成本']) }),
  locations: f => ({ code: T(f['库位码']), kind: T(f['类型']), desc: T(f['说明']), grants: T(f['授权人员']) }),
  containers: f => ({ code: T(f['容器码']), type: T(f['容器类型']), spec: T(f['规格']), loc: T(f['当前库位码']) }),
  members: f => ({ code: T(f['编号']), name: T(f['姓名']), sid: T(f['学号']), dept: T(f['部门/SIG']), role: T(f['职务']) || '成员', phone: T(f['电话']), note: T(f['备注']), group: T(f['标签']), pin: T(f['PIN码']) }),
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
      time: T(f['时间']),
      device: 'feishu', operator: T(f['操作人']), type: T(f['类型']), matCode: T(f['物料码']),
      delta: N(f['变动']), balance: f['余量'] == null ? '' : N(f['余量']), ref: T(f['关联单']), reason: T(f['原因/备注'])
    };
  }
};
const PUSH_ORDER = ['materials', 'locations', 'containers', 'members', 'items', 'manuals', 'workorders', 'transactions'];

/* ---------- 鉴权 ---------- */
/** 取 tenant_access_token（应用凭证，1 小时有效；每次调用都重新取，简单可靠） */
async function tenantToken() {
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    throw new Error('服务端未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }
  const r = await fetch(FEISHU_HOST + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('获取 tenant_access_token 失败：' + (j.msg || j.code));
  return j.tenant_access_token;
}

/** 把飞书返回的业务错误转成能看懂的话（尤其权限问题） */
function fsError(scope, j) {
  const code = j && j.code;
  const msg = (j && j.msg) || '';
  if (code === 99991672 || code === 99991663 || /permission|forbidden|权限/i.test(msg)) {
    return new Error('飞书拒绝访问（' + scope + '）：' + msg +
      '　→ 请确认自建应用已开通多维表格**读写**权限，并已「创建版本并发布」，且应用已加入该 Base。');
  }
  if (code === 1254005 || /not ?found/i.test(msg)) {
    return new Error('飞书表不存在（' + scope + '）：' + msg + '　→ 请核对 FEISHU_TABLES 里的表 ID。');
  }
  return new Error(scope + ' 失败：' + (msg || code || JSON.stringify(j).slice(0, 200)));
}

/* ---------- 读 ---------- */
/** 分页读全表，返回 [{record_id, fields}] */
async function listRecords(token, tableId) {
  const out = [];
  let pageToken = '';
  do {
    const u = new URL(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records');
    u.searchParams.set('page_size', '500');
    if (pageToken) u.searchParams.set('page_token', pageToken);
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j.code !== 0) throw fsError('读取表 ' + tableId, j);
    const d = j.data || {};
    out.push(...(d.items || []));
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return out.map(it => ({ record_id: it.record_id, fields: it.fields || {} }));
}

/** 读全量并组装成 state（读取失败一律抛错，绝不返回空表冒充成功） */
async function pullState() {
  const token = await tenantToken();
  const state = { materials: [], locations: [], containers: [], members: [], items: [], manuals: [], workorders: [], transactions: [], serials: {}, necOrders: [], necSerials: [], scanLog: [] };
  for (const key of PUSH_ORDER) {
    const tableId = TABLES[key];
    if (!tableId) continue;
    const recs = await listRecords(token, tableId);
    state[key] = recs.map(r => DOWN[key](r.fields)).filter(r => (key === 'transactions' ? r.matCode || r.seq != null : r.code));
  }
  // 网页端约定：库存流水「新的在前」
  state.transactions.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  state.txnSeq = Math.max(0, ...state.transactions.map(t => t.seq || 0));
  return state;
}

/* ---------- 写 ---------- */
async function batchUpdate(token, tableId, records) {
  const r = await fetch(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records/batch_update', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records })
  });
  const j = await r.json();
  if (j.code !== 0) throw fsError('写入表 ' + tableId, j);
  return j.data;
}
async function batchCreate(token, tableId, records) {
  const r = await fetch(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records/batch_create', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records })
  });
  const j = await r.json();
  if (j.code !== 0) throw fsError('写入表 ' + tableId, j);
  return j.data;
}

/**
 * 库存直写：改物料行「库存数量」+ 追加一条库存流水。
 * 与 feishu-server.mjs 的 writeStock() 语义一致，只是底层换成 REST。
 * @returns {{ok:boolean, seq?:number, error?:string, warning?:string}}
 */
async function writeStock({ matCode, qty, delta, operator, type, reason, ref }) {
  if (!matCode) return { ok: false, error: '缺 matCode' };
  if (typeof qty !== 'number' || !isFinite(qty)) return { ok: false, error: '缺 qty（必须是数字）' };

  let token, rows, hit;
  try {
    token = await tenantToken();
    // 1) 找物料行
    rows = await listRecords(token, TABLES.materials);
  } catch (e) {
    // 鉴权 / 权限 / 网络：统一以 {ok:false} 返回，保持与 feishu-server.mjs 相同的契约
    return { ok: false, error: String((e && e.message) || e) };
  }
  hit = rows.find(r => T(r.fields['物料码']) === matCode);
  if (!hit) return { ok: false, error: '物料码 ' + matCode + ' 不在飞书台账（请先在网页端建档并 push，或先在飞书表里建这条物料）' };

  // 2) 更新库存数量
  try {
    await batchUpdate(token, TABLES.materials, [{ record_id: hit.record_id, fields: { '库存数量': qty } }]);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  // 3) 追加流水（seq = 当前最大 + 1）
  try {
    const txns = await listRecords(token, TABLES.transactions);
    const maxSeq = txns.reduce((m, r) => Math.max(m, parseInt(T(r.fields['流水号']).replace('#', ''), 10) || 0), 0);
    const seq = maxSeq + 1;
    await batchCreate(token, TABLES.transactions, [{
      fields: {
        '流水号': '#' + pad(seq, 6),
        '时间': fmtLocal(new Date()),
        '操作人': operator || '',
        '类型': type || '手工调整',
        '物料码': matCode,
        '变动': typeof delta === 'number' ? delta : 0,
        '余量': qty,
        '关联单': ref || '',
        '原因/备注': reason || ''
      }
    }]);
    return { ok: true, seq };
  } catch (e) {
    // 库存已改、流水没写上：必须明确告知，否则账实与流水会脱节
    return { ok: false, error: '库存已改为 ' + qty + '，但流水写入失败：' + ((e && e.message) || e), warning: 'stock_written_txn_failed' };
  }
}

/* ---------- HTTP 小工具 ---------- */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) { reject(new Error('body 过大')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

module.exports = {
  BASE_TOKEN, TABLES, PUSH_ORDER, DOWN,
  T, N, D, DT, fmtLocal, pad,
  tenantToken, listRecords, pullState, batchUpdate, batchCreate, writeStock,
  fsError, setCors, readBody
};
