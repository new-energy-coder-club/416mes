#!/usr/bin/env node
/**
 * nec-sync.mjs — NEC 小工单 ↔ 飞书同步脚本（基于 lark-cli）
 *
 * 用法：
 *   node nec-sync.mjs init                          # 初始化：建多维表格 + 选通知群 + 写配置
 *   node nec-sync.mjs push [nec-wip-export.json] [--dry-run]   # 推送工单到多维表格 + 群通知
 *   node nec-sync.mjs status                        # 查看配置与连通性
 *
 * 配置文件：nec-sync.config.json（app_token / table_id / chat_id / chat_name，不含密钥）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CONFIG_FILE = path.join(DIR, 'nec-sync.config.json');
const DEFAULT_EXPORT = path.join(DIR, 'nec-wip-export.json');

const NEC_TYPE_NAMES = { RW: '任务', LL: '领料', CG: '采购', WX: '维修', HD: '活动', QT: '其他' };

/* ---------- lark-cli 调用封装 ---------- */
function lark(args, { dryRun = false } = {}) {
  const cmd = 'lark-cli';
  if (dryRun) {
    console.log('  [dry-run] lark-cli ' + args.map(a => (a.length > 80 ? a.slice(0, 80) + '…' : a)).join(' '));
    return null;
  }
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' });
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
  const base = lark(['base', '+base-create', '--name', 'NEC小工单台账', '--table-name', '小工单',
    '--time-zone', 'Asia/Shanghai', '--fields', JSON.stringify(fields)]);
  const appToken = base?.app_token || base?.data?.app_token || base?.app?.app_token;
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

  let created = 0, updated = 0, skipped = 0, notified = 0;
  for (const o of orders) {
    // 1. 判重：按工单号精确搜
    const found = lark(['base', '+record-search', '--base-token', cfg.app_token,
      '--table-id', cfg.table_id || '小工单', '--keyword', o.code, '--search-field', '工单号',
      '--limit', '5', '--format', 'json'], { dryRun });
    const recs = found?.records || found?.data?.records || found?.items || [];
    const exact = recs.find(r => {
      const f = r.fields || r;
      const v = f['工单号'];
      const text = Array.isArray(v) ? v.map(x => x.text || x).join('') : v;
      return text === o.code;
    });
    const fields = orderToFields(o);
    let action = null;
    if (!exact) {
      lark(['base', '+record-batch-create', '--base-token', cfg.app_token, '--table-id', cfg.table_id || '小工单',
        '--json', JSON.stringify({ create_records: [fields] })], { dryRun });
      created++; action = '🆕 新建';
      console.log(`  🆕 ${o.code} ${o.title} [${o.status}]`);
    } else {
      const rid = exact.record_id || exact.id;
      const old = exact.fields || exact;
      const norm = v => (Array.isArray(v) ? v.map(x => x.text || x).join('') : (v ?? '')) + '';
      const changed = Object.entries(fields).some(([k, v]) => norm(old[k]) !== (v ?? '') + '');
      if (changed) {
        lark(['base', '+record-batch-update', '--base-token', cfg.app_token, '--table-id', cfg.table_id || '小工单',
          '--json', JSON.stringify({ update_records: { [rid]: fields } })], { dryRun });
        updated++; action = '🔄 更新';
        console.log(`  🔄 ${o.code} ${o.title} [${o.status}]`);
      } else { skipped++; console.log(`  ⏭  ${o.code} 无变化`); }
    }
    // 2. 群通知：新建或状态非「待处理」的变更
    if (action && cfg.chat_id) {
      lark(['im', '+messages-send', '--chat-id', cfg.chat_id, '--markdown', notifyMarkdown(o, action),
        '--idempotency-key', (o.code + '-' + o.status).slice(0, 50), '--as', 'bot'], { dryRun });
      notified++;
    }
  }
  console.log(`\n完成：新建 ${created}，更新 ${updated}，无变化 ${skipped}，群通知 ${notified}${dryRun ? '（均未实际执行）' : ''}`);
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
    const total = res?.total ?? res?.data?.total ?? (res?.records || res?.items || []).length;
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
  else if (cmd === 'status') status();
  else {
    console.log('用法：\n  node nec-sync.mjs init\n  node nec-sync.mjs push [nec-wip-export.json] [--dry-run]\n  node nec-sync.mjs status');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error('❌ ' + e.message); process.exit(1); }
