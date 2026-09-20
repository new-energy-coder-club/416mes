#!/usr/bin/env node
/**
 * nec-sync.mjs — NEC 小工单 ↔ 飞书同步脚本（基于 lark-cli）
 * 同步口径：新增/修改双向；删除仅本地（飞书侧删行需手工，pull 不会复活已删单）
 *
 * 用法：
 *   node nec-sync.mjs init                          # 初始化：建多维表格 + 选通知群 + 写配置
 *   node nec-sync.mjs push [nec-wip-export.json] [--dry-run]   # 推送工单到多维表格 + 群通知
 *   node nec-sync.mjs pull [nec-wip-import.json]               # 从多维表格拉回工单（生成「导入合并」文件）
 *   node nec-sync.mjs status                        # 查看配置与连通性
 *
 * 配置文件：nec-sync.config.json（app_token / table_id / chat_id / chat_name，不含密钥）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DIR = path.normalize(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')));
const CONFIG_FILE = path.join(DIR, 'nec-sync.config.json');
const DEFAULT_EXPORT = path.join(DIR, 'nec-wip-export.json');

const NEC_TYPE_NAMES = { RW: '任务', LL: '领料', CG: '采购', WX: '维修', HD: '活动', QT: '其他' };

/* ---------- lark-cli 调用封装 ---------- */
// Windows cmd/shell 会丢失 JSON 中的引号或吃掉 @，复杂 JSON 一律落临时文件用 "@./file" 传
function larkJsonFile(payload) {
  const f = '.nec-json-' + Date.now() + '.tmp.json';
  fs.writeFileSync(path.join(DIR, f), JSON.stringify(payload));
  return { flag: '"@./' + f + '"', cleanup: () => { try { fs.unlinkSync(path.join(DIR, f)); } catch {} } };
}
function lark(args, { dryRun = false, input = null } = {}) {
  const cmd = 'lark-cli';
  if (dryRun) {
    console.log('  [dry-run] lark-cli ' + args.map(a => (a.length > 80 ? a.slice(0, 80) + '…' : a)).join(' '));
    return null;
  }
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32', input: input || undefined });
    return JSON.parse(out);
  } catch (e) {
    const msg = (e.stdout || '') + (e.stderr || '') || e.message;
    throw new Error('lark-cli 调用失败：' + msg.slice(0, 500));
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, ans => { rl.close(); res(ans.trim()); }));
}

/* ---------- init ---------- */
async function init() {
  console.log('== NEC 小工单 · 飞书同步初始化 ==\n');
  const fields = [
    { name: '工单号', type: 'text' },
    { name: '标题', type: 'text' },
    { name: '类型', type: 'select', options: Object.values(NEC_TYPE_NAMES).map(n => ({ name: n })) },
    { name: '负责人', type: 'text' },
    { name: '优先级', type: 'select', options: [{ name: '高' }, { name: '中' }, { name: '低' }] },
    { name: '截止日期', type: 'text' },
    { name: '状态', type: 'select', options: [{ name: '待处理' }, { name: '进行中' }, { name: '已完成' }, { name: '已取消' }] },
    { name: '关联物料', type: 'text' },
    { name: '备注', type: 'text' },
    { name: '创建时间', type: 'text' },
    { name: '完成时间', type: 'text' }
  ];
  console.log('① 创建多维表格「NEC小工单台账」…');
  // Windows cmd 会吃参数首字符 @，写成文件并加双引号传 @相对路径
  const fieldsFile = '.nec-fields.tmp.json';
  fs.writeFileSync(path.join(DIR, fieldsFile), JSON.stringify(fields));
  const base = lark(['base', '+base-create', '--name', 'NEC小工单台账', '--table-name', '小工单',
    '--time-zone', 'Asia/Shanghai', '--fields', '"@./' + fieldsFile + '"']);
  fs.unlinkSync(path.join(DIR, fieldsFile));
  const appToken = base?.app_token || base?.data?.app_token || base?.app?.app_token
    || base?.data?.base?.base_token || base?.base_token;   // lark-cli 新版返回 data.base.base_token
  const tableId = base?.default_table_id || base?.data?.default_table_id || base?.table_id;
  if (!appToken) { console.error('建表返回异常：' + JSON.stringify(base).slice(0, 500)); process.exit(1); }
  console.log('   ✅ app_token = ' + appToken + '，table_id = ' + (tableId || '（默认表）'));
  const url = base?.url || base?.data?.url || '';
  if (url) console.log('   🔗 ' + url);

  console.log('\n② 选择工单通知群');
  const kw = await ask('   输入群名关键词搜索（直接回车跳过群通知配置）：');
  let chatId = '', chatName = '';
  if (kw) {
    const res = lark(['im', '+chat-search', '--query', kw, '--as', 'user']);
    const chats = res?.chats || res?.data?.chats || res?.items || [];
    if (!chats.length) { console.log('   未找到群，可稍后编辑 nec-sync.config.json 手动填 chat_id'); }
    else {
      chats.slice(0, 10).forEach((c, i) => console.log(`   [${i + 1}] ${c.name || c.chat_name || '(无名群)'}  ${c.chat_id}`));
      const pick = await ask('   选择序号（回车取 1）：');
      const c = chats[(parseInt(pick) || 1) - 1];
      chatId = c.chat_id; chatName = c.name || c.chat_name || '';
    }
  }
  saveConfig({ app_token: appToken, table_id: tableId || '', chat_id: chatId, chat_name: chatName, created_at: new Date().toLocaleString() });
  console.log('\n③ 配置已写入 nec-sync.config.json');
  console.log('   下一步：网页「NEC小工单」导出 JSON 后运行  node nec-sync.mjs push');
}

/* ---------- push ---------- */
function orderToFields(o) {
  return {
    '工单号': o.code, '标题': o.title, '类型': NEC_TYPE_NAMES[o.type] || o.type,
    '负责人': o.owner || '', '优先级': o.priority || '中', '截止日期': o.due || '',
    '状态': o.status || '待处理', '关联物料': o.materials || '', '备注': o.note || '',
    '创建时间': o.createdAt || '', '完成时间': o.doneAt || ''
  };
}
function notifyMarkdown(o, action) {
  return `**${action} NEC 小工单**\n` +
    `> 工单号：${o.code}\n> 标题：${o.title}\n> 类型：${NEC_TYPE_NAMES[o.type] || o.type} ｜ 优先级：${o.priority} ｜ 负责人：${o.owner || '—'}\n` +
    `> 状态：${o.status}${o.due ? ' ｜ 截止：' + o.due : ''}${o.note ? '\n> 备注：' + o.note : ''}`;
}
async function push(file, dryRun) {
  const cfg = loadConfig() || (dryRun ? { app_token: 'dry_run', table_id: '', chat_id: 'dry_run', chat_name: 'dry-run占位' } : null);
  if (!cfg) { console.error('未找到 nec-sync.config.json，请先运行：node nec-sync.mjs init'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('找不到导出文件：' + file + '\n请先在网页「NEC小工单」页点「导出同步文件」，并放到本目录。'); process.exit(1); }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const orders = payload.orders || [];
  if (!orders.length) { console.log('导出文件中没有工单，无需同步。'); return; }
  console.log(`== 同步 ${orders.length} 张工单到「NEC小工单台账」${dryRun ? '（dry-run）' : ''} ==\n`);

  let created = 0, updated = 0, skipped = 0, notified = 0, failed = 0;
  for (const o of orders) {
    // 1. 判重：按工单号精确搜
    const found = lark(['base', '+record-search', '--base-token', cfg.app_token,
      '--table-id', cfg.table_id || '小工单', '--keyword', o.code, '--search-field', '工单号',
      '--limit', '5', '--format', 'json'], { dryRun });
    const recs = rowsToRecords(found);
    const exact = recs.find(r => fieldText((r.fields || r)['工单号']) === o.code);
    const fields = orderToFields(o);
    let action = null;
    if (!exact) {
      const jf = larkJsonFile({ create_records: [fields] });
      try {
        lark(['base', '+record-batch-create', '--base-token', cfg.app_token, '--table-id', cfg.table_id || '小工单',
          '--json', jf.flag], { dryRun });
      } finally { jf.cleanup(); }
      created++; action = '🆕 新建';
      console.log(`  🆕 ${o.code} ${o.title} [${o.status}]`);
    } else {
      const rid = exact.record_id || exact.id;
      const old = exact.fields || exact;
      const changed = Object.entries(fields).some(([k, v]) => fieldText(old[k]) !== (v ?? '') + '');
      if (changed) {
        const jf = larkJsonFile({ update_records: { [rid]: fields } });
        try {
          lark(['base', '+record-batch-update', '--base-token', cfg.app_token, '--table-id', cfg.table_id || '小工单',
            '--json', jf.flag], { dryRun });
        } finally { jf.cleanup(); }
        updated++; action = '🔄 更新';
        console.log(`  🔄 ${o.code} ${o.title} [${o.status}]`);
      } else { skipped++; console.log(`  ⏭  ${o.code} 无变化`); }
    }
    /* 2.61.0（k3 F4）：幂等键并入内容指纹——同状态下的后续变更（改负责人/截止/备注）
       不再复用旧键被飞书去重吞掉；发送失败计入 failed 而不是照常 notified++。 */
    if (action && cfg.chat_id) {
      const fingerprint = Buffer.from(JSON.stringify([o.owner, o.due, o.priority, o.materials, o.note])).toString('base64url').slice(0, 24);
      try {
        lark(['im', '+messages-send', '--chat-id', cfg.chat_id, '--markdown', notifyMarkdown(o, action),
          '--idempotency-key', (o.code + '-' + o.status + '-' + fingerprint).slice(0, 60), '--as', 'bot'], { dryRun });
        notified++;
      } catch (err) {
        failed++;
        console.error(`  ⚠ 群通知发送失败（${o.code}）：${err.message}`);
      }
    }
  }
  console.log(`\n完成：新建 ${created}，更新 ${updated}，无变化 ${skipped}，群通知 ${notified}${failed ? '（失败 ' + failed + '）' : ''}${dryRun ? '（均未实际执行）' : ''}`);
}

/* ---------- pull（飞书 → 416MES） ---------- */
const TYPE_NAME_REV = Object.fromEntries(Object.entries(NEC_TYPE_NAMES).map(([k, v]) => [v, k]));
function fieldText(v) { return Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? x.text : x) ?? '').join('') : (v ?? '') + ''; }
// lark-cli 新版 record-list/search 返回 { data: { fields:[列名], data:[[位置数组]], record_id_list:[] } }，统一转成 { record_id, fields:{} }
function rowsToRecords(res) {
  const d = res?.data || res || {};
  if (!Array.isArray(d.data)) return res?.records || res?.items || [];
  const fields = d.fields || [], ids = d.record_id_list || [];
  return d.data.map((row, i) => {
    const f = {};
    fields.forEach((name, ci) => { f[name] = Array.isArray(row) ? row[ci] : row?.[name]; });
    return { record_id: ids[i], fields: f };
  });
}
async function pull(outFile) {
  const cfg = loadConfig();
  if (!cfg) { console.error('未找到 nec-sync.config.json，请先运行：node nec-sync.mjs init'); process.exit(1); }
  console.log('== 从「NEC小工单台账」拉回工单 ==\n');
  const res = lark(['base', '+record-list', '--base-token', cfg.app_token, '--table-id', cfg.table_id || '小工单', '--format', 'json']);
  const recs = rowsToRecords(res);
  const orders = recs.map(r => {
    const f = r.fields || r;
    return {
      code: fieldText(f['工单号']), title: fieldText(f['标题']),
      type: TYPE_NAME_REV[fieldText(f['类型'])] || 'RW', owner: fieldText(f['负责人']),
      priority: fieldText(f['优先级']) || '中', due: fieldText(f['截止日期']),
      status: fieldText(f['状态']) || '待处理', materials: fieldText(f['关联物料']),
      note: fieldText(f['备注']), createdAt: fieldText(f['创建时间']), doneAt: fieldText(f['完成时间'])
    };
  }).filter(o => o.code);
  const out = { app: '416MES', version: 2, deviceId: 'feishu-pull', exportedAt: new Date().toLocaleString(),
    state: { materials: [], locations: [], containers: [], workorders: [], necOrders: orders } };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(`拉回 ${orders.length} 张工单 → ${path.basename(outFile)}`);
  orders.forEach(o => console.log(`  ⬇  ${o.code} ${o.title} [${o.status}]`));
  console.log('\n下一步：416MES「物料台账」页 → 导入合并 → 选择该文件（同编码自动更新状态/负责人等字段）');
}

/* ---------- status ---------- */
function status() {
  const cfg = loadConfig();
  if (!cfg) { console.log('尚未初始化。运行：node nec-sync.mjs init'); return; }
  console.log('配置：');
  console.log('  多维表格 app_token：' + cfg.app_token);
  console.log('  数据表 table_id ：' + (cfg.table_id || '（默认表）'));
  console.log('  通知群：' + (cfg.chat_name || '未配置') + (cfg.chat_id ? '（' + cfg.chat_id + '）' : ''));
  console.log('  初始化时间：' + (cfg.created_at || '—'));
  try {
    const res = lark(['base', '+record-list', '--base-token', cfg.app_token, '--table-id', cfg.table_id || '小工单', '--format', 'json']);
    const total = res?.total ?? res?.data?.total ?? rowsToRecords(res).length;
    console.log('  连通性：✅ 正常，表中现有记录 ' + total + ' 条');
  } catch (e) { console.log('  连通性：❌ ' + e.message); }
}

/* ---------- 入口 ---------- */
const [, , cmd, ...rest] = process.argv;
const dryRun = rest.includes('--dry-run');
const fileArg = rest.find(a => !a.startsWith('--')) || DEFAULT_EXPORT;
try {
  if (cmd === 'init') await init();
  else if (cmd === 'push') await push(path.resolve(fileArg), dryRun);
  else if (cmd === 'pull') await pull(path.resolve(fileArg === DEFAULT_EXPORT ? path.join(DIR, 'nec-wip-import.json') : fileArg));
  else if (cmd === 'status') status();
  else {
    console.log('用法：\n  node nec-sync.mjs init\n  node nec-sync.mjs push [nec-wip-export.json] [--dry-run]\n  node nec-sync.mjs pull [nec-wip-import.json]\n  node nec-sync.mjs status');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error('❌ ' + e.message); process.exit(1); }
