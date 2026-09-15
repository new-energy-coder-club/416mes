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
function DOWN_TXN(f) {
    const d = toDate(f['时间']);
    return {
      seq: parseInt(T(f['流水号']).replace('#', ''), 10) || null,
      ts: d ? d.toISOString() : '',
      // 显式格式化：不能用 toLocaleString()，Vercel 运行时是 en-US，会输出英文 12 小时制
      time: d ? fmtLocal(d) : T(f['时间']),
      device: 'feishu', operator: T(f['操作人']), type: T(f['类型']), matCode: T(f['物料码']),
      delta: N(f['变动']), balance: f['余量'] == null ? '' : N(f['余量']), ref: T(f['关联单']), reason: T(f['原因/备注'])
    };
}

const WIP_TYPE_NAMES = { LL: 'LL 领料', BH: 'BH 补货', JH: 'JH 拣货', TL: 'TL 退料' };

/**
 * 8 张表的唯一一份定义：飞书表名、业务主键、双向字段映射。
 * 云端（本文件）与 CLI（feishu-sync.mjs）共用同一套语义，避免两边漂移。
 *   table  飞书里的表名（用于报错信息）
 *   key    业务主键列名（增删改查都按它定位记录）
 *   up     本地对象 → 飞书写入字段
 *   down   飞书字段 → 本地对象
 */
const TABLE_DEFS = {
  materials: {
    table: '物料台账', key: '物料码',
    up: m => ({
      '物料码': m.code || '', '名称': m.name || '', '规格型号': m.spec || '', '闲鱼XY编号': m.xy || '',
      '当前库位码': m.loc || '', '容器码': m.container || '',
      '库存数量': N(m.qty), '安全库存': N(m.minQty), '成本': N(m.cost)
    }),
    down: f => ({ code: T(f['物料码']), name: T(f['名称']), spec: T(f['规格型号']), xy: T(f['闲鱼XY编号']), loc: T(f['当前库位码']), container: T(f['容器码']), qty: N(f['库存数量']), minQty: N(f['安全库存']), cost: N(f['成本']) })
  },
  locations: {
    table: '库位', key: '库位码',
    up: l => ({ '库位码': l.code || '', '类型': l.kind || '货架', '说明': l.desc || '', '授权人员': l.grants || '' }),
    down: f => ({ code: T(f['库位码']), kind: T(f['类型']), desc: T(f['说明']), grants: T(f['授权人员']) })
  },
  containers: {
    table: '容器', key: '容器码',
    up: c => ({ '容器码': c.code || '', '容器类型': c.type || '', '规格': c.spec || '', '当前库位码': c.loc || '' }),
    down: f => ({ code: T(f['容器码']), type: T(f['容器类型']), spec: T(f['规格']), loc: T(f['当前库位码']) })
  },
  members: {
    table: '人员', key: '编号',
    up: m => ({ '编号': m.code || '', '姓名': m.name || '', '学号': m.sid || '', '部门/SIG': m.dept || '', '职务': m.role || '成员', '电话': m.phone || '', '备注': m.note || '', '标签': m.group || '', 'PIN码': m.pin || '' }),
    down: f => ({ code: T(f['编号']), name: T(f['姓名']), sid: T(f['学号']), dept: T(f['部门/SIG']), role: T(f['职务']) || '成员', phone: T(f['电话']), note: T(f['备注']), group: T(f['标签']), pin: T(f['PIN码']) })
  },
  items: {
    table: '物品', key: '物品码',
    up: i => ({ '物品码': i.code || '', '名称': i.name || '', '规格型号': i.spec || '', '库位码': i.loc || '' }),
    down: f => ({ code: T(f['物品码']), name: T(f['名称']), spec: T(f['规格型号']), loc: T(f['库位码']) })
  },
  manuals: {
    table: '手册', key: '手册码',
    up: m => ({ '手册码': m.code || '', '名称': m.name || '', '版本': m.ver || '', '库位码': m.loc || '' }),
    down: f => ({ code: T(f['手册码']), name: T(f['名称']), ver: T(f['版本']), loc: T(f['库位码']) })
  },
  workorders: {
    table: '工单记录', key: '工单号',
    up: w => {
      const o = {
        '工单号': w.code || '', '类型': WIP_TYPE_NAMES[w.type] || w.type || '', '日期': w.date || '',
        '明细': (w.items || []).map(i => i.matCode + 'x' + i.qty).join('; '),
        '状态': w.status || '未执行'
      };
      // 执行时间列是「日期」类型 → 必须传毫秒时间戳
      const t = w.execTime ? new Date(w.execTime) : null;
      o['执行时间'] = (t && !isNaN(t)) ? t.getTime() : null;
      // Phase 3 的执行明细（列不存在时会被 schema 过滤掉并给出提示，不会整体失败）
      o['执行数量'] = (w.execQty || []).map(e => e.matCode + '=' + e.qty).join('; ');
      o['执行批次'] = (w.execBatches && w.execBatches.length) ? JSON.stringify(w.execBatches) : '';
      o['冲销记录'] = w.reverseInfo ? JSON.stringify(w.reverseInfo) : '';
      o['取消记录'] = w.cancelInfo ? JSON.stringify(w.cancelInfo) : '';
      return o;
    },
    down: f => ({
      code: T(f['工单号']), type: WIP_TYPE_CODES[T(f['类型'])] || T(f['类型']) || 'LL', date: D(f['日期']),
      status: T(f['状态']) || '未执行', execTime: DT(f['执行时间']),
      items: T(f['明细']).split(';').map(s => s.trim()).filter(Boolean).map(s => { const m = s.match(/^(.+?)[x×](\d+(?:\.\d+)?)$/); return m ? { matCode: m[1], qty: +m[2] } : null; }).filter(Boolean),
      execQty: T(f['执行数量']).split(';').map(s => s.trim()).filter(Boolean).map(s => { const m = s.match(/^(.+?)=(\d+(?:\.\d+)?)$/); return m ? { matCode: m[1], qty: +m[2] } : null; }).filter(Boolean),
      execBatches: (() => { try { const j = JSON.parse(T(f['执行批次'])); return Array.isArray(j) ? j : []; } catch { return []; } })(),
      reverseInfo: (() => { try { const j = JSON.parse(T(f['冲销记录'])); return (j && typeof j === 'object') ? j : undefined; } catch { return undefined; } })(),
      cancelInfo: (() => { try { const j = JSON.parse(T(f['取消记录'])); return (j && typeof j === 'object') ? j : undefined; } catch { return undefined; } })()
    })
  },
  transactions: {
    table: '库存流水', key: '流水号',
    up: t => ({
      '流水号': t.seq == null ? '' : '#' + pad(t.seq, 6),
      '时间': t.ts ? new Date(t.ts).getTime() : (t.time ? new Date(t.time).getTime() : Date.now()),
      '操作人': t.operator || '', '类型': t.type || '', '物料码': t.matCode || '',
      '变动': N(t.delta), '余量': (t.balance === '' || t.balance == null) ? null : N(t.balance),
      '关联单': t.ref || '', '原因/备注': t.reason || ''
    }),
    down: DOWN_TXN
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
    state[key] = recs.map(r => TABLE_DEFS[key].down(r.fields)).filter(r => (key === 'transactions' ? r.matCode || r.seq != null : r.code));
  }
  // 网页端约定：库存流水「新的在前」
  state.transactions.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  state.txnSeq = Math.max(0, ...state.transactions.map(t => t.seq || 0));
  return state;
}

/* ---------- 表结构（用于确认各列的真实字段类型，避免写错格式） ---------- */
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
  let seq = null, txnFields = null;
  try {
    const txns = await listRecords(token, TABLES.transactions);
    const maxSeq = txns.reduce((m, r) => Math.max(m, parseInt(T(r.fields['流水号']).replace('#', ''), 10) || 0), 0);
    seq = maxSeq + 1;
    txnFields = {
      '流水号': '#' + pad(seq, 6),
      '时间': Date.now(),   // 日期列必须传毫秒时间戳；传字符串会报 DatetimeFieldConvFail
      '操作人': operator || '',
      '类型': type || '手工调整',
      '物料码': matCode,
      '变动': typeof delta === 'number' ? delta : 0,
      '余量': qty,
      '关联单': ref || '',
      '原因/备注': reason || ''
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  // dry-run：只按表结构校验格式，不写任何数据
  if (dryRun) {
    try {
      const problems = []
        .concat(await validateFields(token, TABLES.materials, { '库存数量': qty }, '物料台账'))
        .concat(await validateFields(token, TABLES.transactions, txnFields, '库存流水'));
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
    return { ok: true, seq, before: N(hit.fields['库存数量']), balance: qty };
  } catch (e) {
    // 库存已改、流水没写上：必须明确告知，否则账实与流水会脱节
    return { ok: false, seq, error: '库存已改为 ' + qty + '，但流水写入失败：' + ((e && e.message) || e), warning: 'stock_written_txn_failed' };
  }
}

/* ---------- 通用增删改查（8 张表共用一套） ---------- */

/** 表结构缓存：一次进程内不重复拉（serverless 每次冷启动各拉一次，开销可接受） */
const _fieldCache = Object.create(null);
async function fieldNames(token, tableId) {
  if (!_fieldCache[tableId]) {
    const defs = await listFields(token, tableId);
    _fieldCache[tableId] = defs.map(d => d.name);
  }
  return _fieldCache[tableId];
}

/**
 * 按业务主键批量新建或更新记录（8 张表通用）。
 *
 * 关键设计：**按表结构过滤字段**。
 * 飞书表里没有的列直接丢掉并列入 dropped 返回，而不是让整批写入失败 ——
 * 这样工单记录少了「执行批次」列时，其余字段照常同步，只是提示你补列。
 *
 * @param {string} keyName  TABLE_DEFS 里的表键（materials / members / workorders …）
 * @param {Array}  records  本地对象数组
 * @returns {{created:number, updated:number, dropped:string[], unknownTable?:string}}
 */
async function upsertRecords(keyName, records) {
  const def = TABLE_DEFS[keyName];
  if (!def) return { created: 0, updated: 0, dropped: [], error: '未知的表：' + keyName };
  const tableId = TABLES[keyName];
  if (!tableId) return { created: 0, updated: 0, dropped: [], error: '未配置表 ID：' + keyName };

  const token = await tenantToken();
  const existingNames = await fieldNames(token, tableId);
  const rows = await listRecords(token, tableId);

  const toCreate = [], toUpdate = [], dropped = new Set();
  (records || []).forEach(r => {
    const raw = def.up(r);
    const fields = {};
    Object.entries(raw).forEach(([k, v]) => {
      if (!existingNames.includes(k)) { dropped.add(k); return; }   // 表里没这列 → 丢弃并提示
      if (v !== null && v !== undefined) fields[k] = v;
    });
    const bizKey = String(fields[def.key] == null ? '' : fields[def.key]);
    if (!bizKey) return;                                            // 没有业务键 → 跳过
    const hit = rows.find(x => T(x.fields[def.key]) === bizKey);
    if (hit) toUpdate.push({ record_id: hit.record_id, fields });
    else toCreate.push({ fields });
  });

  if (toCreate.length) await batchCreate(token, tableId, toCreate);
  if (toUpdate.length) await batchUpdate(token, tableId, toUpdate);
  return { created: toCreate.length, updated: toUpdate.length, dropped: [...dropped] };
}

/** 按业务主键批量删除（8 张表通用） */
async function deleteRecords(keyName, keys) {
  const def = TABLE_DEFS[keyName];
  if (!def) return { deleted: 0, error: '未知的表：' + keyName };
  const tableId = TABLES[keyName];
  if (!tableId) return { deleted: 0, error: '未配置表 ID：' + keyName };

  const token = await tenantToken();
  const rows = await listRecords(token, tableId);
  const want = new Set((keys || []).map(k => String(k)));
  const ids = rows.filter(r => want.has(T(r.fields[def.key]))).map(r => r.record_id);
  if (!ids.length) return { deleted: 0 };

  const res = await fetch(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records/batch_delete', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: ids })
  });
  const j = await res.json();
  if (j.code !== 0) throw fsError('删除表 ' + tableId, j);
  return { deleted: ids.length };
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
  BASE_TOKEN, TABLES, PUSH_ORDER, TABLE_DEFS, WIP_TYPE_NAMES,
  T, N, D, DT, fmtLocal, pad,
  tenantToken, listRecords, listFields, fieldNames, validateFields, pullState,
  batchUpdate, batchCreate, upsertRecords, deleteRecords, writeStock,
  fsError, setCors, readBody
};
