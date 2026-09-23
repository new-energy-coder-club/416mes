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

/* ================= S1（v3.3.0 拆锁）：claim 只做重放检测，不再有任何互斥阻塞 ================= */
function trialFixture() {
  const repository = repositoryFixture();
  repository.allOperations = async () => repository.logs;
  const coord = require('../lib/item-trial-coordinator').create(repository);
  return { repository, coord };
}
const freshTs = () => new Date(Date.now() - 30 * 1000).toISOString();          // 30s 前
const staleTs = () => new Date(Date.now() - 11 * 60 * 1000).toISOString();     // 11 分钟前

test('S1: claim 对任何未决行（新鲜/陈旧/REPAIR_REQUIRED）都不再阻塞——互斥整体移除', async () => {
  const { repository, coord } = trialFixture();
  repository.logs.push(
    { code: 'live-1', phase: 'PREPARED', kind: 'receive', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h', requestedAt: freshTs(), recordId: 'r1' },
    { code: 'rep-1', phase: 'REPAIR_REQUIRED', kind: 'receive', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h', requestedAt: staleTs(), recordId: 'r2' });
  const same = await coord.claim({ opId: 'new-1', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h2' });
  assert.equal(same.acquired, true, '同实体新鲜 PREPARED 行不再阻塞（正确性由版本前置+重计划兜底）');
  const other = await coord.claim({ opId: 'new-2', request: { kind: 'receive', itemCode: 'OTHER' }, requestHash: 'h3' });
  assert.equal(other.acquired, true, '不同实体可并行');
  const withRepair = await coord.claim({ opId: 'new-3', request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h4' });
  assert.equal(withRepair.acquired, true, 'REPAIR_REQUIRED 不再全局屏障（仅影响其自身 opId 的 lookup）');
});
test('S1: 同实体两条命令先后执行都成功（不再互杀），真实冲突由版本前置拦截', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  /* 第一条出库 APPLIED（物品 in_stock@v3 → out@v4）；第二条出库带着过期版本 3 →
     VERSION_CONFLICT 拒绝——「先确认者赢、后到者作废」由版本机制实现，而不是互斥互杀。 */
  const r1 = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'first', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } });
  assert.equal(r1.phase, 'APPLIED', r1.error);
  const r2 = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'second', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } });
  assert.equal(r2.phase, 'REJECTED');
  assert.match(r2.error, /VERSION_CONFLICT/);
  assert.equal(r2.newOpIdRequired, true);
  /* 后到者按最新数据重建（out → receive 回库）→ 成功：同实体先后命令畅通，只有版本谎言被拦 */
  const r3 = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'third', kind: 'receive', itemCode: 'I', target: { loc: 'L', container: 'C' }, expected: { itemVersion: 4, containerVersion: 2 } });
  assert.equal(r3.phase, 'APPLIED', r3.error);
});

/* ================= P2c（保留）：settle 人工收口通道 ================= */
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

/* ================= S3（v3.3.0）：过期僵尸自动三态收口 ================= */
test('S3: 过期 PREPARED 僵尸（已落盘但 finish 未落）→ 下一条命令顺带收口为 APPLIED', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  /* 正常执行一条出库到 APPLIED（item → out@v4），再把日志行打回 PREPARED + 时间戳拨回
     11 分钟前（模拟 apply 落了、finish 没落、进程被杀的半途） */
  const post = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'half-1', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } });
  assert.equal(post.phase, 'APPLIED');
  const row = repository.logs.find(l => l.code === 'half-1');
  row.phase = 'PREPARED'; row.requestedAt = staleTs();
  const r2 = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'next-1', kind: 'receive', itemCode: 'I', target: { loc: 'L', container: 'C' }, expected: { itemVersion: 4, containerVersion: 2 } });
  assert.equal(r2.phase, 'APPLIED', r2.error);
  assert.equal(repository.logs.find(l => l.code === 'half-1').phase, 'APPLIED', '僵尸行被自动收口为 APPLIED（实体实际已写入）');
});
test('S3: 过期 PREPARED 僵尸（未检出任何写入）→ 自动收口为 REJECTED', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  repository.logs.push({ code: 'zombie-1', phase: 'PREPARED', kind: 'receive',
    request: { kind: 'receive', itemCode: 'I', target: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } },
    requestHash: 'h', requestedAt: staleTs(), recordId: 'r1',
    before: { items: [{ code: 'I', status: 'in_stock', container: 'C', version: 3 }] },
    after: { items: [{ code: 'I', status: 'in_stock', container: 'C', version: 4 }] } });
  const r = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'next-1', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } });
  assert.equal(r.phase, 'APPLIED', r.error);
  const z = repository.logs.find(l => l.code === 'zombie-1');
  assert.equal(z.phase, 'REJECTED', '实体仍是 before 形态（没动过）→ 收口为作废');
  assert.match(z.error, /自动收口/);
});
test('S3: 过期僵尸检出部分写入 → REPAIR_REQUIRED（仅该命令，需人工）；新鲜行不受影响', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  repository.logs.push({ code: 'zombie-2', phase: 'PREPARED', kind: 'receive',
    request: { kind: 'receive', itemCode: 'I', target: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } },
    requestHash: 'h', requestedAt: staleTs(), recordId: 'r1',
    before: { items: [{ code: 'I', status: 'in_stock', container: 'C', version: 3 }] },
    after: { items: [{ code: 'I', status: 'in_stock', container: 'C', version: 4 }] } });
  repository.logs.push({ code: 'fresh-1', phase: 'PREPARED', kind: 'receive',
    request: { kind: 'receive', itemCode: 'I' }, requestHash: 'h', requestedAt: freshTs(), recordId: 'r2',
    before: { items: [{ code: 'I', status: 'in_stock', container: 'C', version: 3 }] },
    after: { items: [{ code: 'I', status: 'in_stock', container: 'C', version: 4 }] } });
  /* 部分写入：status=after（in_stock 不变看不出）——改 version 与 container 成既非 before 亦非 after */
  repository.state.items[0].version = 7;
  await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'next-1', kind: 'issue', itemCode: 'I', source: { loc: 'L', container: 'C' }, expected: { itemVersion: 3, containerVersion: 2 } });
  assert.equal(repository.logs.find(l => l.code === 'zombie-2').phase, 'REPAIR_REQUIRED', '部分写入 → 人工核对');
  assert.equal(repository.logs.find(l => l.code === 'fresh-1').phase, 'PREPARED', '新鲜行绝不被收口');
});

/* ================= S2（v3.3.0）：启用容器幂等化 ================= */
test('S2: 已启用容器同库位重确认——本地版本陈旧也 APPLIED（不再 VERSION_CONFLICT 死循环）', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  /* 云端容器已是 active@L（比如上一次启用实际已生效但本机 ACK 未落），
     本机镜像陈旧带旧版本 + 未核验冲突——重发启用命令必须幂等成功 */
  repository.state.containers[0].status = 'active';
  const r = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 're-act', kind: 'activateContainer', containerCode: 'C', target: { loc: 'L' }, expected: { containerVersion: 99 } });
  assert.equal(r.phase, 'APPLIED', r.error);
  const c = repository.state.containers[0];
  assert.equal(c.status, 'active');assert.equal(c.loc, 'L');
  assert.equal(c.lastOpId, 're-act', '重确认生成新凭据（同步合并要求）');
});
test('S2: 真实变更仍守版本与旧位——错版本拒 VERSION、旧位不确认拒 LEGACY、确认后成功', async () => {
  const { repository } = trialFixture();
  const service = require('../lib/item-operation').create({ repository, coordinator: require('../lib/item-trial-coordinator').create(repository), enabled: true, mode: 'feishu-trial' });
  repository.state.containers[0].loc = 'L2';   // 旧位与目标 L 不同
  const r1 = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'move-stale', kind: 'activateContainer', containerCode: 'C', target: { loc: 'L' }, expected: { containerVersion: 99 } });
  assert.equal(r1.phase, 'REJECTED');assert.match(r1.error, /VERSION_CONFLICT/, '真实变更版本前置保留（换位不是幂等重确认）');
  const r2 = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'move-noconfirm', kind: 'activateContainer', containerCode: 'C', target: { loc: 'L' }, expected: { containerVersion: 2 } });
  assert.equal(r2.phase, 'REJECTED');assert.match(r2.error, /LEGACY_LOCATION_CONFLICT/, '换位是真实变更：旧位确认不可跳过');
  const r3 = await service.post({ roles: ['admin'] }, { schemaVersion: 1, opId: 'move-ok', kind: 'activateContainer', containerCode: 'C', target: { loc: 'L' }, expected: { containerVersion: 2 }, confirmLegacyLocOverride: true });
  assert.equal(r3.phase, 'APPLIED', r3.error);
});
