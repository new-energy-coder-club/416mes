#!/usr/bin/env node
/**
 * scripts/feishu-crud-check.mjs — 线上「网页端 ↔ 飞书」8 表增删改查端到端验收
 *
 * 用**哨兵记录**跑真实的完整往返，验证的是部署在云端的这一整套代码路径：
 *
 *   增   POST /api/feishu/upsert   → 创建哨兵记录
 *   查   GET  /api/feishu/state    → 确认能读回来，且字段内容正确
 *   改   POST /api/feishu/upsert   → 改一个字段
 *   查   GET  /api/feishu/state    → 确认改动生效
 *   删   POST /api/feishu/delete   → 按本地业务键删除（流水传数字 seq，飞书列是 '#000001'）
 *   查   GET  /api/feishu/state    → 确认真的没了
 *
 * 外加一次 /api/feishu/reconcile 只读核对，报告飞书缺哪些列、缺哪些单选选项 ——
 * 那正是「网页端改了飞书没变」的根因。
 *
 * 用法：
 *   node scripts/feishu-crud-check.mjs
 *   node scripts/feishu-crud-check.mjs --site https://mes.newenergycoder.club
 *   node scripts/feishu-crud-check.mjs --keep      # 保留哨兵记录（排查用），默认必定清理
 *
 * 安全性：所有哨兵记录的编码都带唯一前缀 ZZT<时间戳>，脚本结束前（含异常路径）
 * 会按前缀扫一遍并删除残留，不会在生产库里留下垃圾。
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
'use strict';

const args = process.argv.slice(2);
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const SITE = (argVal('--site', process.env.SITE || 'https://mes.newenergycoder.club')).replace(/\/$/, '');
const KEEP = args.includes('--keep');
const PREFIX = 'ZZT' + String(Date.now()).slice(-7);
const KEY = { materials: 'code', locations: 'code', containers: 'code', members: 'code', items: 'code', manuals: 'code', workorders: 'code', transactions: 'seq' };
const LABEL = { materials: '物料台账', locations: '库位', containers: '容器', members: '人员', items: '物品', manuals: '手册', workorders: '工单记录', transactions: '库存流水' };
const ALL = Object.keys(KEY);

/* ---------- HTTP（Cloudflare 偶尔抽风，带退避重试） ---------- */
async function retry(fn, label, n = 5) {
  let last;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      process.stderr.write(`    ⏳ 重试 ${i + 1}/${n} ${label}：${e.cause?.code || e.message}\n`);
      await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
}
async function post(path, body) {
  return retry(async () => {
    const r = await fetch(SITE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let d = null; try { d = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, d };
  }, 'POST ' + path);
}
async function pull() {
  return retry(async () => {
    const r = await fetch(SITE + '/api/feishu/state');
    const d = await r.json();
    if (!d.ok) throw new Error('state 拉取失败：' + d.error);
    return d.state;
  }, 'GET state');
}
const keyOf = tbl => rec => KEY[tbl] === 'seq' ? rec.seq : rec.code;
const delKeyOf = tbl => rec => KEY[tbl] === 'seq' ? '#' + String(rec.seq).padStart(6, '0') : rec.code;
const find = (st, tbl, v) => (st[tbl] || []).find(x => String(keyOf(tbl)(x)) === String(v));

/* ---------- 每张表的哨兵与断言 ---------- */
const CASES = {
  materials: {
    create: { code: PREFIX + '-MAT', cat: 'QT', name: '哨兵物料', spec: 'S1', xy: '', loc: '', container: '', zone: 'M-01', qty: 7, minQty: 2, cost: 1.5 },
    patch: { name: '哨兵物料-改' },
    check: r => r.qty === 7 && r.name === '哨兵物料' && r.minQty === 2
  },
  locations: {
    create: { code: PREFIX + '-LOC', kind: '货架', desc: '哨兵库位' },
    patch: { desc: '哨兵库位-改' },
    check: r => r.kind === '货架'
  },
  containers: {
    create: { code: PREFIX + '-CTN', type: 'A4四抽收纳盒', spec: 'S2', loc: '' },
    patch: { spec: 'S2-改' },
    check: r => r.type === 'A4四抽收纳盒' && r.spec === 'S2'
  },
  members: {
    create: { code: PREFIX + '-MB', name: '哨兵', sid: 'SID1', dept: 'D1', role: '成员', phone: '13800138000', note: 'n', group: 'g' },
    patch: { name: '哨兵-改' },
    check: r => r.name === '哨兵' && r.role === '成员' && r.phone === '13800138000'
  },
  items: {
    create: { code: PREFIX + '-ITM', name: '哨兵物品', spec: 'S3', loc: '' },
    patch: { name: '哨兵物品-改' },
    check: r => r.name === '哨兵物品' && r.spec === 'S3'
  },
  manuals: {
    create: { code: PREFIX + '-MAN', name: '哨兵手册', ver: 'v1', loc: '' },
    patch: { ver: 'v2' },
    check: r => r.name === '哨兵手册' && r.ver === 'v1'
  },
  workorders: {
    create: { code: PREFIX + '-WO', type: 'LL', date: '2026-09-15', items: [{ matCode: 'X', qty: 2 }], status: '未执行' },
    patch: { status: '已执行' },
    check: r => r.type === 'LL' && r.date === '2026-09-15' && r.items.length === 1 && r.items[0].qty === 2 && r.status === '未执行'
  },
  /* ⚠️ 流水的 seq 必须紧贴真实最大 seq，**绝不能用 900001 这种「安全大数」**。
     原因（真实事故）：任何浏览器只要在哨兵存在的窗口里同步过一次，就会把
     state.txnSeq 顶到 900001；哨兵随后被删掉，账本覆盖度就**永久**报
     「缺 #24~#900000」——90 万条不存在的流水。高水位没有回退路径，
     用户端只能靠「重置高水位」手工收场。所以这里改成 realMaxSeq + 1，
     由 resolveTxnSeq() 在运行时读一次真实最大值填进来。 */
  transactions: {
    create: { seq: 0, ts: '2026-09-15T02:00:00Z', operator: '哨兵', type: '测试', matCode: PREFIX + '-MAT', delta: 0, balance: 0, ref: '', reason: '哨兵' },
    patch: { reason: '哨兵-改' },
    check: r => r.operator === '哨兵' && r.matCode === PREFIX + '-MAT'
  }
};

/* ---------- 主流程 ---------- */
const rows = [];
const fail = (tbl, step, msg) => rows.push({ tbl, step, ok: false, msg });
const pass = (tbl, step, msg) => rows.push({ tbl, step, ok: true, msg });

/* 清理哨兵：
   只清自己这一轮的 PREFIX 是不够的 —— 上一轮中途被 Ctrl-C / 断网打断时留下的记录
   没人管，会一直躺在生产库里（实测踩过：一次中断留下 4 条，肉眼看不出来）。
   所以这里扫「任何 ZZ 开头的哨兵编码」，顺便把哨兵流水也带走。 */
const TEST_CODE_RE = /^ZZ[TPNRD]/i;
/* 流水哨兵必须**精确匹配**，不能是子串。
   旧实现是 /哨兵|验收/ —— 子串匹配「验收」于是把**两条真实流水**当成哨兵删掉了：
   它们的 reason 是「P3验收·序号回写」「P3验收·冲正」（我在 P3 阶段做序号回写验证时写的）。
   更危险的是「验收」在仓库场景里是很常见的正常词（「设备验收后入库」「到货验收」），
   真有人这么写原因，一跑这个验收脚本就会被删掉 —— 这是**静默数据丢失**。
   现在只认脚本自己写的那个精确标记：operator 或 reason 恰好等于「哨兵」。 */
const TEST_TXN_RE = /^\s*哨兵\s*$/;

async function cleanup() {
  let removed = 0;
  try {
    const st = await pull();
    for (const tbl of ALL) {
      const bad = (st[tbl] || []).filter(r => TEST_CODE_RE.test(String(keyOf(tbl)(r) || '')));
      if (!bad.length) continue;
      const keys = [...new Set(bad.map(delKeyOf(tbl)))];
      const r = await post('/api/feishu/delete', { table: tbl, keys });
      removed += (r.d?.deleted || 0);
      process.stdout.write(`  🧹 清理哨兵残留 ${LABEL[tbl]}：${keys.join(', ')}\n`);
    }
    const txnBad = (st.transactions || []).filter(t =>
      TEST_CODE_RE.test(String(t.matCode || ''))
      || TEST_TXN_RE.test(String(t.reason || '')) || TEST_TXN_RE.test(String(t.operator || '')));
    if (txnBad.length) {
      const keys = txnBad.map(t => '#' + String(t.seq).padStart(6, '0'));
      const r = await post('/api/feishu/delete', { table: 'transactions', keys });
      removed += (r.d?.deleted || 0);
      process.stdout.write(`  🧹 清理哨兵残留 库存流水：${keys.join(', ')}\n`);
    }
  } catch (e) {
    process.stderr.write('  ⚠️ 清理失败，请手动检查 ZZ* 开头的记录：' + e.message + '\n');
  }
  return removed;
}

async function main() {
  process.stdout.write(`\n416MES × 飞书 8 表 CRUD 端到端验收\n  站点：${SITE}\n  哨兵前缀：${PREFIX}\n\n`);

  // 0) 连通性
  const ping = await post('/api/feishu/ping', {}).catch(() => null);
  const pingGet = await retry(async () => (await fetch(SITE + '/api/feishu/ping')).json(), 'ping');
  if (!pingGet?.ok || !pingGet.feishu) { process.stderr.write('❌ /api/feishu/ping 未就绪（feishu=false 表示云端缺 FEISHU_APP_ID/SECRET）\n'); process.exit(1); }
  process.stdout.write(`  ✅ 连通：${SITE}（via ${pingGet.via}）\n\n`);

  const before = await pull();
  const baseCount = Object.fromEntries(ALL.map(t => [t, (before[t] || []).length]));

  /* 流水哨兵的 seq 紧贴真实最大值（见 CASES.transactions 的注释）：
     用「安全大数」会把所有同步过的浏览器的 txnSeq 高水位顶上去，
     哨兵删掉后账本永久报几十万条假缺口。 */
  const realMaxSeq = (before.transactions || []).reduce((m, t) => Math.max(m, Number(t.seq) || 0), 0);
  CASES.transactions.create.seq = realMaxSeq + 1;
  process.stdout.write(`  ℹ 流水哨兵 seq=${realMaxSeq + 1}（紧贴真实最大 seq，避免污染高水位）\n`);

  try {
    /* ---- 1) 增 ---- */
    for (const tbl of ALL) {
      const r = await post('/api/feishu/upsert', { table: tbl, records: [CASES[tbl].create] });
      if (r.status === 200 && r.d?.ok && r.d.created === 1) pass(tbl, '增', 'created=1');
      else fail(tbl, '增', `HTTP ${r.status} ${JSON.stringify(r.d)}`);
    }

    /* ---- 2) 查 ---- */
    let st = await pull();
    for (const tbl of ALL) {
      const rec = find(st, tbl, CASES[tbl].create[KEY[tbl]]);
      if (!rec) { fail(tbl, '查', '新建后读不回来'); continue; }
      let ok = true, why = '';
      try { ok = !!CASES[tbl].check(rec); } catch (e) { ok = false; why = e.message; }
      if (ok) pass(tbl, '查', '字段内容正确');
      else fail(tbl, '查', '读回来的字段不对：' + JSON.stringify(rec).slice(0, 160) + (why ? ' / ' + why : ''));
    }

    /* ---- 3) 改 ---- */
    for (const tbl of ALL) {
      const merged = Object.assign({}, CASES[tbl].create, CASES[tbl].patch);
      const r = await post('/api/feishu/upsert', { table: tbl, records: [merged] });
      if (r.status === 200 && r.d?.ok && r.d.updated === 1 && r.d.created === 0) pass(tbl, '改', 'updated=1（未重复新建）');
      else fail(tbl, '改', `HTTP ${r.status} ${JSON.stringify(r.d)}`);
    }
    st = await pull();
    for (const tbl of ALL) {
      const rec = find(st, tbl, CASES[tbl].create[KEY[tbl]]);
      const [pk, pv] = Object.entries(CASES[tbl].patch)[0];
      if (!rec) { fail(tbl, '改后查', '记录不见了'); continue; }
      if (JSON.stringify(rec[pk]) === JSON.stringify(pv)) pass(tbl, '改后查', `${pk} = ${JSON.stringify(pv)}`);
      else fail(tbl, '改后查', `${pk} 仍是 ${JSON.stringify(rec[pk])}，期望 ${JSON.stringify(pv)}`);
    }

    /* ---- 4) 删 ---- */
    for (const tbl of ALL) {
      const r = await post('/api/feishu/delete', { table: tbl, keys: [delKeyOf(tbl)(CASES[tbl].create)] });
      if (r.status === 200 && r.d?.ok && r.d.deleted === 1) pass(tbl, '删', 'deleted=1');
      else fail(tbl, '删', `HTTP ${r.status} ${JSON.stringify(r.d)}`);
    }
    st = await pull();
    for (const tbl of ALL) {
      if (find(st, tbl, CASES[tbl].create[KEY[tbl]])) fail(tbl, '删后查', '记录还在');
      else pass(tbl, '删后查', '已移出');
    }

    /* ---- 5) 数量复原 ---- */
    const after = await pull();
    for (const tbl of ALL) {
      const n = (after[tbl] || []).length;
      if (n === baseCount[tbl]) pass(tbl, '无残留', `${n} 条（与开始时一致）`);
      else fail(tbl, '无残留', `${n} 条，开始时 ${baseCount[tbl]} 条`);
    }

    /* ---- 6) 只读核对：飞书缺列 / 缺选项 ----
       探针只带「本地真的会用到、且飞书可能没有」的取值。容器类型从出厂布局文件里读，
       免得把类型名写死在脚本里。网页端台账页顶部那块「对齐面板」用的是同一份数据、
       但带的是完整本地 state，是最权威的一份。 */
    let ctnTypes = ['A4四抽收纳盒', '斜角零件盒', '开放式收纳格', '四层四格牛皮纸收纳盒'];
    try {
      const fsmod = await import('node:fs');
      const layout = JSON.parse(fsmod.readFileSync(new URL('../布局导入_C区角钢货架.json', import.meta.url), 'utf8'));
      const seen = new Set([...(layout.containers || []), ...(layout.state?.containers || [])].map(c => c.type).filter(Boolean));
      if (seen.size) ctnTypes = [...seen];
    } catch { /* 没有布局文件就用上面的默认值 */ }
    const rec = await post('/api/feishu/reconcile', {
      state: {
        materials: [{ code: 'X', zone: 'M-01' }],
        locations: [{ code: 'X', kind: '模块区' }, { code: 'Y', kind: '空地' }],
        containers: ctnTypes.map((t, i) => ({ code: 'C' + i, type: t })),
        members: [{ code: 'X', role: '成员' }],
        workorders: [{ code: 'X', type: 'LL', status: '部分执行' }]
      }
    });
    if (rec.status === 200 && rec.d?.ok) {
      const t = rec.d.report.tables;
      const cols = Object.entries(t).flatMap(([k, v]) => v.missingColumns.map(c => LABEL[k] + '·' + c));
      const opts = Object.entries(t).flatMap(([k, v]) => v.missingOptions.flatMap(m => m.usedButMissing.map(o => LABEL[k] + '·' + m.column + '=' + o)));
      process.stdout.write('\n  🔎 飞书表结构核对（只读）\n');
      process.stdout.write(cols.length ? '     缺列（这些内容暂时同步不上去）：' + cols.join('、') + '\n' : '     缺列：无\n');
      process.stdout.write(opts.length ? '     缺单选选项（这些值会被丢掉）：' + opts.join('、') + '\n' : '     缺单选选项：无\n');
    } else {
      fail('reconcile', '核对', `HTTP ${rec.status} ${JSON.stringify(rec.d)}`);
    }
  } finally {
    if (KEEP) process.stdout.write(`\n  ⚠️ --keep：保留哨兵记录，前缀 ${PREFIX}（请自行清理）\n`);
    else await cleanup();
  }

  /* ---- 汇总 ---- */
  process.stdout.write('\n' + '─'.repeat(74) + '\n');
  const byTable = {};
  rows.forEach(r => { (byTable[r.tbl] = byTable[r.tbl] || []).push(r); });
  process.stdout.write('  表'.padEnd(14) + '增  查  改  改后查  删  删后查  无残留\n');
  for (const tbl of ALL) {
    const g = byTable[tbl] || [];
    const cell = name => { const x = g.find(r => r.step === name); return x ? (x.ok ? '✅' : '❌') : '－'; };
    process.stdout.write('  ' + (LABEL[tbl] || tbl).padEnd(12) +
      [cell('增'), cell('查'), cell('改'), cell('改后查'), cell('删'), cell('删后查'), cell('无残留')].map(c => c.padEnd(4)).join(' ').replace(/ {2,}/g, '  ') + '\n');
  }
  const bad = rows.filter(r => !r.ok);
  process.stdout.write('─'.repeat(74) + '\n');
  if (bad.length) {
    process.stdout.write(`\n❌ 失败 ${bad.length} 项：\n`);
    bad.forEach(r => process.stdout.write(`   · ${LABEL[r.tbl] || r.tbl} / ${r.step}：${r.msg}\n`));
    process.stdout.write('\n');
    process.exit(1);
  }
  process.stdout.write(`\n✅ 全部通过：8 张表 × 增/查/改/删 共 ${rows.length} 项断言全部成立，生产库无残留。\n\n`);
}

main().catch(async e => {
  process.stderr.write('\n❌ 验收中断：' + (e?.stack || e) + '\n');
  if (!KEEP) await cleanup();
  process.exit(1);
});
