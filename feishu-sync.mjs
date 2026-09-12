#!/usr/bin/env node
/**
 * feishu-sync.mjs — 416MES ↔ 飞书多维表后端 双向同步（基于 lark-cli）
 *
 * 用法：
 *   node feishu-sync.mjs status                        # 配置与连通性 / 各表记录数
 *   node feishu-sync.mjs push [416MES_备份_xxx.json] [--dry-run]   # 本地备份 → 飞书（按编码 upsert，流水按 流水号 幂等）
 *   node feishu-sync.mjs pull [输出.json] [--dry-run]              # 飞书 → 本地备份 JSON（可在网页端「导入合并」）
 *
 * 闭环：网页端「导出备份 JSON」→ push 上云；pull 下载 → 网页端「导入合并」回本机。
 * 配置文件：feishu-backend.config.json（base_token / 表 ID，不含密钥）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CONFIG_FILE = path.join(DIR, 'feishu-backend.config.json');
const pad = (n, w) => String(n).padStart(w, '0');

/* ---------- lark-cli 调用封装（Windows 下 JSON 一律走 @file） ---------- */
let tmpSeq = 0;
function lark(args, { dryRun = false } = {}) {
  if (dryRun) {
    console.log('  [dry-run] lark-cli ' + args.map(a => (a.length > 100 ? a.slice(0, 100) + '…' : a)).join(' '));
    return null;
  }
  const out = execFileSync('lark-cli', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  return JSON.parse(out);
}
function larkJson(args, body, opts) {   // 带 JSON body 的调用：写临时文件用 @相对路径 传参，规避 Windows 引号问题
  const f = path.join(DIR, '.build', `_feishu_sync_${process.pid}_${tmpSeq++}.json`);
  fs.writeFileSync(f, JSON.stringify(body));
  const rel = './' + path.relative(process.cwd(), f).replace(/\\/g, '/');
  try { return lark([...args, '--json', '@' + rel], opts); }
  finally { try { fs.unlinkSync(f); } catch { } }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) { console.error('缺少 feishu-backend.config.json'); process.exit(1); }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

/* ---------- 表映射：本地 state 字段 ↔ 飞书列 ---------- */
const WIP_TYPE_NAMES = { LL: 'LL 领料', BH: 'BH 补货', JH: 'JH 拣货', TL: 'TL 退料' };
const WIP_TYPE_CODES = Object.fromEntries(Object.entries(WIP_TYPE_NAMES).map(([k, v]) => [v, k]));
const MAPS = {
  materials: {
    table: '物料台账', key: '物料码',
    up: m => ({ '物料码': m.code, '名称': m.name || '', '规格型号': m.spec || '', '闲鱼XY编号': m.xy || '', '当前库位码': m.loc || '', '容器码': m.container || '', '库存数量': m.qty || 0, '安全库存': m.minQty || 0, '成本': m.cost || 0 }),
    down: f => ({ code: T(f['物料码']), name: T(f['名称']), spec: T(f['规格型号']), xy: T(f['闲鱼XY编号']), loc: T(f['当前库位码']), container: T(f['容器码']), qty: N(f['库存数量']), minQty: N(f['安全库存']), cost: N(f['成本']) })
  },
  locations: {
    table: '库位', key: '库位码',
    up: l => ({ '库位码': l.code, '类型': l.kind || '货架', '说明': l.desc || '' }),
    down: f => ({ code: T(f['库位码']), kind: T(f['类型']), desc: T(f['说明']) })
  },
  containers: {
    table: '容器', key: '容器码',
    up: c => ({ '容器码': c.code, '容器类型': c.type || '', '规格': c.spec || '', '当前库位码': c.loc || '' }),
    down: f => ({ code: T(f['容器码']), type: T(f['容器类型']), spec: T(f['规格']), loc: T(f['当前库位码']) })
  },
  members: {
    table: '人员', key: '编号',
    up: m => ({ '编号': m.code, '姓名': m.name || '', '学号': m.sid || '', '部门/SIG': m.dept || '', '职务': m.role || '成员', '电话': m.phone || '', '备注': m.note || '' }),
    down: f => ({ code: T(f['编号']), name: T(f['姓名']), sid: T(f['学号']), dept: T(f['部门/SIG']), role: T(f['职务']) || '成员', phone: T(f['电话']), note: T(f['备注']) })
  },
  items: {
    table: '物品', key: '物品码',
    up: i => ({ '物品码': i.code, '名称': i.name || '', '规格型号': i.spec || '', '库位码': i.loc || '' }),
    down: f => ({ code: T(f['物品码']), name: T(f['名称']), spec: T(f['规格型号']), loc: T(f['库位码']) })
  },
  manuals: {
    table: '手册', key: '手册码',
    up: m => ({ '手册码': m.code, '名称': m.name || '', '版本': m.ver || '', '库位码': m.loc || '' }),
    down: f => ({ code: T(f['手册码']), name: T(f['名称']), ver: T(f['版本']), loc: T(f['库位码']) })
  },
  workorders: {
    table: '工单记录', key: '工单号',
    up: w => ({
      '工单号': w.code, '类型': WIP_TYPE_NAMES[w.type] || w.type, '日期': w.date || '',
      '明细': (w.items || []).map(i => i.matCode + 'x' + i.qty).join('; '), '状态': w.status || '未执行', '执行时间': w.execTime || ''
    }),
    down: f => ({
      code: T(f['工单号']), type: WIP_TYPE_CODES[T(f['类型'])] || T(f['类型']) || 'LL', date: D(f['日期']),
      status: T(f['状态']) || '未执行', execTime: DT(f['执行时间']),
      items: T(f['明细']).split(';').map(s => s.trim()).filter(Boolean).map(s => { const m = s.match(/^(.+?)[x×](\d+(?:\.\d+)?)$/); return m ? { matCode: m[1], qty: +m[2] } : null; }).filter(Boolean)
    })
  },
  transactions: {
    table: '库存流水', key: '流水号',
    up: t => ({
      '流水号': '#' + pad(t.seq, 6), '时间': t.ts ? fmtLocal(new Date(t.ts)) : (t.time || ''),
      '操作人': t.operator || '', '类型': t.type || '', '物料码': t.matCode || '',
      '变动': t.delta || 0, '余量': typeof t.balance === 'number' ? t.balance : null, '关联单': t.ref || '', '原因/备注': t.reason || ''
    }),
    down: f => {
      const d = toDate(f['时间']);
      return {
        seq: parseInt(T(f['流水号']).replace('#', ''), 10) || null,
        ts: d ? d.toISOString() : '',
        time: d ? d.toLocaleString() : '',
        device: 'feishu', operator: T(f['操作人']), type: T(f['类型']), matCode: T(f['物料码']),
        delta: N(f['变动']), balance: f['余量'] == null ? '' : N(f['余量']), ref: T(f['关联单']), reason: T(f['原因/备注'])
      };
    }
  }
};
const PUSH_ORDER = ['materials', 'locations', 'containers', 'members', 'items', 'manuals', 'workorders', 'transactions'];

/* ---------- CellValue 归一化 ---------- */
function T(v) { if (v == null) return ''; if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : ((x && (x.text || x.name)) || '')).join(''); return String(v); }
function N(v) { if (v == null || v === '') return 0; const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function toDate(v) {
  if (v == null || v === '') return null;
  const d = (typeof v === 'number' || /^\d+$/.test(String(v))) ? new Date(N(v)) : new Date(v);
  return isNaN(d) ? null : d;
}
function D(v) { const d = toDate(v); return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) : ''; }
function DT(v) { const d = toDate(v); return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) : ''; }
function fmtLocal(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2); }

/* ---------- 读全表（分页；+record-list 返回行式结构：fields + record_id_list + data 对齐） ---------- */
function listAll(cfg, tableId, { dryRun = false } = {}) {
  const out = [];
  let offset = 0;
  while (true) {
    const res = lark(['base', '+record-list', '--base-token', cfg.base_token, '--table-id', tableId,
      '--limit', '200', '--offset', String(offset), '--json', '--as', 'user'], { dryRun });
    if (!res) return out;
    const d = res.data || {};
    const fields = d.fields || [];
    const ids = d.record_id_list || [];
    const rows = Array.isArray(d.data) ? d.data : [];
    rows.forEach((row, i) => {
      const f = {};
      fields.forEach((name, j) => f[name] = row[j]);
      out.push({ record_id: ids[i], fields: f });
    });
    if (!d.has_more || !rows.length) break;
    offset += rows.length;
  }
  return out;
}

/* ---------- status ---------- */
function status(cfg) {
  console.log('== 416MES ↔ 飞书后端 同步状态 ==');
  console.log('Base:', cfg.url);
  const res = lark(['base', '+table-list', '--base-token', cfg.base_token, '--as', 'user']);
  const counts = {};
  (res.data.tables || []).forEach(t => counts[t.name] = t.records_count);
  for (const [name, id] of Object.entries(cfg.tables)) {
    console.log(`  ${name.padEnd(4)} ${id}  记录数 ${counts[name] ?? '?'} `);
  }
}

/* ---------- push：本地备份 → 飞书（按编码 upsert） ---------- */
async function push(cfg, file, { dryRun = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const st = pkg.state || pkg;
  if (!st || !Array.isArray(st.materials)) { console.error('不是有效的 416MES 备份文件'); process.exit(1); }
  console.log('== push ' + path.basename(file) + ' → ' + cfg.url + (dryRun ? '（dry-run）' : '') + ' ==');
  for (const key of PUSH_ORDER) {
    const rows = (st[key] || []).filter(r => r && (key !== 'transactions' ? r.code : r.seq != null));
    if (key === 'transactions' && (st[key] || []).some(r => r.seq == null))
      console.log('  库存流水：跳过 ' + (st[key] || []).filter(r => r.seq == null).length + ' 条无 seq 旧数据');
    const map = MAPS[key], tableId = cfg.tables[map.table];
    const existing = {};
    listAll(cfg, tableId, { dryRun }).forEach(r => { existing[T(r.fields[map.key])] = r.record_id || r.id; });
    const toCreate = [], toUpdate = {};
    rows.forEach(r => {
      const fields = map.up(r), code = T(fields[map.key]);
      if (existing[code]) toUpdate[existing[code]] = fields;
      else toCreate.push(fields);
    });
    console.log(`  ${map.table}：本地 ${rows.length} 条 → 新建 ${toCreate.length} / 更新 ${Object.keys(toUpdate).length}`);
    for (let i = 0; i < toCreate.length; i += 200) {
      const res = larkJson(['base', '+record-batch-create', '--base-token', cfg.base_token, '--table-id', tableId, '--as', 'user'],
        { create_records: toCreate.slice(i, i + 200) }, { dryRun });
      if (res && !res.ok) console.error('    创建失败:', JSON.stringify(res.error).slice(0, 200));
    }
    const updIds = Object.keys(toUpdate);
    for (let i = 0; i < updIds.length; i += 200) {
      const chunk = {}; updIds.slice(i, i + 200).forEach(id => chunk[id] = toUpdate[id]);
      const res = larkJson(['base', '+record-batch-update', '--base-token', cfg.base_token, '--table-id', tableId, '--as', 'user'],
        { update_records: chunk }, { dryRun });
      if (res && !res.ok) console.error('    更新失败:', JSON.stringify(res.error).slice(0, 200));
    }
  }
  console.log('push 完成');
}

/* ---------- pull：飞书 → 本地备份 JSON（网页端「导入合并」） ---------- */
async function pull(cfg, outFile, { dryRun = false } = {}) {
  console.log('== pull ' + cfg.url + ' → ' + outFile + (dryRun ? '（dry-run）' : '') + ' ==');
  const state = { materials: [], locations: [], containers: [], members: [], items: [], manuals: [], workorders: [], transactions: [], serials: {}, necOrders: [], necSerials: {}, scanLog: [] };
  for (const key of PUSH_ORDER) {
    const map = MAPS[key], tableId = cfg.tables[map.table];
    const recs = listAll(cfg, tableId, { dryRun });
    state[key] = recs.map(r => map.down(r.fields)).filter(r => key === 'transactions' ? r.matCode : r.code);
    console.log(`  ${map.table}：${state[key].length} 条`);
  }
  state.transactions.sort((a, b) => (b.seq || 0) - (a.seq || 0));   // 网页端约定：新的在前
  if (!dryRun) {
    const pkg = { app: '416MES', version: 2, deviceId: 'feishu-pull', exportedAt: new Date().toLocaleString(), state };
    fs.writeFileSync(outFile, JSON.stringify(pkg, null, 1));
    console.log('已写出 ' + outFile + ' → 网页端「导入合并」即可回本机');
  }
}

/* ---------- 入口 ---------- */
const [, , cmd, arg, ...rest] = process.argv;
const dryRun = rest.includes('--dry-run') || (arg === '--dry-run');
const cfg = loadConfig();
if (cmd === 'status') status(cfg);
else if (cmd === 'push') push(cfg, arg && arg !== '--dry-run' ? arg : path.join(DIR, '416MES_备份.json'), { dryRun });
else if (cmd === 'pull') pull(cfg, arg && arg !== '--dry-run' ? arg : path.join(DIR, '416MES_从飞书_备份.json'), { dryRun });
else {
  console.log('用法: node feishu-sync.mjs status | push [备份.json] [--dry-run] | pull [输出.json] [--dry-run]');
}
