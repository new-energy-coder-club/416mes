'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRuntime}=require('../lib/item-runtime');
const {repositoryFixture}=require('./fixtures/item-protocol');

test('feishu trial mode runs without auth/coordinator injection and remains explicitly best-effort',async()=>{
 const repository=repositoryFixture();repository.allOperations=async()=>repository.logs;
 const service=require('../lib/item-operation').create({repository,coordinator:require('../lib/item-trial-coordinator').create(repository),enabled:true,mode:'feishu-trial'});
 assert.equal(service.mode,'feishu-trial');
 const result=await service.post({}, {schemaVersion:1,opId:'trial-issue',kind:'issue',itemCode:'I',source:{loc:'L',container:'C'},expected:{itemVersion:3,containerVersion:2},reason:'trial'});
 assert.equal(result.phase,'APPLIED',result.error);assert.equal(repository.state.items[0].status,'out');assert.equal(repository.writes,1);
});

test('trial mode duplicate same opId returns existing result and different payload conflicts',async()=>{
 const repository=repositoryFixture();repository.allOperations=async()=>repository.logs;const coord=require('../lib/item-trial-coordinator').create(repository);
 const service=require('../lib/item-operation').create({repository,coordinator:coord,enabled:true,mode:'feishu-trial'});
 const request={schemaVersion:1,opId:'same',kind:'issue',itemCode:'I',source:{loc:'L',container:'C'},expected:{itemVersion:3,containerVersion:2}};
 assert.equal((await service.post({},request)).phase,'APPLIED');assert.equal((await service.post({},request)).phase,'APPLIED');
 await assert.rejects(()=>service.post({}, {...request,reason:'different'}),/OP_ID_PAYLOAD_CONFLICT/);assert.equal(repository.writes,1);
});

/* ================= P2b/P2c（用户实测「单设备也报并发、命令提交不了」） ================= */
function trialFixture() {
  const repository = repositoryFixture();
  repository.allOperations = async () => repository.logs;
  const coord = require('../lib/item-trial-coordinator').create(repository);
  return { repository, coord };
}
const freshTs = () => new Date(Date.now() - 30 * 1000).toISOString();          // 30s 前
const staleTs = () => new Date(Date.now() - 11 * 60 * 1000).toISOString();     // 11 分钟前

test('P2b: stale PREPARED row (11min old, impossible in-flight) no longer blocks new commands', async () => {
  const { repository, coord } = trialFixture();
  repository.logs.push({ code: 'zombie-1', phase: 'PREPARED', kind: 'receive', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h', requestedAt: staleTs(), recordId: 'r1' });
  const claim = await coord.claim({ opId: 'new-1', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h2' });
  assert.equal(claim.acquired, true, '陈旧 PREPARED 必须放行（否则单设备被僵尸行永久堵死）');
});
test('P2b: fresh PREPARED same-entity still blocks; disjoint entity does not (2.63.0 bucketing intact)', async () => {
  const { repository, coord } = trialFixture();
  repository.logs.push({ code: 'live-1', phase: 'PREPARED', kind: 'receive', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h', requestedAt: freshTs(), recordId: 'r1' });
  const blocked = await coord.claim({ opId: 'new-1', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h2' });
  assert.equal(blocked.acquired, false, '新鲜同实体仍互斥');
  const pass = await coord.claim({ opId: 'new-2', request: { kind: 'receive', itemCode: 'OTHER' }, requestHash: 'h3' });
  assert.equal(pass.acquired, true, '不同实体可并行（用户模型）');
});
test('P2b: REPAIR_REQUIRED remains global barrier regardless of age (consistency in doubt)', async () => {
  const { repository, coord } = trialFixture();
  repository.logs.push({ code: 'rep-1', phase: 'REPAIR_REQUIRED', kind: 'receive', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h', requestedAt: staleTs(), recordId: 'r1' });
  const claim = await coord.claim({ opId: 'new-1', request: { kind: 'receive', itemCode: 'OTHER' }, requestHash: 'h2' });
  assert.equal(claim.acquired, false, 'REPAIR_REQUIRED 仍全局屏障');
});
test('P2c: coordinator.get exposes operation for REPAIR_REQUIRED rows so settle can reach them', async () => {
  const { repository, coord } = trialFixture();
  repository.logs.push({ code: 'rep-1', phase: 'REPAIR_REQUIRED', kind: 'receive', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h', requestedAt: freshTs(), recordId: 'r1' });
  const accepted = await coord.get('rep-1');
  assert.ok(accepted.operation, 'REPAIR_REQUIRED 行必须暴露 operation（否则人工收口永久死锁）');
  assert.equal(accepted.operation.phase, 'REPAIR_REQUIRED');
});
test('P2c: service.settle(finalizes) REPAIR_REQUIRED row — readAfter match → APPLIED', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  /* 先正常执行一条命令到 APPLIED（实体已写），再人为把日志行打回 REPAIR_REQUIRED 模拟 2.52.1 路径的半途 */
  const post = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'settle-me', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 }, reason: 'x' });
  assert.equal(post.phase, 'APPLIED');
  const row = repository.logs.find(l => l.code === 'settle-me');
  row.phase = 'REPAIR_REQUIRED';   // 模拟写后 finish 失败遗留
  const settled = await service.settle({ roles: ['admin'] }, 'settle-me');
  assert.equal(settled.phase, 'APPLIED', '实体实际状态与 after 一致 → 收口为 APPLIED');
  assert.equal(repository.logs.find(l => l.code === 'settle-me').phase, 'APPLIED');
});
test('P2c: settle marks REJECTED when actual entity state drifted (readAfter mismatch)', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  const post = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'drift-1', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 }, reason: 'x' });
  assert.equal(post.phase, 'APPLIED');
  repository.logs.find(l => l.code === 'drift-1').phase = 'REPAIR_REQUIRED';
  repository.state.items[0].status = 'pending';   // 云端后来被别的操作覆盖
  const settled = await service.settle({ roles: ['admin'] }, 'drift-1');
  assert.equal(settled.phase, 'REJECTED', '状态漂移 → 收口为未生效，绝不虚报成功');
});

/* ================= P2a（并发模型定稿：先确认者赢、后到者立即作废，无 20s 等待） ================= */
test('P2a: loser is rejected immediately (no 20s wait) with rescan-or-rebuild policy', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  /* TOCTOU 模拟：claim 阶段看不到冲突（放行），写前裁决看到 winner 行（更早的 requestedAt+更小 opId） */
  const winnerRow = { code: 'AAA-winner', phase: 'PREPARED', kind: 'receive', request: { kind: 'issue', itemCode: 'I' }, requestHash: 'h', requestedAt: freshTs(), recordId: 'r1' };
  let calls = 0;
  repository.unsettledOperations = async () => { calls++; return calls === 1 ? [] : [winnerRow]; };
  const startedAt = Date.now();
  const result = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'zzz-loser', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.phase, 'REJECTED');
  assert.equal(result.error, 'TRIAL_CONCURRENT_OPERATION_DETECTED');
  assert.ok(elapsed < 2000, 'loser 必须立即返回（旧实现等待最长 20s），实测 ' + elapsed + 'ms');
  assert.equal(result.retryable, false, '不再承诺自动重试（先确认者赢，后到者作废）');
  assert.equal(result.newOpIdRequired, true);
  assert.equal(result.policy.strategy, 'rescan-or-rebuild');
  assert.equal(result.policy.maxAuto, 0);
});
test('P2a: winner (smaller requestedAt|opId) proceeds without waiting', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  const futureRow = { code: 'ZZZ-loser', phase: 'PREPARED', kind: 'receive', request: { kind: 'issue', itemCode: 'I' }, requestHash: 'h', requestedAt: '2999-01-01T00:00:00.000Z', recordId: 'r2' };
  let calls = 0;
  repository.unsettledOperations = async () => { calls++; return calls === 1 ? [] : [futureRow]; };
  const result = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'aaa-winner', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } });
  assert.equal(result.phase, 'APPLIED', result.error);
});
test('P2a: barrier rejection keeps retryable with settle-then-resubmit (same opId can resubmit)', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  /* claim 阶段就被 REPAIR_REQUIRED 行挡住 → UNRESOLVED_OPERATION_BARRIER（HTTP 层 409 throw） */
  repository.logs.push({ code: 'rep-1', phase: 'REPAIR_REQUIRED', kind: 'receive', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h', requestedAt: freshTs(), recordId: 'r1' });
  await assert.rejects(() => service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'new-1', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } }), /UNRESOLVED_OPERATION_BARRIER/);
  /* 收口后同一 opId 可直接重提（屏障拒绝不留日志、编号未烧掉） */
  repository.logs.length = 0;
  const result = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'new-1', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } });
  assert.equal(result.phase, 'APPLIED', result.error);
});
