/**
 * lib/feishu-api.js — 飞书多维表格 REST 接口共用层（读 + 写 + 对齐核查）
 *
 * 云端（Vercel Serverless）用应用凭证 tenant_access_token 直连飞书开放平台，
 * 不依赖 lark-cli、不需要本机跑服务。
 *
 * 供以下函数复用：
 *   api/feishu-sync.js       只读全量（旧路径，保持兼容）
 *   api/feishu/state.js      只读全量
 *   api/feishu/upsert.js     8 表通用「按业务键新建/更新」
 *   api/feishu/delete.js     8 表通用「按业务键删除」
 *   api/feishu/reconcile.js  8 表「两边差异」只读核查（不写任何数据）
 *   api/feishu/stock.js      写库存 + 追加流水
 *   api/feishu/schema.js     表结构（列名 / 类型 / 单选项）
 *   api/feishu/ping.js       存活探测
 *
 * 环境变量：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET   自建应用凭证（必需）
 *   FEISHU_BASE_TOKEN                   多维表格 Base token（可选，默认内置）
 *   FEISHU_TABLES                       8 张表 ID 的 JSON（可选，默认内置）
 *   FEISHU_HOST                         开放平台地址（仅供测试指向本地 mock）
 *
 * 所需飞书权限：应用需具备多维表格的**读写**权限（bitable:app），且已加入该 Base。
 *
 * ---------------------------------------------------------------------------
 * 设计要点（这一版相对上一版的三处修正，都是实测踩出来的）：
 *
 * 1) **字段映射只有一份**。TABLE_DEFS[key].fields 声明 [本地字段, 飞书列名, 取值类型]，
 *    up/down 都由它生成。上一版 up/down 各写一遍，结果物料/人员/工单三张表的列名
 *    在两边对不上（模块区、PIN码、执行数量…），改一处忘一处。
 *
 * 2) **回读能区分「飞书这一列是空的」和「飞书根本没有这一列」**。
 *    上一版 down() 对不存在的列也返回 ''，合并时就把本地真值覆盖成空 ——
 *    典型后果：库位「类型」在飞书是单选[货架|工位|站点]，本地的「模块区」「空地」
 *    写不进去，回读又把它清成空，于是模块区在标签页里凭空消失。
 *    现在 pullState() 会带上每张表的列名集合，缺列直接**不产出该本地字段**。
 *
 * 3) **删除按「本地键 → 飞书键」归一**。库存流水的本地键是数字 seq，飞书列是 '#000005'，
 *    上一版删除直接用本地键比对，永远删不掉。
 * ---------------------------------------------------------------------------
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

/* ---------- CellValue 归一化 ---------- */
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
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const t = new Date(String(v)).getTime();
  return isNaN(t) ? null : t;
}

const WIP_TYPE_CODES = { 'LL 领料': 'LL', 'BH 补货': 'BH', 'JH 拣货': 'JH', 'TL 退料': 'TL' };
const WIP_TYPE_NAMES = { LL: 'LL 领料', BH: 'BH 补货', JH: 'JH 拣货', TL: 'TL 退料' };

/* ---------- 取值类型：决定双向转换方式 ---------- */
const KIND = {
  TEXT: 'text', NUM: 'num', SELECT: 'select', PHONE: 'phone',
  DATE: 'date', DATETIME: 'datetime', LOCALTIME: 'localtime', ISO: 'iso', SEQ: 'seq',
  WIPTYPE: 'wiptype', ITEMS: 'items', EXECQTY: 'execqty', JSONF: 'json'
};

/** 本地值 → 飞书写入值 */
const UP = {
  text: v => (v == null ? '' : String(v)),
  select: v => (v == null ? '' : String(v)),
  phone: v => (v == null ? '' : String(v)),
  num: v => (v == null || v === '' ? '' : (isFinite(Number(v)) ? Number(v) : '')),
  date: v => toMs(v),
  datetime: v => toMs(v),
  localtime: v => toMs(v),
  iso: v => toMs(v),
  seq: v => (v == null || v === '' ? '' : '#' + pad(v, 6)),
  wiptype: v => WIP_TYPE_NAMES[v] || (v == null ? '' : String(v)),
  items: v => (Array.isArray(v) && v.length ? v.map(i => i.matCode + 'x' + i.qty).join('; ') : ''),
  execqty: v => (Array.isArray(v) && v.length ? v.map(e => e.matCode + '=' + e.qty).join('; ') : ''),
  json: v => {
    if (v == null) return '';
    if (Array.isArray(v)) return v.length ? JSON.stringify(v) : '';
    if (typeof v === 'object') return Object.keys(v).length ? JSON.stringify(v) : '';
    return String(v);
  }
};

/** 飞书读出值 → 本地值 */
const DOWN = {
  text: T, select: T, phone: T,
  num: N,
  date: D,
  datetime: DT,
  localtime: v => { const d = toDate(v); return d ? fmtLocal(d) : T(v); },
  iso: v => { const d = toDate(v); return d ? d.toISOString() : ''; },
  seq: v => { const n = parseInt(T(v).replace('#', ''), 10); return isNaN(n) ? null : n; },
  wiptype: v => WIP_TYPE_CODES[T(v)] || T(v) || 'LL',
  items: v => T(v).split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.+?)[x×](\d+(?:\.\d+)?)$/); return m ? { matCode: m[1], qty: +m[2] } : null;
  }).filter(Boolean),
  execqty: v => T(v).split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.+?)=(\d+(?:\.\d+)?)$/); return m ? { matCode: m[1], qty: +m[2] } : null;
  }).filter(Boolean),
  json: v => { try { const j = JSON.parse(T(v)); return j && typeof j === 'object' ? j : undefined; } catch { return undefined; } }
};

/**
 * 8 张表的唯一一份定义。
 *   table  飞书里的表名（用于报错信息）
 *   key    业务主键列名（增删改查都按它定位记录）
 *   fields [[本地字段, 飞书列名, 取值类型], …]  ← 双向映射的唯一来源
 *   fallback  某列在所有本地字段都为空时的兜底取值函数
 *   localKeyOf  从本地记录取业务键（默认 r.code）
 *   toFeishuKey / fromFeishuKey  本地键 ↔ 飞书键（仅流水需要，seq ↔ '#000005'）
 */
const TABLE_DEFS = {
  materials: {
    table: '物料台账', key: '物料码',
    fields: [
      ['code', '物料码', KIND.TEXT],
      ['name', '名称', KIND.TEXT],
      ['spec', '规格型号', KIND.TEXT],
      ['xy', '闲鱼XY编号', KIND.TEXT],
      ['loc', '当前库位码', KIND.TEXT],
      ['container', '容器码', KIND.TEXT],
      ['zone', '模块区', KIND.TEXT],          // 飞书表里还没有这一列 → 会被报为「缺列」，本地值不受影响
      ['qty', '库存数量', KIND.NUM],
      ['minQty', '安全库存', KIND.NUM],
      ['cost', '成本', KIND.NUM]
    ]
  },
  locations: {
    table: '库位', key: '库位码',
    fields: [
      ['code', '库位码', KIND.TEXT],
      ['kind', '类型', KIND.SELECT],          // 单选[货架|工位|站点]；本地的「模块区」「空地」需要先在飞书补选项
      ['desc', '说明', KIND.TEXT],
      ['grants', '授权人员', KIND.TEXT]
    ]
  },
  containers: {
    table: '容器', key: '容器码',
    fields: [
      ['code', '容器码', KIND.TEXT],
      ['type', '容器类型', KIND.SELECT],
      ['spec', '规格', KIND.TEXT],
      ['loc', '当前库位码', KIND.TEXT]
    ]
  },
  members: {
    table: '人员', key: '编号',
    fields: [
      ['code', '编号', KIND.TEXT],
      ['name', '姓名', KIND.TEXT],
      ['sid', '学号', KIND.TEXT],
      ['dept', '部门/SIG', KIND.TEXT],
      ['role', '职务', KIND.SELECT],
      ['phone', '电话', KIND.PHONE],
      ['note', '备注', KIND.TEXT],
      ['group', '标签', KIND.TEXT],
      ['pin', 'PIN码', KIND.TEXT]             // 飞书表里还没有这一列
    ]
  },
  items: {
    table: '物品', key: '物品码',
    fields: [
      ['code', '物品码', KIND.TEXT],
      ['name', '名称', KIND.TEXT],
      ['spec', '规格型号', KIND.TEXT],
      ['loc', '库位码', KIND.TEXT]
    ]
  },
  manuals: {
    table: '手册', key: '手册码',
    fields: [
      ['code', '手册码', KIND.TEXT],
      ['name', '名称', KIND.TEXT],
      ['ver', '版本', KIND.TEXT],
      ['loc', '库位码', KIND.TEXT]
    ]
  },
  workorders: {
    table: '工单记录', key: '工单号',
    fields: [
      ['code', '工单号', KIND.TEXT],
      ['type', '类型', KIND.WIPTYPE],
      ['date', '日期', KIND.DATE],
      ['items', '明细', KIND.ITEMS],
      ['status', '状态', KIND.SELECT],        // 单选[未执行|已执行]；「部分执行」「已取消」需要先在飞书补选项
      ['execTime', '执行时间', KIND.DATETIME],
      ['execQty', '执行数量', KIND.EXECQTY],  // 飞书表里还没有这四列
      ['execBatches', '执行批次', KIND.JSONF],
      ['reverseInfo', '冲销记录', KIND.JSONF],
      ['cancelInfo', '取消记录', KIND.JSONF]
    ]
  },
  transactions: {
    table: '库存流水', key: '流水号',
    fields: [
      ['ts', '时间', KIND.ISO],
      ['time', '时间', KIND.LOCALTIME],       // 同一列派生出两个本地字段：ISO 便于排序，time 便于显示（含秒）
      ['seq', '流水号', KIND.SEQ],
      ['operator', '操作人', KIND.TEXT],
      ['type', '类型', KIND.TEXT],
      ['matCode', '物料码', KIND.TEXT],
      ['delta', '变动', KIND.NUM],
      ['balance', '余量', KIND.NUM],
      ['ref', '关联单', KIND.TEXT],
      ['reason', '原因/备注', KIND.TEXT]
    ],
    // 新建流水时时间列必须有值（飞书日期列不接受空）
    fallback: { '时间': () => Date.now() },
    localKeyOf: r => r.seq,
    toFeishuKey: v => (v == null || v === '' ? '' : (/^\d+$/.test(String(v)) ? '#' + pad(String(v), 6) : String(v))),
    fromFeishuKey: v => { const n = parseInt(T(v).replace('#', ''), 10); return isNaN(n) ? null : n; }
  }
};

const PUSH_ORDER = ['materials', 'locations', 'containers', 'members', 'items', 'manuals', 'workorders', 'transactions'];

/* ---------- 字段映射（up / down 都由 fields 生成，避免两边漂移） ---------- */

/** 本地对象 → 飞书 fields（不做表结构过滤，交给 coerceFields） */
function mapUp(def, obj) {
  obj = obj || {};
  const out = {};
  const filled = Object.create(null);
  (def.fields || []).forEach(f => {
    const [localKey, col, kind] = f;
    const v = (UP[kind] || UP.text)(obj[localKey]);
    const empty = (v === '' || v === null || v === undefined);
    if (empty) {
      // 同一列由多个本地字段供给时（如 时间 ← ts/time），空值不占位，让后面的字段有机会填上
      if (filled[col]) return;
      const fb = def.fallback && def.fallback[col];
      out[col] = fb ? fb() : '';
      return;
    }
    out[col] = v;
    filled[col] = true;
  });
  return out;
}

/**
 * 飞书 fields → 本地对象。
 * @param {Set<string>|null} present 飞书表里真实存在的列名；为 null 表示不做缺列检查。
 *   飞书没有这一列时**不产出该本地键**，合并阶段就不会用「空」把本地真值覆盖掉。
 */
function mapDown(def, f, present) {
  f = f || {};
  const out = {};
  (def.fields || []).forEach(fld => {
    const [localKey, col, kind] = fld;
    if (present && !present.has(col)) return;
    out[localKey] = (DOWN[kind] || DOWN.text)(f[col]);
  });
  return out;
}

/** 表定义 + 便捷键函数（向后兼容旧调用点） */
Object.entries(TABLE_DEFS).forEach(([, def]) => {
  def.up = obj => mapUp(def, obj);
  def.down = f => mapDown(def, f, null);
  if (!def.localKeyOf) def.localKeyOf = r => (r ? r.code : '');
  if (!def.toFeishuKey) def.toFeishuKey = v => (v == null ? '' : String(v));
  if (!def.fromFeishuKey) def.fromFeishuKey = v => T(v);
});

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

/**
 * 读全量并组装成 state（读取失败一律抛错，绝不返回空表冒充成功）。
 *
 * 8 张表**并行**读：每张表要读列名 + 读记录，串行是 16 个来回，
 * 实测约 9 秒，逼近 Vercel 函数超时；并行后是一个来回的量级。
 */
async function pullState() {
  const token = await tenantToken();
  const state = { materials: [], locations: [], containers: [], members: [], items: [], manuals: [], workorders: [], transactions: [], serials: {}, necOrders: [], necSerials: [], scanLog: [] };
  state.columns = {};        // 每张表真实存在的列名，前端据此判断「飞书缺哪列」
  await Promise.all(PUSH_ORDER.map(async key => {
    const tableId = TABLES[key];
    if (!tableId) return;
    const def = TABLE_DEFS[key];
    // 列名必须先拿到：缺列要「不产出本地键」，否则回读会用空值覆盖本地真值
    const [defs, recs] = await Promise.all([listFields(token, tableId), listRecords(token, tableId)]);
    const present = new Set(defs.map(d => d.name));
    state.columns[key] = [...present];
    state[key] = recs
      .map(r => mapDown(def, r.fields, present))
      .filter(r => (key === 'transactions' ? (r.matCode || r.seq != null) : r.code));
  }));
  // 网页端约定：库存流水「新的在前」
  state.transactions.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  state.txnSeq = Math.max(0, ...state.transactions.map(t => t.seq || 0));
  return state;
}

/* ---------- 表结构 ---------- */
/**
 * 读某张表的字段定义。
 * 飞书多维表格的字段有类型（文本/数字/日期/单选/人员…），写错格式会被拒
 * （例如日期列必须传毫秒时间戳，传字符串会报 DatetimeFieldConvFail）。
 * @returns {Array<{name:string,type:number,typeName:string,options?:string[]}>}
 */
const FIELD_TYPE = {
  1: '文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框', 11: '人员',
  13: '电话', 15: '超链接', 17: '附件', 18: '单向关联', 19: '查找引用', 20: '公式',
  21: '双向关联', 22: '地理位置', 23: '群组', 1001: '创建时间', 1002: '最后更新时间',
  1003: '创建人', 1004: '修改人', 1005: '自动编号'
};
async function listFields(token, tableId) {
  const u = new URL(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/fields');
  u.searchParams.set('page_size', '200');
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  if (j.code !== 0) throw fsError('读取表结构 ' + tableId, j);
  return (j.data.items || []).map(f => ({
    name: f.field_name, type: f.type, typeName: FIELD_TYPE[f.type] || ('type' + f.type),
    options: (f.property && f.property.options) ? f.property.options.map(o => o.name) : undefined
  }));
}

/** 表结构缓存：一次进程内不重复拉（serverless 每次冷启动各拉一次，开销可接受） */
const _fieldCache = Object.create(null);
async function fieldNames(token, tableId) {
  if (!_fieldCache[tableId]) {
    const defs = await listFields(token, tableId);
    _fieldCache[tableId] = defs.map(d => d.name);
  }
  return _fieldCache[tableId];
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
 * 按表结构校验待写入字段的 JS 类型是否与飞书列类型匹配。
 * 飞书没有 dry-run 接口，写错格式只能靠写入失败来发现（日期列传字符串会报
 * DatetimeFieldConvFail）。这里在写入前先比一遍类型，让「校验」这件事不产生副作用。
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
async function validateFields(token, tableId, fields, tableLabel) {
  const defs = await listFields(token, tableId);
  const byName = Object.create(null);
  defs.forEach(d => { byName[d.name] = d; });
  const problems = [];
  Object.entries(fields).forEach(([name, v]) => {
    const def = byName[name];
    if (!def) { problems.push(tableLabel + '：表里没有「' + name + '」这一列'); return; }
    const okType = {
      '文本': typeof v === 'string',
      '数字': typeof v === 'number' && isFinite(v),
      '日期': typeof v === 'number' && isFinite(v),   // 毫秒时间戳
      '复选框': typeof v === 'boolean',
      '单选': typeof v === 'string'
    }[def.typeName];
    if (okType === false) {
      problems.push(tableLabel + '：列「' + name + '」是[' + def.typeName + ']，收到的却是 ' + (v === null ? 'null' : typeof v) + '（' + JSON.stringify(v) + '）');
    }
    if (def.typeName === '单选' && def.options && def.options.length && typeof v === 'string' && !def.options.includes(v)) {
      problems.push(tableLabel + '：列「' + name + '」是单选，没有「' + v + '」这个选项（现有：' + def.options.join('/') + '）');
    }
  });
  return problems;
}

/**
 * POST .../records/search —— 支持排序 / 过滤 / 字段投影。
 *
 * 为什么需要它：list records 只能整表翻页，没法回答「最近有没有变过」。
 * 增量拉取和大数据量下的廉价变更探测都要靠这个接口。
 */
async function searchRecords(token, tableId, opts) {
  opts = opts || {};
  // 关键：records/search 的参数分两处 ——
  //   field_names / sort / filter 在**请求体**里
  //   page_size / page_token 在**查询串**里
  // 放进 body 会被静默忽略（实测：page_size=1 仍返回全表 188 条，has_more 恒为 false）。
  const u = new URL(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records/search');
  u.searchParams.set('page_size', String(Math.min(opts.pageSize || 500, 500)));
  if (opts.pageToken) u.searchParams.set('page_token', opts.pageToken);
  const body = {};
  if (opts.fieldNames) body.field_names = opts.fieldNames;
  if (opts.sort) body.sort = opts.sort;
  if (opts.filter) body.filter = opts.filter;
  const r = await fetch(u, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (j.code !== 0) throw fsError('搜索表 ' + tableId, j);
  return j.data || {};
}

/**
 * 原始响应转储（诊断用，只读）。
 * 打 records/search 时参数是否被尊重、响应结构到底长什么样，
 * 只能看原始报文才能判断 —— 这决定了「廉价变更探测」成不成立。
 */
async function dumpSearchShape() {
  const token = await tenantToken();
  // 用 188 条的库位表测 page_size 是否真的生效 —— 3 条的小表上看不出来
  const tableId = TABLES.locations;
  const keyField = TABLE_DEFS.locations.key;
  const send = async (label, opts) => {
    const u = new URL(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records/search');
    u.searchParams.set('page_size', String(opts.pageSize || 500));
    const body = {};
    if (opts.fieldNames) body.field_names = opts.fieldNames;
    if (opts.sort) body.sort = opts.sort;
    const r = await fetch(u, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    const d = j.data || {};
    const items = d.items || [];
    return {
      label,
      requestBody: body,
      queryPageSize: u.searchParams.get('page_size'),
      respCode: j.code,
      respMsg: j.msg,
      dataKeys: Object.keys(d),
      total: d.total,
      hasMore: d.has_more,
      itemCount: items.length,
      firstItemKeys: items[0] ? Object.keys(items[0]) : null,
      firstItem: items[0] ? JSON.stringify(items[0]).slice(0, 600) : null,
      payloadBytes: JSON.stringify(d).length
    };
  };
  const out = { table: '库位（188 条）', keyField, probes: [] };
  // page_size 改成查询参数后，逐档验证分页是否真的生效
  for (const ps of [1, 2, 20, 100, 500]) {
    out.probes.push(await send('page_size=' + ps + '（查询参数）', { pageSize: ps, fieldNames: [keyField] }));
  }
  out.probes.push(await send('真实探测形态：page_size=1 + field_names=[最后更新时间] + 倒序',
    { pageSize: 1, fieldNames: ['最后更新时间'], sort: [{ field_name: '最后更新时间', desc: true }] }));
  try { out.normalizedKeySample = T(((await searchRecords(token, tableId, { pageSize: 1, fieldNames: [keyField] })).items || [])[0].fields[keyField]); } catch (e) { out.normalizedKeySample = 'err:' + e.message; }
  return out;
}

/**
 * 能力探测：飞书到底能不能「廉价地知道有没有变过」。
 *
 * 这决定了大数据量下的同步架构走向：
 *   能按「最后更新时间」排序 → 每次只取 1 条就能判断有无变更（8 个小请求，毫秒级）
 *   不能 → 只能定时全量拉，数据一大就撑不住
 * 不猜文档，直接打真接口。
 */
async function probeChangeDetection() {
  const token = await tenantToken();
  const t0 = Date.now();
  const out = { at: new Date().toISOString(), tables: {} };
  await Promise.all(PUSH_ORDER.map(async key => {
    const tableId = TABLES[key];
    if (!tableId) return;
    const def = TABLE_DEFS[key];
    const rec = { table: def.table };
    let defs = [];
    try {
      defs = await listFields(token, tableId);
      rec.fieldCount = defs.length;
      const lm = defs.filter(f => f.type === 1002 || /最后更新时间|更新时间/.test(f.name));
      rec.lastModifiedFields = lm.map(f => f.name + '[' + f.typeName + ']');
    } catch (e) { rec.fieldsError = String(e.message).slice(0, 160); }

    try {
      const d = await searchRecords(token, tableId, { pageSize: 1 });
      rec.search = 'ok';
      rec.searchTotal = d.total;
      rec.searchReturned = (d.items || []).length;
    } catch (e) { rec.search = String(e.message).slice(0, 200); }

    if (rec.search === 'ok' && defs.length) {
      // 按业务主键排序（任何表都有）—— 若排序本身可用，说明 search 的 sort 参数被支持
      const keyField = def.key;
      try {
        await searchRecords(token, tableId, { pageSize: 1, sort: [{ field_name: keyField, desc: true }] });
        rec.sortByBusinessKey = 'ok';
      } catch (e) { rec.sortByBusinessKey = String(e.message).slice(0, 200); }

      // 按「最后更新时间」排序 —— 这是廉价变更探测的关键
      const lmName = (rec.lastModifiedFields || []).map(x => x.split('[')[0])[0];
      if (lmName) {
        try {
          const d2 = await searchRecords(token, tableId, { pageSize: 1, sort: [{ field_name: lmName, desc: true }] });
          rec.sortByLastModified = 'ok';
          const it = (d2.items || [])[0];
          rec.latestModifiedRaw = it ? it.fields[lmName] : null;
        } catch (e) { rec.sortByLastModified = String(e.message).slice(0, 200); }
      } else {
        rec.sortByLastModified = 'no-such-field';
      }

      /* filter 能力：决定「增量拉取」可不可行。
         先用业务键试 isNotEmpty（与字段类型无关），再用表里**已有的日期字段**试 isGreater。
         只要这两条通，等加了时间字段就能按时间增量拉。 */
      try {
        const d3 = await searchRecords(token, tableId, {
          pageSize: 1,
          filter: { conjunction: 'and', conditions: [{ field_name: keyField, operator: 'isNotEmpty', value: [] }] }
        });
        rec.filterIsNotEmpty = 'ok';
        rec.filterTotal = d3.total;
      } catch (e) { rec.filterIsNotEmpty = String(e.message).slice(0, 200); }

      /* 文本主键的精确查找 —— 阶段 0 要用它替掉「每写一条流水都全表扫」的 O(n) 路径，
         阶段 2 还要用它按「操作ID」查重做幂等。这条不通，两个阶段都得改设计。 */
      try {
        const probe = await searchRecords(token, tableId, { pageSize: 1, field_names: [keyField] });
        const kv = ((probe.items || [])[0] || {}).fields;
        const v = kv ? kv[keyField] : null;
        if (v == null) { rec.filterByTextIs = 'no-sample-row'; }
        else {
          rec.filterSampleKey = String(v);
          const dIs = await searchRecords(token, tableId, {
            pageSize: 2,
            filter: { conjunction: 'and', conditions: [{ field_name: keyField, operator: 'is', value: [String(v)] }] }
          });
          rec.filterByTextIs = 'ok';
          rec.filterByTextIsHits = (dIs.items || []).length;
        }
      } catch (e) { rec.filterByTextIs = String(e.message).slice(0, 200); }

      /* 投影是否真的省流量：只取主键列 vs 不限制列 */
      try {
        const t0 = Date.now();
        const proj = await searchRecords(token, tableId, { pageSize: 200, field_names: [keyField] });
        const msProj = Date.now() - t0;
        const t1 = Date.now();
        const full = await searchRecords(token, tableId, { pageSize: 200 });
        const msFull = Date.now() - t1;
        rec.projection = {
          projectedBytes: JSON.stringify(proj).length,
          fullBytes: JSON.stringify(full).length,
          projectedMs: msProj, fullMs: msFull
        };
        rec.projectionSaving = rec.projection.fullBytes
          ? (1 - rec.projection.projectedBytes / rec.projection.fullBytes).toFixed(3) : null;
      } catch (e) { rec.projection = String(e.message).slice(0, 160); }

      const dateField = defs.filter(f => f.type === 5)[0];
      if (dateField) {
        rec.dateFieldUsed = dateField.name;
        // 日期过滤的值格式有讲究，逐个试，把能用的记下来
        const tries = [
          ['isGreater', ['ExactDate', '2020-01-01']],
          ['isGreater', ['ExactDate', '2020-01-01 00:00:00']],
          ['isGreaterEqual', ['ExactDate', '2020-01-01']],
          ['is', ['ExactDate', '2026-09-15']],
          ['isGreater', [0]]
        ];
        rec.dateFilterTries = [];
        for (const [op, val] of tries) {
          const label = op + ' ' + JSON.stringify(val);
          try {
            const d4 = await searchRecords(token, tableId, {
              pageSize: 1,
              filter: { conjunction: 'and', conditions: [{ field_name: dateField.name, operator: op, value: val }] }
            });
            rec.dateFilterTries.push({ expr: label, ok: true, total: d4.total });
            if (!rec.filterByDateGreater) { rec.filterByDateGreater = 'ok'; rec.filterByDateTotal = d4.total; rec.dateFilterWorking = label; }
          } catch (e) {
            rec.dateFilterTries.push({ expr: label, ok: false, err: String(e.message).slice(0, 90) });
          }
        }
        /* 关键：**按日期字段排序**能不能用？
           能的话就不需要 filter —— 「倒序取第 1 条」就是廉价变更探测，
           「倒序翻页到水位线」就是增量拉取。这条路只要 sort，而 sort 已被证明可用。 */
        try {
          const d5 = await searchRecords(token, tableId, { pageSize: 1, sort: [{ field_name: dateField.name, desc: true }] });
          rec.sortByDateField = 'ok';
          const it5 = (d5.items || [])[0];
          rec.latestDateRaw = it5 ? it5.fields[dateField.name] : null;
        } catch (e) { rec.sortByDateField = String(e.message).slice(0, 200); }
      }
    }
    out.tables[key] = rec;
  }));
  out.elapsedMs = Date.now() - t0;
  return out;
}

/**
 * 按飞书字段类型转换待写值。这一步是必需的，不是锦上添花：
 *   - 日期列必须传毫秒时间戳，传 "2026-09-11" 会报 DatetimeFieldConvFail
 *   - 电话 / 人员 / 附件 等类型**不接受空字符串**，传 '' 会报
 *     Failed to convert phone field（实测踩过）
 *   - 单选列的值必须已存在于选项里，否则整批写入被拒
 * 返回 { fields, dropped, droppedColumns, skippedEmpty }：
 *   dropped        人看的清单，列出所有被跳过的列（含「空值本来就不该发」这种正常情况）
 *   droppedColumns 只有**真问题**才进这里（缺列 / 单选无此选项 / 数字或日期非法），
 *                  它是 upsertRecords 里 blocked 保护名单的来源，所以不能混入正常跳过 ——
 *                  否则「电话为空」会被当成推不上去的字段，把飞书后来填的电话永久挡住。
 */
function coerceFields(defs, fields) {
  const byName = Object.create(null);
  defs.forEach(d => { byName[d.name] = d; });
  const out = {};
  const dropped = [];
  const droppedColumns = Object.create(null);
  // benign=true 表示「跳过是正常的，不是问题」，不进 droppedColumns
  const drop = (k, why, benign) => {
    dropped.push(why ? (k + '（' + why + '）') : k);
    if (!benign) droppedColumns[k] = why || '表里没有这一列';
  };
  Object.entries(fields || {}).forEach(([k, v]) => {
    const d = byName[k];
    if (!d) { drop(k, '表里没有这一列'); return; }
    const empty = (v === '' || v === null || v === undefined);
    switch (d.typeName) {
      case '文本':
      case '多选':
      case '公式':
        if (!empty) out[k] = String(v);
        break;
      case '单选':
        if (empty) break;                                      // 空值不写，避免清掉已有选项
        if (d.options && d.options.length && !d.options.includes(String(v))) {
          drop(k, '单选无此选项：' + v + '，现有 ' + d.options.join('/'));
        } else out[k] = String(v);
        break;
      case '数字':
        if (!empty && isFinite(Number(v))) out[k] = Number(v);
        else if (!empty) drop(k, '数字非法：' + v);
        break;
      case '日期':
        if (empty) break;
        { const t = toMs(v); if (t != null) out[k] = t; else drop(k, '日期非法：' + v); }
        break;
      case '复选框':
        if (!empty) out[k] = !!v;
        break;
      default:
        // 电话 / 人员 / 附件 / 超链接 / 地理位置 …：空值一律不发（飞书会拒绝），非空原样试。
        // 空值是**正常跳过**，不是「推不上去」—— 否则 24 个空电话会把 24 条人员记录
        // 全标成 blocked，进而把飞书里后来填上的电话永久挡在门外。
        if (!empty) out[k] = v;
        else drop(k, d.typeName + '类型不接受空值，已跳过', true);
    }
  });
  return { fields: out, dropped, droppedColumns };
}

/**
 * 库存直写：改物料行「库存数量」+ 追加一条库存流水。
 * 与 feishu-server.mjs 的 writeStock() 语义一致，只是底层换成 REST。
 * @returns {{ok:boolean, seq?:number, error?:string, warning?:string}}
 */
async function writeStock({ matCode, qty, delta, operator, type, reason, ref, dryRun }) {
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

  // 2) 组装流水行（seq = 当前最大 + 1）
  let seq = null, txnFields = null, txnDropped = [];
  try {
    const txns = await listRecords(token, TABLES.transactions);
    const maxSeq = txns.reduce((m, r) => Math.max(m, parseInt(T(r.fields['流水号']).replace('#', ''), 10) || 0), 0);
    seq = maxSeq + 1;
    const wanted = mapUp(TABLE_DEFS.transactions, {
      seq, ts: new Date().toISOString(), operator: operator || '', type: type || '手工调整',
      matCode, delta: typeof delta === 'number' ? delta : 0,
      balance: qty, ref: ref || '', reason: reason || ''
    });
    // 按真实列类型转换：日期列必须是毫秒时间戳，否则整批被拒
    const c = coerceFields(await listFields(token, TABLES.transactions), wanted);
    txnFields = c.fields; txnDropped = c.dropped;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  // dry-run：只按表结构校验格式，不写任何数据
  if (dryRun) {
    try {
      const problems = []
        .concat(await validateFields(token, TABLES.materials, { '库存数量': qty }, '物料台账'))
        .concat((await listFields(token, TABLES.transactions)).length ? [] : ['库存流水表结构读取异常'])
        .concat(txnDropped.map(d => '库存流水：' + d));
      return {
        ok: problems.length === 0,
        dryRun: true,
        target: { matCode, currentQty: N(hit.fields['库存数量']), newQty: qty, seq },
        payload: txnFields,
        problems
      };
    } catch (e) {
      return { ok: false, error: '校验失败：' + ((e && e.message) || e) };
    }
  }

  // 3) 更新库存数量
  try {
    await batchUpdate(token, TABLES.materials, [{ record_id: hit.record_id, fields: { '库存数量': qty } }]);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  // 4) 追加流水
  try {
    await batchCreate(token, TABLES.transactions, [{ fields: txnFields }]);
    return { ok: true, seq, before: N(hit.fields['库存数量']), balance: qty, dropped: txnDropped };
  } catch (e) {
    // 库存已改、流水没写上：必须明确告知，否则账实与流水会脱节
    return { ok: false, seq, error: '库存已改为 ' + qty + '，但流水写入失败：' + ((e && e.message) || e), warning: 'stock_written_txn_failed' };
  }
}

/* ---------- 通用增删改查（8 张表共用一套） ---------- */

/**
 * 按业务主键批量新建或更新记录（8 张表通用）。
 *
 * 关键设计：**按表结构过滤字段**。
 * 飞书表里没有的列直接丢掉并列入 dropped 返回，而不是让整批写入失败 ——
 * 这样工单记录少了「执行批次」列时，其余字段照常同步，只是提示你补列。
 *
 * @param {string} keyName  TABLE_DEFS 里的表键（materials / members / workorders …）
 * @param {Array}  records  本地对象数组
 * @param {object} [opts]   { dryRun:true } 时只校验不写
 * @returns {{created:number, updated:number, dropped:string[], droppedColumns:object, blocked:object, unknownTable?:string}}
 */
async function upsertRecords(keyName, records, opts) {
  opts = opts || {};
  const def = TABLE_DEFS[keyName];
  if (!def) return { created: 0, updated: 0, dropped: [], droppedColumns: {}, error: '未知的表：' + keyName };
  const tableId = TABLES[keyName];
  if (!tableId) return { created: 0, updated: 0, dropped: [], droppedColumns: {}, error: '未配置表 ID：' + keyName };

  const token = await tenantToken();
  const [defs, rows] = await Promise.all([listFields(token, tableId), listRecords(token, tableId)]);   // 需要类型才能正确转换

  const toCreate = [], toUpdate = [], skipped = [];
  const droppedSet = new Set();
  const droppedColumns = Object.create(null);
  const blocked = Object.create(null);                 // 业务键 → 没写进去的「本地字段」名
  const index = new Map();                            // 飞书键 → record_id，避免 O(n·m）
  rows.forEach(r => { const k = T(r.fields[def.key]); if (k) index.set(k, r.record_id); });
  const pendingNew = new Map();                       // 同一批里同业务键的记录只建一条（后者覆盖字段）

  // 飞书列名 → 本地字段名（一列可能供给多个本地字段，如流水的「时间」）
  const localsOfCol = Object.create(null);
  (def.fields || []).forEach(([localField, col]) => {
    (localsOfCol[col] = localsOfCol[col] || []).push(localField);
  });

  (records || []).forEach(r => {
    const c = coerceFields(defs, mapUp(def, r));
    c.dropped.forEach(d => droppedSet.add(d));
    Object.assign(droppedColumns, c.droppedColumns);
    const fields = c.fields;
    const bizKey = String(fields[def.key] == null ? '' : fields[def.key]);
    if (!bizKey) { skipped.push(def.localKeyOf(r) || '（无业务键）'); return; }
    // 被丢掉的列 → 对应的本地字段；前端拿它做「合并时以本地为准」的保护名单。
    // 只有**本地确实有值、却没写进去**的字段才算数：
    // 本地本来就是空的（没填电话、没设 PIN 码、没有执行批次）不算问题 ——
    // 否则缺列时每条记录都会卡在保护名单里，把飞书后来补上的值永久挡在门外。
    const blank = v => v === '' || v === null || v === undefined
      || (Array.isArray(v) && v.length === 0)
      || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
    const bad = new Set();
    Object.keys(c.droppedColumns).forEach(col => {
      if (col === def.key) return;                 // 业务键列缺失属于表结构错误，不该进保护名单
      (localsOfCol[col] || []).forEach(f => { if (!blank(r[f])) bad.add(f); });
    });
    if (bad.size) blocked[bizKey] = [...bad];
    const hit = index.get(bizKey);
    if (hit) toUpdate.push({ record_id: hit, fields });
    else if (pendingNew.has(bizKey)) Object.assign(pendingNew.get(bizKey).fields, fields);   // 同批同键 → 合并成一条
    else { const rec = { fields }; pendingNew.set(bizKey, rec); toCreate.push(rec); }
  });

  if (opts.dryRun) {
    return {
      dryRun: true, created: 0, updated: 0,
      wouldCreate: toCreate.length, wouldUpdate: toUpdate.length, skipped,
      dropped: [...droppedSet], droppedColumns, blocked
    };
  }

  if (toCreate.length) await batchCreate(token, tableId, toCreate);
  if (toUpdate.length) await batchUpdate(token, tableId, toUpdate);
  return { created: toCreate.length, updated: toUpdate.length, skipped, dropped: [...droppedSet], droppedColumns, blocked };
}

/**
 * 按业务主键批量删除（8 张表通用）。
 * keys 可以是本地键（物料码 / 编号 / 流水 seq），也可以整条本地记录。
 * 内部按 def.toFeishuKey 归一 —— 库存流水的本地键是数字 seq，飞书列是 '#000005'。
 */
async function deleteRecords(keyName, keys) {
  const def = TABLE_DEFS[keyName];
  if (!def) return { deleted: 0, error: '未知的表：' + keyName };
  const tableId = TABLES[keyName];
  if (!tableId) return { deleted: 0, error: '未配置表 ID：' + keyName };

  const token = await tenantToken();
  const rows = await listRecords(token, tableId);
  const want = new Set();
  (keys || []).forEach(k => {
    const v = (k && typeof k === 'object') ? def.localKeyOf(k) : k;
    const fk = def.toFeishuKey(v);
    if (fk !== '' && fk != null) want.add(String(fk));
  });
  const ids = rows.filter(r => want.has(T(r.fields[def.key]))).map(r => r.record_id);
  if (!ids.length) return { deleted: 0, notFound: [...want] };

  const res = await fetch(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records/batch_delete', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: ids })
  });
  const j = await res.json();
  if (j.code !== 0) throw fsError('删除表 ' + tableId, j);
  return { deleted: ids.length };
}

/**
 * 只读核查：把「本地记录的键」和「飞书里的键」比一遍，回报
 *   missingColumns  声明了但飞书表里没有的列（这些列的内容永远同步不上去）
 *   missingOptions  单选列的本地取值不在飞书选项里（这些值会被丢掉）
 *   remoteOnly      飞书有、本地没有
 *   localOnly       本地有、飞书没有
 * 不写任何数据，可以放心在生产上反复调。
 * @param {object} local 网页端 state（只需要 8 张表的数组）
 */
async function reconcile(local) {
  const token = await tenantToken();
  const report = { at: new Date().toISOString(), tables: {} };
  const summary = { missingColumns: 0, missingOptions: 0, localOnly: 0, remoteOnly: 0 };
  // 同样并行：8 张表 × (列名 + 记录) 串行会超出 serverless 时限
  await Promise.all(PUSH_ORDER.map(async key => {
    const tableId = TABLES[key];
    if (!tableId) return;
    const def = TABLE_DEFS[key];
    const [defs, recs] = await Promise.all([listFields(token, tableId), listRecords(token, tableId)]);
    const present = new Set(defs.map(d => d.name));
    const byName = Object.create(null); defs.forEach(d => { byName[d.name] = d; });

    const missingColumns = [...new Set((def.fields || []).map(f => f[1]))].filter(c => !present.has(c));

    const missingOptions = [];
    (def.fields || []).forEach(([localField, col, kind]) => {
      const d = byName[col];
      if (!d || d.typeName !== '单选' || !d.options || !d.options.length) return;
      const used = new Set();
      // 必须比**转换后**的值：工单类型本地存 'LL'，写出去是 'LL 领料'，
      // 直接拿本地的 'LL' 去比选项会误报「缺选项 LL」。
      ((local && local[key]) || []).forEach(r => {
        const v = (UP[kind] || UP.text)(r[localField]);
        if (v !== '' && v != null) used.add(String(v));
      });
      const bad = [...used].filter(v => !d.options.includes(v));
      if (bad.length) missingOptions.push({ column: col, field: localField, existing: d.options, usedButMissing: bad });
    });

    const remoteKeys = recs.map(r => T(r.fields[def.key])).filter(Boolean);
    const localKeys = ((local && local[key]) || []).map(r => def.localKeyOf(r)).filter(v => v !== '' && v != null);
    const remoteSet = new Set(remoteKeys.map(String));
    const localSet = new Set(localKeys.map(String));
    const cap = arr => arr.slice(0, 50);
    const localOnlyAll = localKeys.filter(v => !remoteSet.has(String(def.toFeishuKey(v))));
    const remoteOnlyAll = remoteKeys.filter(v => !localSet.has(String(def.fromFeishuKey(v))));

    report.tables[key] = {
      table: def.table,
      feishuRecords: remoteKeys.length, localRecords: localKeys.length,
      missingColumns, missingOptions,
      localOnly: cap(localOnlyAll), localOnlyCount: localOnlyAll.length,
      remoteOnly: cap(remoteOnlyAll), remoteOnlyCount: remoteOnlyAll.length
    };
    summary.missingColumns += missingColumns.length;
    summary.missingOptions += missingOptions.reduce((a, m) => a + m.usedButMissing.length, 0);
    summary.localOnly += localOnlyAll.length;
    summary.remoteOnly += remoteOnlyAll.length;
  }));
  report.summary = summary;
  return report;
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
    req.on('data', c => { b += c; if (b.length > 4e6) { reject(new Error('body 过大（上限 4MB）')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

module.exports = {
  BASE_TOKEN, TABLES, PUSH_ORDER, TABLE_DEFS, WIP_TYPE_NAMES, WIP_TYPE_CODES, KIND, FIELD_TYPE,
  T, N, D, DT, fmtLocal, pad, toMs,
  tenantToken, listRecords, listFields, fieldNames, validateFields, pullState, reconcile,
  batchUpdate, batchCreate, coerceFields, mapUp, mapDown, upsertRecords, deleteRecords, writeStock,
  searchRecords, probeChangeDetection, dumpSearchShape,
  fsError, setCors, readBody
};
