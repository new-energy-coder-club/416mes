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
      // 「分类」以前只存本机（Excel 有、飞书没有）→ 换设备后所有物料都退化成
      // 「QT 其他」、分类筛选失效，新物料还会全生成 QT-xxx 编号。实测线上 4 条
      // 物料的 cat 全为空就是这个原因。飞书那边补上「分类」列后这一行自动生效；
      // 列还没加时 coerceFields 会把它放进 dropped，不会写坏数据。
      // 注意**不能**用编号前缀反推分类：线上已存在 PJ-LD-001，前缀 PJ 不在分类表里。
      ['cat', '分类', KIND.TEXT],
      ['name', '名称', KIND.TEXT],
      ['spec', '规格型号', KIND.TEXT],
      ['xy', '闲鱼XY编号', KIND.TEXT],
      ['loc', '当前库位码', KIND.TEXT],
      ['container', '容器码', KIND.TEXT],
      ['zone', '模块区', KIND.TEXT],          // 列已在飞书（2026-09-16 核对），映射生效
      ['qty', '库存数量', KIND.NUM],
      ['minQty', '安全库存', KIND.NUM],
      ['cost', '成本', KIND.NUM],
      /* 「图片链接」列已于 2026-09-16 加上（用户确认）。之前它只存本机 →
         图片只在单机有效、换设备/清缓存就丢。现在映射上，随物料一起进飞书。 */
      ['img', '图片链接', KIND.TEXT]
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
      /* 「自动编号」由**飞书自己**在新建时分配，唯一且不可改。
         它不是业务键（工单号仍是人可读的 <类型><日期><3位>），但它是唯一能区分
         「同一行被读了两次」和「飞书里真的有两条同码工单」的依据 —— 而后者是会发生的：
         两台设备并发建单时，各自都读到「还没有这条」就会各建一条，
         本地按业务键合并后只看得到一条，**另一条永远不会被发现**。 */
      ['autoNo', '自动编号', KIND.TEXT],   // 只读：见下面的 downOnly
      ['execQty', '执行数量', KIND.EXECQTY],  // 飞书表里还没有这四列
      ['execBatches', '执行批次', KIND.JSONF],
      ['reverseInfo', '冲销记录', KIND.JSONF],
      ['cancelInfo', '取消记录', KIND.JSONF]
    ],
    // 只拉不推的列（飞书自己分配）
    downOnly: ['自动编号']
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
      ['reason', '原因/备注', KIND.TEXT],
      /* 「设备」列已于 2026-09-16 加上（用户确认）。多设备排查 / 冲突归因要靠它 ——
         以前唯一能判断「这条流水是哪台机器写的」的依据在飞书里是空的。 */
      ['device', '设备', KIND.TEXT]
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
  const readOnly = def.downOnly || [];
  (def.fields || []).forEach(f => {
    const [localKey, col, kind] = f;
    /* 只读列（如「自动编号」）：由飞书在新建时自己分配，**绝不能写**。
       写了不仅没意义，还会被飞书以「自动编号类型不接受空值」报成丢列 ——
       于是每次推送都多一条无意义的 dropped，久了就没人看 dropped 了。 */
    if (readOnly.indexOf(col) >= 0) return;
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

/**
 * 找出**同一个业务键对应了多条飞书记录**的情况。
 *
 * 判据用「自动编号」：它由飞书在新建时分配、唯一且不可改。
 *   · 两条记录业务键相同、自动编号也相同 → 是同一行被读了两遍（不算重复）
 *   · 两条记录业务键相同、自动编号不同   → 飞书里**确实有两行**（并发建单的典型后果）
 *   · 拿不到自动编号（列还没加/值为空）→ 退回「整行是否完全相同」判断：
 *     不完全相同就报出来（宁可多报一次，也不要漏掉一条永远不会被发现的重复单）
 *
 * 为什么必须在服务端做：客户端把远端行按业务键索引合并，重复行会被**后一条覆盖前一条**，
 * 到了界面上只剩一条 —— 从本地数据里根本推不出「飞书有两行」。
 *
 * @returns {Array<{key:string, count:number, autoNos:string[]}>}
 */
function findDuplicateKeys(def, rows) {
  if (!def || !Array.isArray(rows)) return [];
  const keyCol = def.key;
  const autoCol = (def.fields || []).map(f => f[1]).includes('自动编号') ? '自动编号' : null;
  const groups = new Map();
  rows.forEach(r => {
    const f = (r && r.fields) || {};
    const k = T(f[keyCol]);
    if (!k) return;
    const g = groups.get(k) || groups.set(k, []).get(k);
    g.push({
      auto: autoCol ? T(f[autoCol]) : '',
      sig: JSON.stringify(f)
    });
  });
  const out = [];
  groups.forEach((g, k) => {
    if (g.length < 2) return;
    const autos = [...new Set(g.map(x => x.auto).filter(Boolean))];
    const sigs = [...new Set(g.map(x => x.sig))];
    // 有自动编号以它为准；没有就按「整行是否完全一样」判断
    const reallyDuplicate = autos.length ? autos.length > 1 : sigs.length > 1;
    if (reallyDuplicate) out.push({ key: k, count: g.length, autoNos: autos });
  });
  return out;
}

/* ---------- 鉴权 ---------- */
/** 取 tenant_access_token（应用凭证，1 小时有效；每次调用都重新取，简单可靠） */
/**
 * tenant_access_token，带**进程内缓存**。
 *
 * 旧实现每次调用都去申请一次：8 表探测 = 8 次搜索 + 1 次鉴权，
 * 每次多一个往返，还白白消耗飞书 token 接口的配额。
 * 实测线上单次探测约 2 秒，其中相当一部分就是这次多余的鉴权往返。
 *
 * 缓存要点：
 *   - 提前 60 秒过期（SKEW），避免边界上刚拿到就失效
 *   - **并发去重**：同一进程里多个请求同时发现过期时只发一次申请
 *     （10 秒轮询下 8 个并行搜索会同时触发，不去重就是 8 次重复申请）
 *   - serverless 冷启动会重新申请，这是预期行为
 */
let _tokenCache = { value: '', expireAt: 0 };
let _tokenInflight = null;
const TOKEN_SKEW_MS = 60000;

async function fetchTenantToken() {
  const r = await fetch(FEISHU_HOST + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('获取 tenant_access_token 失败：' + (j.msg || j.code));
  const ttlSec = Number(j.expire) > 0 ? Number(j.expire) : 7200;
  _tokenCache = {
    value: j.tenant_access_token,
    expireAt: Date.now() + Math.max(ttlSec * 1000 - TOKEN_SKEW_MS, 30000)
  };
  return _tokenCache.value;
}

async function tenantToken() {
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    throw new Error('服务端未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }
  if (_tokenCache.value && Date.now() < _tokenCache.expireAt) return _tokenCache.value;
  if (!_tokenInflight) {
    _tokenInflight = fetchTenantToken().finally(() => { _tokenInflight = null; });
  }
  return _tokenInflight;
}

/** 仅供测试：清掉 token 缓存，避免用例之间互相影响 */
function resetTokenCache() { _tokenCache = { value: '', expireAt: 0 }; _tokenInflight = null; }

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
/**
 * 读全表记录，并**如实报告有没有真的读全**。
 *
 * 为什么必须报完整性：全量拉取的调用方要拿这份数据判断「飞书那边删了什么」，
 * 一次静默的截断就等于成批误判删除。`has_more` 只能说明「服务端认为还有下一页」，
 * 它不能证明「收到的条数 == 表里总条数」—— 所以这里同时把 `total` 带出来对比。
 * censusTable 早就这么做了（收到数 != total 就不许判删），全量路径此前是漏的。
 *
 * @returns {{items:Array, total:(number|null), fetched:number, pages:number, complete:(boolean|null)}}
 *   complete: true=已证明读全；false=证明确实没读全；null=拿不到 total，无法证明
 */
async function listRecordsEx(token, tableId) {
  const out = [];
  let pageToken = '', expected = null, pages = 0;
  do {
    const u = new URL(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records');
    u.searchParams.set('page_size', '500');
    if (pageToken) u.searchParams.set('page_token', pageToken);
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j.code !== 0) throw fsError('读取表 ' + tableId, j);
    const d = j.data || {};
    if (expected === null && typeof d.total === 'number') expected = d.total;
    out.push(...(d.items || []));
    pages++;
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return {
    items: out.map(it => ({ record_id: it.record_id, fields: it.fields || {} })),
    total: expected,
    fetched: out.length,
    pages,
    complete: expected === null ? null : out.length === expected
  };
}

/** 兼容旧调用点：只返回记录数组。需要完整性信息请用 listRecordsEx。 */
async function listRecords(token, tableId) {
  return (await listRecordsEx(token, tableId)).items;
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
    const [defs, res] = await Promise.all([listFields(token, tableId), listRecordsEx(token, tableId)]);
    const present = new Set(defs.map(d => d.name));
    state.columns[key] = [...present];
    // 完整性必须随数据一起交出去：客户端要靠它决定「敢不敢判删」。
    // 拿不到 total 时如实报 null（无法证明），而不是乐观地当 true。
    state.completeness = state.completeness || {};
    state.completeness[key] = { fetched: res.fetched, total: res.total, pages: res.pages, complete: res.complete };
    /* 不完整时**照常返回数据，但如实标记**，绝不在这里抛错。
       为什么：分页期间恰好有人在飞书里新建了一行，就会让「收到数 != total」。
       为这个良性竞态把整次同步打断，是把一个「少判几次删除」降级成「完全同步不了」——
       可用性代价远大于收益。真正的保护在下游：客户端拿这个标记拒绝判删
       （mergeRemote 要求 complete === true 才允许删除），数据一条不会丢。 */
    state[key] = res.items
      .map(r => mapDown(def, r.fields, present))
      .filter(r => (key === 'transactions' ? (r.matCode || r.seq != null) : r.code));
    // 重复业务键必须在**服务端**看出来（客户端按业务键合并后就只剩一条了）
    const dups = findDuplicateKeys(def, res.items);
    if (dups.length) { state.duplicates = state.duplicates || {}; state.duplicates[key] = dups; }
  }));
  // 网页端约定：库存流水「新的在前」
  state.transactions.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  state.txnSeq = state.transactions.reduce((m, t) => Math.max(m, (t && t.seq) || 0), 0);   // 展开运算符在数万条时会栈溢出
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
const _fieldCacheFull = Object.create(null);
const _fieldsTs = Object.create(null);
const FIELDS_TTL_MS = 5 * 60 * 1000;

/** 带类型的表结构缓存（5 分钟 TTL）——写入路径每次都要 listFields（约 0.7 秒），热实例上 0ms */
async function listFieldsCached(token, tableId) {
  const now = Date.now();
  if (_fieldCacheFull[tableId] && now - (_fieldsTs[tableId] || 0) < FIELDS_TTL_MS) return _fieldCacheFull[tableId];
  const defs = await listFields(token, tableId);
  _fieldCacheFull[tableId] = defs;
  _fieldCache[tableId] = defs.map(d => d.name);
  _fieldsTs[tableId] = now;
  return defs;
}
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
        const probe = await searchRecords(token, tableId, { pageSize: 1, fieldNames: [keyField] });
        const kv = ((probe.items || [])[0] || {}).fields;
        // 必须用 T() 归一化：search 返回的文本字段是富文本分段数组
        // [{"text":"GJ-SD-001","type":"text"}]，直接 String() 会得到 "[object Object]"
        const v = kv ? T(kv[keyField]) : null;
        if (v == null || v === '') { rec.filterByTextIs = 'no-sample-row'; }
        else {
          rec.filterSampleKey = v;
          const dIs = await searchRecords(token, tableId, {
            pageSize: 2,
            filter: { conjunction: 'and', conditions: [{ field_name: keyField, operator: 'is', value: [v] }] }
          });
          rec.filterByTextIs = 'ok';
          rec.filterByTextIsHits = (dIs.items || []).length;
        }
      } catch (e) { rec.filterByTextIs = String(e.message).slice(0, 200); }

      /* 投影是否真的省流量：只取主键列 vs 不限制列 */
      try {
        const t0 = Date.now();
        const proj = await searchRecords(token, tableId, { pageSize: 200, fieldNames: [keyField] });
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
function coerceFields(defs, fields, clearCols) {
  const byName = Object.create(null);
  defs.forEach(d => { byName[d.name] = d; });
  /* clearCols：**显式要求清空**的列名集合。
     默认行为是「空值不写」（见下面 empty 分支），因为把空当成「清空」会让
     任何一次字段缺失的推送都抹掉飞书里的值 —— 那是静默数据丢失。
     但「只进不退」也不行：容器从货位上拿走之后，「当前库位码」永远清不掉，
     用户只能删记录重建（而删记录会作废标签编码）。所以清空必须是**显式**的。 */
  const forceClear = (k) => !!(clearCols && clearCols.has && clearCols.has(k));
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
        else if (forceClear(k)) out[k] = '';   // 显式清空：写空字符串给飞书
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

/* ---------- 按业务键的精确读写（替代全表扫） ---------- */

/** 流水号撞号后的最大重试轮数 */
const SEQ_TRIES = 16;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 按某列精确查一条记录。返回 {record_id, fields} 或 null。
 * search 不可用（旧环境 / 列缺失）时退回全表读，保证契约不变。
 */
async function findOne(token, tableId, fieldName, value) {
  try {
    const d = await searchRecords(token, tableId, {
      pageSize: 2,
      filter: { conjunction: 'and', conditions: [{ field_name: fieldName, operator: 'is', value: [String(value)] }] }
    });
    const it = (d.items || [])[0];
    return it ? { record_id: it.record_id, fields: it.fields || {} } : null;
  } catch (_) {
    const rows = await listRecords(token, tableId);
    return rows.find(r => T(r.fields[fieldName]) === String(value)) || null;
  }
}

/** 按某列精确查全部匹配（并发去重收敛用） */
async function findMany(token, tableId, fieldName, value) {
  try {
    const out = [];
    let pt = '';
    do {
      const d = await searchRecords(token, tableId, {
        pageSize: 500, pageToken: pt || undefined,
        filter: { conjunction: 'and', conditions: [{ field_name: fieldName, operator: 'is', value: [String(value)] }] }
      });
      out.push(...(d.items || []));
      pt = d.has_more ? d.page_token : '';
    } while (pt);
    return out.map(it => ({ record_id: it.record_id, fields: it.fields || {} }));
  } catch (_) {
    return (await listRecords(token, tableId))
      .filter(r => T(r.fields[fieldName]) === String(value))
      .map(r => ({ record_id: r.record_id, fields: r.fields || {} }));
  }
}

/**
 * 在一批业务键里查出哪些已存在 → Map(业务键 → record_id)。
 *
 * 用 `or` 连接的等值条件分块查询：改 3 条物料只查 3 个键，而不是把整张表搬下来。
 * 飞书 filter 的 or 条件数不能无限大，所以分块（每块 KEY_CHUNK 个）。
 */
async function findExistingKeys(token, tableId, keyField, keys) {
  const out = new Map();
  const list = (keys || []).filter(k => k !== '' && k != null);
  if (!list.length) return out;
  const KEY_CHUNK = 20;
  for (let i = 0; i < list.length; i += KEY_CHUNK) {
    const chunk = list.slice(i, i + KEY_CHUNK);
    const conditions = chunk.map(k => ({ field_name: keyField, operator: 'is', value: [String(k)] }));
    let d, pt = '';
    do {
      d = await searchRecords(token, tableId, {
        pageSize: 500, pageToken: pt || undefined,
        filter: { conjunction: 'or', conditions }
      });
      (d.items || []).forEach(r => { const k = T(r.fields[keyField]); if (k) out.set(k, r.record_id); });
      pt = d.has_more ? d.page_token : '';
    } while (pt);
  }
  return out;
}

/** 数一数某列等于某值的有几条（撞号检测用，比全表扫便宜得多） */
async function countBy(token, tableId, fieldName, value) {
  try {
    const d = await searchRecords(token, tableId, {
      pageSize: 2,
      filter: { conjunction: 'and', conditions: [{ field_name: fieldName, operator: 'is', value: [String(value)] }] }
    });
    if (typeof d.total === 'number') return d.total;
    return (d.items || []).length;
  } catch (_) {
    return (await listRecords(token, tableId)).filter(r => T(r.fields[fieldName]) === String(value)).length;
  }
}

/** 取流水表当前最大流水号 + 1 */
async function nextSeq(token) {
  try {
    const d = await searchRecords(token, TABLES.transactions, { pageSize: 1, sort: [{ field_name: '流水号', desc: true }] });
    const it = (d.items || [])[0];
    const n = it ? parseInt(T(it.fields['流水号']).replace('#', ''), 10) : 0;
    return (isFinite(n) ? n : 0) + 1;
  } catch (_) {
    const rows = await listRecords(token, TABLES.transactions);
    const max = rows.reduce((m, r) => Math.max(m, parseInt(T(r.fields['流水号']).replace('#', ''), 10) || 0), 0);
    return max + 1;
  }
}

/** 某物料在账本里的 Σδ（账本是唯一权威） */
async function ledgerRows(token, matCode) {
  let rows = [];
  try {
    let pt = '';
    do {
      const d = await searchRecords(token, TABLES.transactions, {
        pageSize: 500, pageToken: pt || undefined,
        field_names: ['流水号', '物料码', '变动', '余量'],
        filter: { conjunction: 'and', conditions: [{ field_name: '物料码', operator: 'is', value: [String(matCode)] }] }
      });
      rows = rows.concat(d.items || []);
      pt = d.has_more ? d.page_token : '';
    } while (pt);
  } catch (_) {
    rows = (await listRecords(token, TABLES.transactions)).filter(r => T(r.fields['物料码']) === String(matCode));
  }
  return rows;
}

async function sumDeltas(token, matCode) {
  return (await ledgerRows(token, matCode)).reduce((s, r) => s + N(r.fields['变动']), 0);
}

/**
 * 账本信息：Σδ 与**账本隐含期初**（最早那条流水的 余量 − 变动）。
 *
 * 为什么期初必须由账本决定，而不是「当前库存 − 账本求和」：
 * 后者是两个时刻的两次独立读，不原子。并发写入时每个写入者会算出**不同的期初**，
 * 而且各自自洽 —— 回读校验也发现不了，于是各写各的目标值，最后一个覆盖前面的，没人纠正。
 * 账本决定的期初与读取时机无关，所有并发写入者算出同一个目标值。
 * 这与 replayAudit 推断期初是同一个约定，两者永远一致。
 * 不额外花请求：这一趟本来就要把该物料的流水读全（为了求和）。
 */
async function ledgerInfo(token, matCode) {
  const rows = await ledgerRows(token, matCode);
  let sum = 0, earliest = null, earliestSeq = Infinity;
  rows.forEach(r => {
    sum += N(r.fields['变动']);
    const seq = parseInt(T(r.fields['流水号']).replace('#', ''), 10);
    const sv = Number.isFinite(seq) && seq > 0 ? seq : Infinity;   // 无号旧数据排在最后
    if (sv < earliestSeq) { earliestSeq = sv; earliest = r; }
  });
  const opening = earliest ? (N(earliest.fields['余量']) - N(earliest.fields['变动'])) : null;
  return { sum, opening, count: rows.length };
}

/**
 * 按 record_id 读回一条记录（报告真实落库值用）。返回 fields。
 * 飞书支持 GET /records/<record_id>，比全表扫便宜得多。
 */
async function readRecord(token, tableId, recordId) {
  const u = new URL(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records/' + recordId);
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  if (j.code !== 0) throw fsError('回读记录 ' + recordId, j);
  return (j.data && j.data.record && j.data.record.fields) || {};
}

/** 读回物料行当前的库存数量 */
async function readQty(token, recordId) {
  const u = new URL(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + TABLES.materials + '/records/' + recordId);
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  if (j.code !== 0) throw fsError('回读物料 ' + recordId, j);
  return N(j.data && j.data.record && j.data.record.fields && j.data.record.fields['库存数量']);
}

/** 按 record_id 删记录（撞号回滚用） */
async function batchDelete(token, tableId, ids) {
  if (!ids || !ids.length) return;
  const r = await fetch(FEISHU_HOST + '/open-apis/bitable/v1/apps/' + BASE_TOKEN + '/tables/' + tableId + '/records/batch_delete', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: ids })
  });
  const j = await r.json();
  if (j.code !== 0) throw fsError('删除表 ' + tableId, j);
}

/**
 * 库存直写：追加一条库存流水 + 把物料行「库存数量」更新成账本的物化视图。
 *
 * Phase 0 的三处关键修正（旧的读-改-写绝对值写法在多设备下必然丢更新）：
 *
 *   1) **账本优先**：先写 append-only 的库存流水，再更新 qty。飞书没有事务，
 *      旧的「先改 qty 再写流水」一旦第二步失败就留下 `stock_written_txn_failed`
 *      —— 库存被改了但没有任何凭据说明为什么改。反过来写，最坏情况只是
 *      qty 暂时落后于账本，而账本是完整的，可以重放修复。
 *
 *   2) **delta 语义 + 账本仲裁**：qty 不再由客户端算好绝对值传来。服务端读当前值，
 *      按「当前 + delta」写回，然后**回读账本求和**校验：qty 必须等于
 *      opening + Σδ。若两台设备同时写，各自都写成功了却互相覆盖（旧代码在这里
 *      静默丢一次更新），回读会发现 qty 对不上账本，于是按账本重算并再写一次，
 *      有限次收敛。qty 谁说了都不算，把流水加一遍说了算。
 *
 *   3) **seq 写后回读重试**：流水号原来是「全表扫一遍取 max + 1」，两个 Vercel
 *      实例并发读到同一个 max 就撞号；而 mergeRemote 以 seq 为主键，后到者会把
 *      先到者顶掉且审计判不出来。现在写完立刻按流水号精确回读，发现同号就删掉
 *      自己刚写的那条、重取 max 再来。
 *
 * @returns {{ok:boolean, seq?:number, error?:string, warning?:string, duplicate?:boolean}}
 */
async function writeStock({ matCode, qty, delta, operator, type, reason, ref, opId, dryRun, ts, device }) {
  /* ts：**客户端那次操作的时间**，可选。
     不传就退回服务端当前时间。为什么要让客户端传：本地那条乐观流水记的是客户端时间，
     而服务端另盖一个时间戳会让同一次操作在两边差 1–2 秒 —— 拉回来时就成了「两边都改了」
     的冲突（虽然现在 ts/time 已按派生字段处理、不再问人，但时间值本身也该是操作时间，
     而不是"服务端什么时候处理到这条请求"）。 */
  const opTs = (ts && !isNaN(new Date(ts).getTime())) ? new Date(ts).toISOString() : new Date().toISOString();
  if (!matCode) return { ok: false, error: '缺 matCode' };
  if (qty !== undefined && (typeof qty !== 'number' || !isFinite(qty))) return { ok: false, error: 'qty 必须是数字' };
  if (delta !== undefined && (typeof delta !== 'number' || !isFinite(delta))) return { ok: false, error: 'delta 必须是数字' };
  if (qty === undefined && delta === undefined) return { ok: false, error: '缺 qty 或 delta' };

  // 分段计时：写入要顺序调用飞书多次，每段多慢必须能看见（健康面板/诊断用）
  const T0 = Date.now();
  const timing = { token: 0, lookup: 0, seq: 0, create: 0, verify: 0, qty: 0, total: 0, calls: 0 };
  const mark = (k, from) => { timing[k] = Date.now() - from; };
  const bump = () => { timing.calls++; };

  let token;
  try { const t = Date.now(); token = await tenantToken(); bump(); mark('token', t); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  /* 1) 四段**独立**的预读并行发（O1）。
     这里以前是四次串行 await：找物料行 → 读流水表结构 → 按操作ID 查重 → 读账本。
     四次都是**读**、互相不依赖，串行等于白等 3 个往返（实测飞书侧一次约 0.9 秒）。
     为什么以前不敢并行：那时「期初」是用 `当前 qty − Σδ` 反推的，两次读不原子，
     两个并发写入者会各自算出**不同但自洽**的期初，最后一个覆盖前面的。
     现在期初由账本本身决定（最早那条流水的 余量−变动，与读取时刻无关），
     所以并行不再影响结果 —— 并发用例（+2/+2 必须等于 +4）就是这条的回归闸门。 */
  let hit, txnDefs, li, dup;
  const tPre = Date.now();
  /* 并行的每一支都要**先挂一个兜底 catch** 再交给 await。
     为什么：任何一支失败而我们提前 return 时，剩下还在飞的 promise 若无人处理，
     就变成 unhandledRejection —— 测试里会直接判失败，线上会让进程记一条
     "Uncaught (in promise)"。这里挂的 catch 只负责"标记已处理"，
     真正的错误仍然由下面的 await + try/catch 如实抛出。 */
  const guard = pr => { pr.catch(() => { }); return pr; };
  const pLookup = guard(findOne(token, TABLES.materials, '物料码', matCode));
  const pDefs = guard(listFieldsCached(token, TABLES.transactions));
  const pLedger = guard(ledgerInfo(token, matCode));
  const pDup = guard(opId ? findOne(token, TABLES.transactions, '操作ID', String(opId)) : Promise.resolve(null));
  // 物料必须存在，否则直接失败（这条是硬前置，它的错误要如实抛出）
  try { hit = await pLookup; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  // 流水表结构读不到 → 干脆不动库存（否则会出现「库存改了、没有任何凭据」的脱节状态）
  try { txnDefs = await pDefs; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  try { li = await pLedger; } catch (_) { li = null; }
  try { dup = await pDup; } catch (_) { dup = null; }
  bump(); bump(); bump(); if (opId) bump();
  mark('lookup', tPre);   // 四段并行合起来算一段（看总耗时即可）
  if (!hit) return { ok: false, error: '物料码 ' + matCode + ' 不在飞书台账（请先在网页端建档并 push，或先在飞书表里建这条物料）' };

  /* 2) 幂等：操作ID 已经落库就是重放，直接返回上次结果，绝不再记一次账。
     查重是**乐观并行发起**的：只有在流水表真的有「操作ID」列时结果才算数
     （列不存在时 findOne 会失败，上面已兜成 null）。 */
  const hasOpCol = txnDefs.some(d => d.name === '操作ID');
  if (opId && hasOpCol && dup) {
    const f = dup.fields || {};
    return {
      ok: true, duplicate: true, opId,
      seq: parseInt(T(f['流水号']).replace('#', ''), 10) || undefined,
      balance: N(f['余量'])
    };
  }

  const before = N(hit.fields['库存数量']);
  const actualDelta = delta === undefined ? qty - before : delta;
  const targetQty = before + actualDelta;
  if (!isFinite(targetQty) || !isFinite(actualDelta)) return { ok: false, error: '目标库存非法' };

  /* 期初由**账本**决定（最早那条流水的 余量−变动），而不是「当前 qty − Σδ」。
     后者是两次独立读、不原子，并发时每个写入者会算出不同的期初，且各自自洽 ——
     各写各的目标值，最后一个覆盖前面的，没人纠正。 */
  let sumBefore = 0, opening = null;
  if (li) { sumBefore = li.sum; opening = li.opening; }
  // 账本里还没有任何流水时（全新物料）没有「隐含期初」，退回用当前库存反推
  if (opening === null) opening = before - sumBefore;

  /* 流水的「余量」必须由**账本**推出来：opening + Σδ(已有) + 本次变动。
     旧实现写的是 targetQty = before + actualDelta，而 before 是对物料行的一次
     非原子读 —— 上一次写入的 qty 还没落/被覆盖时它就是旧的。实测线上 id#18
     正是这样：delta=+1、余量写成 13，而真实余额是 14，于是链式校验永远报 mismatch。
     注意 opening 为 null 的分支已经把 opening 回退成 before - sumBefore，
     所以下面这个式子在两种情况下都有定义。 */
  // 取 6 位小数，消除浮点累加噪声（与 mes-core 的 round6 同一约定；这里是独立模块）
  const round6 = v => Math.round((Number(v) || 0) * 1e6) / 1e6;
  const ledgerBalance = round6(opening + sumBefore + actualDelta);

  const problems = [];
  if (dryRun) {
    problems.push(...await validateFields(token, TABLES.materials, { '库存数量': targetQty }, '物料台账'));
    if (!hasOpCol && opId) problems.push('库存流水：没有「操作ID」列，幂等无法保证（请在飞书补上该列）');
    let previewSeq = null;
    try { previewSeq = await nextSeq(token); } catch (_) { previewSeq = null; }
    const preview = coerceFields(txnDefs, mapUp(TABLE_DEFS.transactions, {
      seq: previewSeq, ts: new Date().toISOString(), operator: operator || '', type: type || '手工调整',
      matCode, delta: actualDelta, balance: targetQty, ref: ref || '', reason: reason || ''
    }));
    preview.dropped.forEach(d => problems.push('库存流水：' + d));
    return {
      ok: problems.length === 0, dryRun: true,
      target: { matCode, currentQty: before, newQty: targetQty, delta: actualDelta, opening, seq: previewSeq },
      payload: preview.fields, problems
    };
  }

  /* 3) 先写流水（append-only 的账本），再改 qty */
  let seq = null, createdId = null, txnDropped = [];
  let lastErr = null;
  for (let attempt = 0; attempt < SEQ_TRIES; attempt++) {
    // 第一轮正常取号建行；之后是「改号」——**不改号而是删掉重建会形成活锁**：
    // 两边都删、又都读到空表、又都取到同一个 max，于是永远撞下去（实测踩过）。
    if (attempt === 0) {
      try {
        const tSeq = Date.now(); seq = await nextSeq(token); bump(); mark('seq', tSeq);
        const wanted = mapUp(TABLE_DEFS.transactions, {
          seq, ts: opTs, operator: operator || '', type: type || '手工调整',
          matCode, delta: actualDelta, balance: ledgerBalance, ref: ref || '', reason: reason || '',
          /* 哪台设备写的。空也照写（空字符串会被 coerceFields 当空值处理），
             但不写这一列的话「设备」永远为空 —— 多设备排查就没有依据。 */
          device: device || ''
        });
        if (opId && hasOpCol) wanted['操作ID'] = String(opId);
        const c = coerceFields(txnDefs, wanted);
        txnDropped = c.dropped;
        const tCreate = Date.now();
        const data = await batchCreate(token, TABLES.transactions, [{ fields: c.fields }]); bump(); mark('create', tCreate);
        createdId = (data && data.records && data.records[0] && data.records[0].record_id) || null;
      } catch (e) {
        return { ok: false, seq, error: '流水写入失败，库存未改动：' + ((e && e.message) || e), warning: 'txn_not_written' };
      }

      /* 3a) 同一操作ID 被并发提交时会同时穿透 check-then-write（飞书没有事务，
             这个窗口消不掉）。用「写后收敛」补上：同 opId 出现多条时，
             按 record_id 定一个稳定的幸存者，其余删掉 —— 收敛到「恰好一条账」。
             被删掉的那一方按重放返回，不再动 qty。 */
      if (opId && hasOpCol) {
        try {
          const dups = await findMany(token, TABLES.transactions, '操作ID', String(opId));
          if (dups.length > 1) {
            const ids = dups.map(d => d.record_id).sort();
            try { await batchDelete(token, TABLES.transactions, ids.slice(1)); } catch (_) {}
            if (createdId && createdId !== ids[0]) {
              const sf = (dups.find(d => d.record_id === ids[0]) || {}).fields || {};
              return {
                ok: true, duplicate: true, opId,
                seq: parseInt(T(sf['流水号']).replace('#', ''), 10) || undefined,
                balance: N(sf['余量'])
              };
            }
          }
        } catch (_) { /* 去重是加固，不是主路径；失败不阻断写入 */ }
      }
    }

    try {
      // 写后回读：同号说明另一个实例抢了同一个 max
      const tVerify = Date.now();
      let same = await findMany(token, TABLES.transactions, '流水号', '#' + pad(seq, 6)); bump(); timing.verify += Date.now() - tVerify;
      if (same.length <= 1) {
        // 一个「我看见只有一条」不足以证明唯一：另一个实例可能刚好在这个请求
        // 之后才落库同号。短暂让出事件循环后再确认一次，避免 winner 过早宣布成功。
        await sleep(2 + Math.floor(Math.random() * 5));
        const confirm = await findMany(token, TABLES.transactions, '流水号', '#' + pad(seq, 6));
        if (confirm.length <= 1) { lastErr = null; break; }
        same = confirm;
      }

      /* 撞号了。用 record_id 定序做确定性裁决：最小者保留这个号，其余改号。
         这样不会出现「两边都退让」的活锁，也不会出现「两边都坚持」的覆盖。 */
      const ids = same.map(r => r.record_id).sort();
      if (createdId && createdId === ids[0]) { lastErr = null; break; }   // 我胜出，号归我
      if (!createdId) {
        lastErr = new Error('流水号 #' + pad(seq, 6) + ' 撞号（该号当前 ' + same.length + ' 条）');
        break;   // 拿不到自己的 record_id 就没法改号，只能如实报错（避免留下孤儿行）
      }
      // 随机退避，避免多个失败者下一轮又同时抢到同一个号。
      // 号本身不加随机量：流水号要尽量连续，不能人为造洞。
      await sleep(4 + Math.floor(Math.random() * 15) + attempt * 6);
      seq = await nextSeq(token);
      await batchUpdate(token, TABLES.transactions, [{ record_id: createdId, fields: { '流水号': '#' + pad(seq, 6) } }]);
      lastErr = new Error('流水号撞号，已改号重试');
    } catch (e) {
      return { ok: false, seq, opId, error: '流水号分配失败：' + ((e && e.message) || e), warning: 'seq_collision' };
    }
  }
  if (lastErr) {
    return { ok: false, seq, error: lastErr.message + '（连续 ' + SEQ_TRIES + ' 次未取到不重复的流水号，请稍后重试）', warning: 'seq_collision' };
  }
  /* 报告真实落库的流水号，而不是本地那个变量 ——
     裁决过程中可能已经改过号，报旧值会让调用方和账本对不上。 */
  if (createdId) {
    try {
      const me = await readRecord(token, TABLES.transactions, createdId);
      const real = parseInt(T(me['流水号']).replace('#', ''), 10);
      if (isFinite(real) && real > 0) seq = real;
    } catch (_) { /* 回读失败就退回本地值，不阻断 */ }
  }

  /* 4) qty = 期初 + Σδ，回读校验，最多几轮收敛 */
  let balance = targetQty;
  let converged = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    let sumNow = actualDelta;
    try { const t = Date.now(); sumNow = await sumDeltas(token, matCode); bump(); timing.verify += Date.now() - t; } catch (_) { /* 账本读不到就退回本次增量 */ }
    const want = opening + sumNow;
    try {
      const tQty = Date.now();
      await batchUpdate(token, TABLES.materials, [{ record_id: hit.record_id, fields: { '库存数量': want } }]); bump(); mark('qty', tQty);
    } catch (e) {
      // 流水已经写进去了，账本完整 → 最坏情况是 qty 暂时落后，可重放修复
      return { ok: false, seq, opId, error: '流水已写入（#' + pad(seq, 6) + '），但库存更新失败：' + ((e && e.message) || e), warning: 'txn_written_qty_failed' };
    }
    balance = want;
    /* 并发时预读的 sumBefore 可能已经落后（另一个实例刚追加了一条）→ 收敛出来的
       want 才权威。这时把那一行的余量补正，否则链式校验会一直报 mismatch。
       只在真的不一致时才多发一次请求，非并发路径零额外开销。 */
    if (createdId && Math.abs(want - ledgerBalance) > 1e-9) {
      try {
        const tFix = Date.now();
        await batchUpdate(token, TABLES.transactions, [{ record_id: createdId, fields: { '余量': want } }]);
        bump(); timing.fixBalance = (timing.fixBalance || 0) + 1; mark('fixBalance', tFix);
      } catch (e) { /* 修不动就如实让链式校验继续报出来，绝不静默 */ }
    }
    const tRead = Date.now();
    const after = await readQty(token, hit.record_id); bump(); timing.verify += Date.now() - tRead;
    if (after === want) { converged = true; break; }
  }

  timing.total = Date.now() - T0;
  return {
    ok: true, seq, opId: opId || undefined, before, balance,
    delta: actualDelta, dropped: txnDropped, timing,
    warning: converged ? undefined : 'qty_not_converged'
  };
}

/* ---------- 增量协议（Phase 2） ----------
   三层读路径：① 廉价变更探测 ② 只拉变了的 ③ 低频键集合对账。
   只用 sort，不用 filter 按日期 —— 实测飞书 filter 对日期比较全部失败（5 种写法全挂），
   而 sort 在文本与日期上都被验证可用。 */

/** 飞书系统字段：由飞书自己在**所有**修改渠道上维护（API / 界面手改 / 批量改 / 导入 / 自动化） */
const LAST_UPDATED_COL = '最后更新时间';

/**
 * ① 廉价变更探测：每表只发一个 pageSize=1 的请求，拿最新时间戳与总条数。
 * 8 表合计约 1KB，10 秒轮询毫无压力；零变化时**不会发起任何内容请求**。
 */
async function probeTableChange(token, tableId) {
  const d = await searchRecords(token, tableId, {
    pageSize: 1,
    fieldNames: [LAST_UPDATED_COL],
    sort: [{ field_name: LAST_UPDATED_COL, desc: true }]
  });
  const it = (d.items || [])[0];
  return {
    latest: it ? N(it.fields && it.fields[LAST_UPDATED_COL]) : 0,
    total: typeof d.total === 'number' ? d.total : (d.items || []).length
  };
}

/**
 * 一次调用完成「探测 → 对变化的表立刻拉取」。
 *
 * 为什么要合并：原来客户端要打两次接口 —— 先 probe（8 个搜索，约 1.4s）
 * 再 pull（1 个搜索，约 1.8s）。两次都要经过「浏览器→Vercel→飞书」，
 * 而且各占一次 serverless 调用。合并后**省掉一整次往返与一次冷启动**，
 * 检测到变化的总耗时大约减半。零变化时不会多发任何内容请求（只探测）。
 *
 * @param {object} watermarks { [table]: {ts, seen} }
 * @returns {{probe:object, changed:string[], changes:object, watermarks:object}}
 */
async function syncChanges(watermarks) {
  watermarks = watermarks || {};
  const t0 = Date.now();
  const token = await tenantToken();
  const cachedBefore = _tokenCache.value && Date.now() < _tokenCache.expireAt;
  const tokenMs = Date.now() - t0;

  // ① 先并行探测（每表 pageSize=1）
  const probe = { at: new Date().toISOString(), tables: {}, timing: { tokenMs, tokenCached: !!cachedBefore, perTable: {}, probeMs: 0, pullMs: 0, totalMs: 0 } };
  await Promise.all(PUSH_ORDER.map(async key => {
    const tableId = TABLES[key];
    if (!tableId) return;
    const ts = Date.now();
    try { probe.tables[key] = await probeTableChange(token, tableId); }
    catch (e) { probe.tables[key] = { error: String((e && e.message) || e) }; }
    probe.timing.perTable[key] = Date.now() - ts;
  }));
  probe.timing.probeMs = Date.now() - t0;

  // ② 只对「探测说变了」的表拉取
  const changed = [];
  PUSH_ORDER.forEach(key => {
    const p = probe.tables[key];
    if (!p || p.error) return;
    const wm = watermarks[key] || { ts: 0, seen: [] };
    if (Number(p.latest || 0) > Number(wm.ts || 0)) { changed.push(key); return; }
    if (p.total != null && wm.total != null && Number(p.total) !== Number(wm.total)) changed.push(key);
  });

  const t1 = Date.now();
  const changes = {}, nextWm = {};
  await Promise.all(changed.map(async key => {
    try {
      const r = await pullChangesBySort(key, watermarks[key] || { ts: 0, seen: [] }, {});
      changes[key] = r.records;
      nextWm[key] = r.watermark;
    } catch (e) { changes[key] = []; nextWm[key] = watermarks[key] || { ts: 0, seen: [] }; }
  }));
  // 没变的表：水位顺手跟上 total，便于下次用「条数变化」也判定得出
  PUSH_ORDER.forEach(key => {
    if (nextWm[key]) return;
    const p = probe.tables[key];
    const wm = watermarks[key] || { ts: 0, seen: [] };
    nextWm[key] = (p && !p.error && p.total != null) ? { ts: Number(wm.ts || 0), seen: wm.seen || [], total: Number(p.total) } : wm;
  });
  probe.timing.pullMs = Date.now() - t1;
  probe.timing.totalMs = Date.now() - t0;

  return { probe, changed, changes, watermarks: nextWm };
}

/**
 * 延迟归因诊断（只读）：把「一次探测」拆成可比较的几段。
 *
 * 要回答的问题：单表 ~1 秒到底是**网络往返**，还是**飞书那边的排序计算**？
 * 做法是拿同一张表跑几个复杂度递增的请求：
 *   listFields            最轻的接口 → 基本等于纯网络往返基线
 *   search 无 sort        只读一条，不做排序
 *   search pageSize=1 + sort   现在的探测方式
 *   search pageSize=500 + sort 同样是排序，但要多回 499 行 —— 看数据量是否主导
 *   token 强制刷新         再取一个纯往返样本（走另一个域名路径）
 */
async function benchFeishu() {
  const tableId = TABLES.materials;
  const out = { at: new Date().toISOString(), table: '物料台账', timings: {}, tokenCached: !!(_tokenCache.value && Date.now() < _tokenCache.expireAt) };
  const time = async (label, fn) => {
    const s = Date.now();
    try { const v = await fn(); out.timings[label] = Date.now() - s; return v; }
    catch (e) { out.timings[label] = 'ERR ' + String((e && e.message) || e); return null; }
  };

  // 纯网络基线：强制重新申请一次 token（打的是同域名的另一个接口）
  await time('token_refresh(纯往返基线)', async () => { _tokenCache = { value: '', expireAt: 0 }; return tenantToken(); });
  const token = await tenantToken();

  await time('listFields(轻接口)', () => listFields(token, tableId));
  await time('search_pageSize1_无sort', () => searchRecords(token, tableId, { pageSize: 1, fieldNames: [LAST_UPDATED_COL] }));
  await time('search_pageSize1_有sort', () => searchRecords(token, tableId, { pageSize: 1, fieldNames: [LAST_UPDATED_COL], sort: [{ field_name: LAST_UPDATED_COL, desc: true }] }));
  await time('search_pageSize500_有sort', () => searchRecords(token, tableId, { pageSize: 500, sort: [{ field_name: LAST_UPDATED_COL, desc: true }] }));
  await time('search_pageSize500_无sort', () => searchRecords(token, tableId, { pageSize: 500 }));
  await time('第二次_listFields', () => listFields(token, tableId));

  const t = out.timings;
  const num = k => typeof t[k] === 'number' ? t[k] : null;
  out.conclusion = {
    networkBaselineMs: num('第二次_listFields') != null ? num('第二次_listFields') : num('listFields(轻接口)'),
    sortOverheadMs: (num('search_pageSize1_有sort') != null && num('search_pageSize1_无sort') != null)
      ? num('search_pageSize1_有sort') - num('search_pageSize1_无sort') : null,
    payloadOverheadMs: (num('search_pageSize500_有sort') != null && num('search_pageSize1_有sort') != null)
      ? num('search_pageSize500_有sort') - num('search_pageSize1_有sort') : null
  };
  return out;
}

/** 8 张表并行探测（串行会逼近 serverless 时限） */
async function probeAllChanges() {
  // 分段计时：用来回答「延迟到底花在哪一段」——
  // 是浏览器到 Vercel，还是 Vercel 到飞书。没有这个就只能靠猜。
  const t0 = Date.now();
  const cachedBefore = _tokenCache.value && Date.now() < _tokenCache.expireAt;
  const token = await tenantToken();
  const tokenMs = Date.now() - t0;

  const out = { at: new Date().toISOString(), tables: {}, timing: { tokenMs, tokenCached: !!cachedBefore, perTable: {}, slowestMs: 0, slowestTable: null, totalMs: 0 } };
  await Promise.all(PUSH_ORDER.map(async key => {
    const tableId = TABLES[key];
    if (!tableId) return;
    const ts = Date.now();
    try { out.tables[key] = await probeTableChange(token, tableId); }
    catch (e) { out.tables[key] = { error: String((e && e.message) || e) }; }
    const ms = Date.now() - ts;
    out.timing.perTable[key] = ms;
    if (ms > out.timing.slowestMs) { out.timing.slowestMs = ms; out.timing.slowestTable = key; }
  }));
  out.timing.totalMs = Date.now() - t0;
  return out;
}

/**
 * ② 增量拉取：按「最后更新时间 desc」翻页，直到整页都早于水位。
 *
 * @param {string} keyName TABLE_DEFS 表键
 * @param {object} watermark { ts, seen:[record_id...] } 水位（同一毫秒用 id 集合兜底）
 * @param {object} [opts] { pageSize=500, maxPages=20 }
 * @returns {{records:Array, raw:Array, watermark:object, pages:number, complete:boolean}}
 */
async function pullChangesBySort(keyName, watermark, opts) {
  opts = opts || {};
  const def = TABLE_DEFS[keyName];
  if (!def) throw new Error('未知的表：' + keyName);
  const tableId = TABLES[keyName];
  if (!tableId) throw new Error('未配置表 ID：' + keyName);
  const pageSize = Math.min(opts.pageSize || 500, 500);
  const maxPages = opts.maxPages || 20;
  const wm = { ts: Number((watermark && watermark.ts) || 0), seen: (watermark && watermark.seen) || [] };

  const token = await tenantToken();
  const defs = await listFields(token, tableId);
  const present = new Set(defs.map(d => d.name));
  if (!present.has(LAST_UPDATED_COL)) {
    return { records: [], raw: [], watermark: wm, pages: 0, complete: false, reason: 'missing-column' };
  }

  const raw = [];
  let pageToken = '', pages = 0;
  while (pages < maxPages) {
    const d = await searchRecords(token, tableId, {
      pageSize,
      pageToken: pageToken || undefined,
      sort: [{ field_name: LAST_UPDATED_COL, desc: true }]
    });
    const items = d.items || [];
    pages++;
    // 只保留「比水位新」的；页内 ts 单调不增，所以遇到旧的就到这里为止
    for (const it of items) {
      const ts = N(it.fields && it.fields[LAST_UPDATED_COL]);
      if (ts > wm.ts || (ts === wm.ts && wm.seen.indexOf(String(it.record_id)) < 0)) raw.push(it);
    }
    if (!items.length) break;
    if (items.length < pageSize) break;                                   // 短页 = 没有更多
    if (N(items[items.length - 1].fields && items[items.length - 1].fields[LAST_UPDATED_COL]) < wm.ts) break;
    pageToken = d.has_more ? d.page_token : '';
    if (!pageToken) break;
  }

  // 只回传本地字段；__rid / __ts 是服务端内部用的，塞进 state 会污染本地记录
  const records = raw
    .map(it => mapDown(def, it.fields, present))
    .filter(d => d && (keyName === 'transactions' ? (d.matCode || d.seq != null) : d.code));

  // 推进水位：取本批最大 ts，并记下同毫秒的全部 id
  let ts = wm.ts;
  raw.forEach(it => { const t = N(it.fields && it.fields[LAST_UPDATED_COL]); if (t > ts) ts = t; });
  const seen = new Set(ts === wm.ts ? wm.seen : []);
  raw.forEach(it => { if (N(it.fields && it.fields[LAST_UPDATED_COL]) === ts) seen.add(String(it.record_id)); });

  return { records, raw, watermark: { ts, seen: [...seen] }, pages, complete: true, columns: [...present] };
}

/**
 * ③ 键集合对账：翻完全表只取业务主键，用于发现飞书侧硬删。
 *
 * 三重闸门的第一条在这里落实：**分页必须完整成功且收到数 == total**，
 * 否则 complete=false，调用方据此放弃判删（绝不因为一次半截扫描清空本地台账）。
 */
async function censusTable(keyName, opts) {
  opts = opts || {};
  const def = TABLE_DEFS[keyName];
  if (!def) throw new Error('未知的表：' + keyName);
  const tableId = TABLES[keyName];
  if (!tableId) throw new Error('未配置表 ID：' + keyName);
  const pageSize = Math.min(opts.pageSize || 500, 500);

  const token = await tenantToken();
  try {
    const keys = [];
    let pageToken = '', expected = null, complete = true, scannedRows = 0, blankKeys = 0;
    do {
      const d = await searchRecords(token, tableId, {
        pageSize,
        pageToken: pageToken || undefined,
        fieldNames: [def.key]
      });
      if (typeof d.total === 'number' && expected === null) expected = d.total;
      const items = d.items || [];
      scannedRows += items.length;
      items.forEach(it => {
        const k = T(it.fields && it.fields[def.key]);
        if (k !== '') keys.push(k); else blankKeys++;
      });
      pageToken = d.has_more ? d.page_token : '';
    } while (pageToken);

    /* 完整性比较的是「实际收到的行数」而不是「非空业务键数」。
       飞书里有空业务键行时，旧逻辑 keys.length !== total 会永久误报分页不完整，
       从而整张表永远无法做删除对账。空键是数据质量问题，单独返回 blankKeys。 */
    if (expected !== null && scannedRows !== expected) complete = false;
    return { keys, total: expected, complete, scanned: scannedRows, blankKeys, source: 'search' };
  } catch (e) {
    return { keys: [], total: null, complete: false, error: String((e && e.message) || e), source: 'search' };
  }
}

/**
 * 工单号取号：按「类型 + 当天」在**飞书侧**查已有的最大后缀。
 *
 * 为什么必须问飞书：工单号的计数器原来只在浏览器本地（state.serials）。
 * 另一台设备建过工单后本机并不知道，于是两台设备同时建单会生成同一个工单号，
 * 而工单是按业务键 upsert 的 —— 结果不是「建了两张单」，而是**两张单互相覆盖**。
 *
 * 用 sort(工单号 desc) + filter(类型 is X) 取前几条即可，不需要全表扫。
 * @param {object} p { prefix, type, typeColumn, column, table }
 * @returns {{prefix:string, max:number, next:number, source:string}}
 */
async function maxCodeSuffix(p) {
  p = p || {};
  const tableKey = p.table || 'workorders';
  const tableId = TABLES[tableKey];
  const column = p.column || '工单号';
  const typeColumn = p.typeColumn || '类型';
  const prefix = String(p.prefix || '');
  if (!tableId) return { prefix, max: 0, next: 1, source: 'no-table' };

  const token = await tenantToken();
  let items = [];
  try {
    /* 类型必须换算成**飞书单选列里的选项名**。
       飞书「类型」是单选，选项是 'LL 领料' / 'BH 补货' / …，而调用方传的是内部短码 'LL'。
       旧实现直接拿短码去 filter：单选列上没有这个选项 → 匹配 0 行（且不报错），
       于是 max 恒为 0 ——「跨设备防撞号」看着实现了，其实一次都没生效。
       （如果飞书对无效选项报 InvalidFilter，会被下面的 catch 兜到全表读，
       那样反而"碰巧"能算对 —— 也就是这个 bug 时灵时不灵，更难发现。） */
    const typeName = p.type ? (WIP_TYPE_NAMES[String(p.type)] || String(p.type)) : '';
    const filter = (typeName && typeColumn)
      ? { conjunction: 'and', conditions: [{ field_name: typeColumn, operator: 'is', value: [typeName] }] }
      : undefined;
    const d = await searchRecords(token, tableId, {
      pageSize: 500,
      field_names: [column].concat(typeColumn ? [typeColumn] : []),
      sort: [{ field_name: column, desc: true }],
      filter
    });
    items = d.items || [];
  } catch (_) {
    items = await listRecords(token, tableId);   // search 不可用时退回全表读，保证契约不变
  }

  let max = 0;
  items.forEach(r => {
    const code = T((r.fields || {})[column]);
    if (!code || code.slice(0, prefix.length) !== prefix) return;
    const n = parseInt(code.slice(prefix.length), 10);
    if (isFinite(n) && n > max) max = n;
  });
  return { prefix, max, next: max + 1, source: 'feishu' };
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
  const defs = await listFields(token, tableId);   // 需要类型才能正确转换

  /* 服务端兜底：**已存在物料的「库存数量」不接受 upsert 写入**（新建时允许，
     因为全新物料没有账本，期初库存只能从建档时带进来）。
     客户端已经在入队与提交两处剥掉了它，这里再挡一次 ——
     旧版客户端、手工调接口、别处的脚本都可能绕过客户端那道闸门。

     为什么必须挡：库存数量是**派生量**（= 账本期初 + Σ变动），只能由 writeStock 改。
     直接覆盖会在并发时抹掉对方的增减，而且不记流水、无从追溯。
     注意**不**把它记进 `blocked`：那会让客户端把它当「受保护字段」，
     于是合并时永远不采纳飞书的值，本地库存反而会长期偏离。 */
  const qtyGuardDropped = [];

  const toCreate = [], toUpdate = [], skipped = [];
  const droppedSet = new Set();
  const droppedColumns = Object.create(null);
  const blocked = Object.create(null);                 // 业务键 → 没写进去的「本地字段」名
  const pendingNew = new Map();                       // 同一批里同业务键的记录只建一条（后者覆盖字段）

  /* 只查这一批记录涉及的业务键，不再把整张表拉下来。
     旧实现每次都 listRecords 整表：物料表几万条时，改一条物料也要传几 MB，
     而且这个开销随表增长，是真正的性能悬崖。 */
  const wantedKeys = [];
  (records || []).forEach(r => {
    const up = mapUp(def, r);
    const k = up[def.key];
    const s = T(k == null ? '' : k);
    if (s && wantedKeys.indexOf(s) < 0) wantedKeys.push(s);
  });
  let index = new Map();                              // 飞书键 → record_id
  try {
    index = await findExistingKeys(token, tableId, def.key, wantedKeys);
  } catch (_) {
    const rows = await listRecords(token, tableId);    // search 不可用才退回全表读
    rows.forEach(r => { const k = T(r.fields[def.key]); if (k) index.set(k, r.record_id); });
  }

  // 飞书列名 → 本地字段名（一列可能供给多个本地字段，如流水的「时间」）
  const localsOfCol = Object.create(null);
  (def.fields || []).forEach(([localField, col]) => {
    (localsOfCol[col] = localsOfCol[col] || []).push(localField);
  });

  /* 本地字段名 → 列名（前端只知道 loc/desc 这类本地名） */
  const clearCols = new Set();
  (opts.clearFields || []).forEach(localField => {
    (def.fields || []).forEach(([lf, col]) => { if (lf === localField) clearCols.add(col); });
  });

  (records || []).forEach(r => {
    const c = coerceFields(defs, mapUp(def, r), clearCols);
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
    if (hit) {
      // 已存在 → 库存数量只能由账本改（新建走 else 分支，保留期初库存）
      if (keyName === 'materials' && Object.prototype.hasOwnProperty.call(fields, '库存数量')) {
        delete fields['库存数量'];
        qtyGuardDropped.push('库存数量');
      }
      toUpdate.push({ record_id: hit, fields });
    }
    else if (pendingNew.has(bizKey)) Object.assign(pendingNew.get(bizKey).fields, fields);   // 同批同键 → 合并成一条
    else { const rec = { fields }; pendingNew.set(bizKey, rec); toCreate.push(rec); }
  });

  if (qtyGuardDropped.length) {
    droppedSet.add('库存数量（只能由库存直写/账本改，upsert 一律忽略）');
    droppedColumns['库存数量'] = 'qty 是派生量：必须走库存直写，否则会绕过账本覆盖并发改动';
  }
  const droppedAll = [...droppedSet];

  if (opts.dryRun) {
    return {
      dryRun: true, created: 0, updated: 0,
      wouldCreate: toCreate.length, wouldUpdate: toUpdate.length, skipped,
      dropped: droppedAll, droppedColumns, blocked
    };
  }

  if (toCreate.length) await batchCreate(token, tableId, toCreate);
  if (toUpdate.length) await batchUpdate(token, tableId, toUpdate);
  return { created: toCreate.length, updated: toUpdate.length, skipped, dropped: droppedAll, droppedColumns, blocked };
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
  const want = [];
  (keys || []).forEach(k => {
    const v = (k && typeof k === 'object') ? def.localKeyOf(k) : k;
    const fk = def.toFeishuKey(v);
    if (fk !== '' && fk != null) want.push(String(fk));
  });
  // 精确查这批键，不再整表拉取（删除几条就只查几条）
  let idx;
  try {
    idx = await findExistingKeys(token, tableId, def.key, want);
  } catch (_) {
    idx = new Map();
    (await listRecords(token, tableId)).forEach(r => { const k = T(r.fields[def.key]); if (k) idx.set(k, r.record_id); });
  }
  const ids = want.map(k => idx.get(k)).filter(Boolean);
  if (!ids.length) return { deleted: 0, notFound: want };

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
  const summary = { missingColumns: 0, missingOptions: 0, localOnly: 0, remoteOnly: 0, contentDiff: 0 };
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

    /* ---------- 内容差异（同一业务键、两边都有，但字段值不同）----------
       只报「键只在一侧」是不够的：用户最想知道的是「同一条记录，到底哪个字段不一样」。
       两边都**换算成本地形态**再比 —— 本地侧取 localField，远端侧过 DOWN[kind] 读取器。
       这样 'LL' 与飞书的 'LL 领料'、数字与数字文本、日期与时间戳都不会产生假差异
       （直接拿原始 cell 值比会满屏假报警，久了就没人看这个面板了）。 */
    const normVal = v => {
      if (v == null) return '';
      if (Array.isArray(v)) return JSON.stringify(v.map(x => (x && typeof x === 'object')
        ? { matCode: x.matCode, qty: x.qty } : x));
      if (typeof v === 'object') return JSON.stringify(v);
      if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
      return String(v).trim();
    };
    const remoteByKey = Object.create(null);
    recs.forEach(r => { remoteByKey[String(def.fromFeishuKey(T(r.fields[def.key])))] = r.fields; });
    const downOnly = def.downOnly || [];
    const diffs = [];
    let diffCount = 0;
    ((local && local[key]) || []).forEach(lr => {
      const lk = String(def.localKeyOf(lr));
      if (!lk || !(lk in remoteByKey)) return;          // 只比两边都有的
      const rf = remoteByKey[lk];
      (def.fields || []).forEach(([localField, col, kind]) => {
        if (localField === def.keyField || col === def.key) return;   // 业务键本身不算差异
        if (downOnly.indexOf(col) >= 0) return;                       // 只读列（自动编号等）不参与比对
        if (!(col in rf)) return;                                     // 飞书缺这列 → 由 missingColumns 报，不重复
        const reader = DOWN[kind] || DOWN.text;
        let rv; try { rv = reader(rf[col]); } catch (e) { rv = T(rf[col]); }
        const lv = lr[localField];
        if (normVal(lv) === normVal(rv)) return;
        diffCount++;
        if (diffs.length < 30) diffs.push({ key: lk, field: localField, column: col, local: normVal(lv).slice(0, 120), feishu: normVal(rv).slice(0, 120) });
      });
    });

    report.tables[key] = {
      table: def.table,
      feishuRecords: remoteKeys.length, localRecords: localKeys.length,
      missingColumns, missingOptions,
      localOnly: cap(localOnlyAll), localOnlyCount: localOnlyAll.length,
      remoteOnly: cap(remoteOnlyAll), remoteOnlyCount: remoteOnlyAll.length,
      diffs, diffCount
    };
    summary.missingColumns += missingColumns.length;
    summary.missingOptions += missingOptions.reduce((a, m) => a + m.usedButMissing.length, 0);
    summary.localOnly += localOnlyAll.length;
    summary.remoteOnly += remoteOnlyAll.length;
    summary.contentDiff += diffCount;
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
  BASE_TOKEN, TABLES, PUSH_ORDER, TABLE_DEFS, WIP_TYPE_NAMES, WIP_TYPE_CODES, KIND, FIELD_TYPE, findDuplicateKeys,
  T, N, D, DT, fmtLocal, pad, toMs,
  tenantToken, listRecords, listFields, fieldNames, validateFields, pullState, reconcile, maxCodeSuffix,
  batchUpdate, batchCreate, listFieldsCached, coerceFields, mapUp, mapDown, upsertRecords, deleteRecords, writeStock,
  searchRecords, probeChangeDetection, dumpSearchShape,
  ledgerInfo, ledgerRows, LAST_UPDATED_COL, probeTableChange, probeAllChanges, pullChangesBySort, censusTable, benchFeishu, syncChanges,
  fsError, setCors, readBody, resetTokenCache
};
