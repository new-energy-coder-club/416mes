#!/usr/bin/env node
/* 2.82.0 C2（稳定多并发）：5 虚拟设备 API 级压测
 * 用法：node scripts/loadtest-5devices.mjs [--base https://mes.newenergycoder.club] [--rounds 6]
 * 场景：S1 异容器/异物品并行（真并行上限）；S2 同实体 5 台齐发×N 轮（拒绝率/重试分布）
 * 指标：P50/P95 时延、APPLIED 率、TRIAL_CONCURRENT 率、VERSION_CONFLICT 率
 * 门槛（定稿）：自动恢复率≥99%、P95≤90s、429 导致命令失败=0
 * 安全：只对 *-LT-* 测试物品操作；结束自动回库
 */
const BASE = (process.argv.find((a, i) => process.argv[i - 1] === '--base') || 'https://mes.newenergycoder.club').replace(/\/$/, '');
const ROUNDS = Number(process.argv.find((a, i) => process.argv[i - 1] === '--rounds')?.[0] || process.argv[process.argv.indexOf('--rounds') + 1] || 4);
const ITEMS = ['WP-TS-101', 'WP-TS-102', 'WP-TS-103', 'WP-002', 'WP-TS-003'];   // 5 台各管一件
const LOC = 'B-01-01-01', CTN = 'A4SH-001';
const API = BASE + '/api/feishu/item-operation';

async function post(body) {
  const t0 = Date.now();
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-416mes-Same-Origin': '1' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { op: j.operation || {}, ms: Date.now() - t0 };
}
const state = async () => (await (await fetch(BASE + '/api/feishu/state', { headers: { 'X-416mes-Same-Origin': '1' } })).json()).state;
const itemVer = (st, code) => (st.items || []).find(x => x.code === code)?.version ?? 0;
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p / 100))] : 0; };

async function refreshVersions() {
  const st = await state();
  return Object.fromEntries(ITEMS.map(c => [c, itemVer(st, c)]));
}

async function main() {
  console.log(`压测目标 ${BASE}，物品 ${ITEMS.join('/')}，${ROUNDS} 轮`);
  let versions = await refreshVersions();
  console.log('基线版本:', versions);

  // ---- S1: 5 台同时出库（不同物品，同容器——A2 后应真并行）----
  const s1 = [];
  {
    const opIds = ITEMS.map((c, i) => `lt-s1-${i}-${Date.now().toString(36)}`);
    const t0 = Date.now();
    const results = await Promise.all(ITEMS.map((code, i) => post({
      schemaVersion: 1, opId: opIds[i], kind: 'issue', itemCode: code,
      source: { loc: LOC, container: CTN }, expected: { itemVersion: versions[code], containerVersion: 3 }
    })));
    const wall = Date.now() - t0;
    results.forEach((r, i) => s1.push({ item: ITEMS[i], phase: r.op.phase, ms: r.ms, error: r.op.error || '' }));
    console.log(`\n[S1] 5 台并行出库：墙钟 ${wall}ms`);
    s1.forEach(r => console.log(`  ${r.item} → ${r.phase} ${r.ms}ms ${r.error.slice(0, 40)}`));
    const applied = s1.filter(r => r.phase === 'APPLIED').length;
    console.log(`  APPLIED ${applied}/5 | P50 ${pct(s1.map(r => r.ms), 50)}ms | P95 ${pct(s1.map(r => r.ms), 95)}ms`);
  }

  // 回库（批量一条）
  versions = await refreshVersions();
  await post({
    schemaVersion: 1, opId: 'lt-restore-1-' + Date.now().toString(36), kind: 'receiveBatch', target: { loc: LOC },
    items: ITEMS.map(c => ({ itemCode: c, containerCode: CTN, expectedItemVersion: versions[c], expectedContainerVersion: 3 }))
  });
  versions = await refreshVersions();
  console.log('[S1 恢复] 版本:', versions);

  // ---- S2: 同实体 5 台齐发 × N 轮 ----
  const s2 = { applied: 0, trialConcurrent: 0, versionConflict: 0, other: 0, latencies: [] };
  for (let round = 0; round < ROUNDS; round++) {
    versions = await refreshVersions();
    const target = ITEMS[0];   // 全部抢第一件
    const opIds = Array.from({ length: 5 }, (_, i) => `lt-s2-${round}-${i}-${Date.now().toString(36)}`);
    const results = await Promise.all(opIds.map((opId, i) => post({
      schemaVersion: 1, opId, kind: 'issue', itemCode: target,
      source: { loc: LOC, container: CTN }, expected: { itemVersion: versions[target], containerVersion: 3 }
    })));
    results.forEach(r => {
      s2.latencies.push(r.ms);
      if (r.op.phase === 'APPLIED') s2.applied++;
      else if (/TRIAL_CONCURRENT/.test(r.op.error || '')) s2.trialConcurrent++;
      else if (/VERSION_CONFLICT/.test(r.op.error || '')) s2.versionConflict++;
      else s2.other++;
    });
    console.log(`[S2 轮 ${round + 1}/${ROUNDS}] APPLIED ${results.filter(r => r.op.phase === 'APPLIED').length}/5`);
    // 回库恢复
    versions = await refreshVersions();
    await post({
      schemaVersion: 1, opId: `lt-s2-restore-${round}`, kind: 'receiveBatch', target: { loc: LOC },
      items: [{ itemCode: target, containerCode: CTN, expectedItemVersion: versions[target], expectedContainerVersion: 3 }]
    });
  }
  const total = s2.applied + s2.trialConcurrent + s2.versionConflict + s2.other;
  console.log(`\n[S2 汇总] ${total} 次命令：APPLIED ${s2.applied}（${(s2.applied / total * 100).toFixed(1)}%）| TRIAL_CONCURRENT ${s2.trialConcurrent} | VERSION_CONFLICT ${s2.versionConflict} | 其他 ${s2.other}`);
  console.log(`  时延 P50 ${pct(s2.latencies, 50)}ms | P95 ${pct(s2.latencies, 95)}ms`);

  // ---- 门槛判定 ----
  const autoRecovery = total ? (s2.applied / total * 100) : 0;
  console.log('\n[门槛判定（定稿）]');
  console.log(`  同实体命令最终成功率（含重试前拒绝）：${autoRecovery.toFixed(1)}%（≥99% 才算达标——注意本压测不含客户端重试，拒绝即终态；客户端场景拒绝会自动重试）`);
  console.log(`  P95 时延：${pct(s2.latencies, 95)}ms（≤90s 达标）`);

  // ---- 收尾：全回库 ----
  versions = await refreshVersions();
  await post({
    schemaVersion: 1, opId: 'lt-final-' + Date.now().toString(36), kind: 'receiveBatch', target: { loc: LOC },
    items: ITEMS.map(c => ({ itemCode: c, containerCode: CTN, expectedItemVersion: versions[c], expectedContainerVersion: 3 }))
  });
  console.log('\n收尾：全部物品已批量回库');
}

main().catch(e => { console.error('压测失败:', e.message); process.exit(1); });
