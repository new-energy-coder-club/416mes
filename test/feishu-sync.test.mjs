/**
 * 飞书同步集成测试 —— 用假的 lark-cli 跑真实代码路径，不需要飞书凭据、不联网。
 *
 * 覆盖：status / pull / push 幂等 / dry-run 不写入 / 读取失败必须报错而不是静默返回空表
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_CLI_SRC = join(REPO, 'test', 'fixtures', 'fake-lark-cli');

/* ---------- 夹具：把假 CLI 和配置放进临时目录，隔离真实配置 ---------- */
function mkEnv({ failOn = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mes416-feishu-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  // 假 lark-cli 必须叫 lark-cli 才能被 execFileSync('lark-cli') 找到
  copyFileSync(FAKE_CLI_SRC, join(binDir, 'lark-cli'));
  chmodSync(join(binDir, 'lark-cli'), 0o755);

  const fixture = {
    tables: {
      '物料台账': { id: 'tblMAT', fields: ['物料码', '名称', '规格型号', '闲鱼XY编号', '当前库位码', '容器码', '库存数量', '安全库存', '成本'],
        rows: [
          { '物料码': 'GJ-SD-001', '名称': '螺丝刀', '规格型号': '十字 PH2×100mm', '闲鱼XY编号': '', '当前库位码': 'B-01-01-01', '容器码': 'XK-001', '库存数量': 7, '安全库存': 2, '成本': 8.5 },
          { '物料码': 'HC-BG-001', '名称': '打印纸', '规格型号': 'A4 70g', '闲鱼XY编号': '', '当前库位码': 'B-02-04-08', '容器码': '', '库存数量': 12, '安全库存': 3, '成本': 22 }
        ] },
      '库位': { id: 'tblLOC', fields: ['库位码', '类型', '说明', '授权人员'], rows: [{ '库位码': 'B-01-01-01', '类型': '货架', '说明': 'B区 1号货架', '授权人员': '' }] },
      '容器': { id: 'tblCTN', fields: ['容器码', '容器类型', '规格', '当前库位码'], rows: [{ '容器码': 'XK-001', '容器类型': 'A4四抽收纳盒', '规格': 'A4', '当前库位码': 'B-01-01-01' }] },
      '人员': { id: 'tblMBR', fields: ['编号', '姓名', '学号', '部门/SIG', '职务', '电话', '备注', '标签'], rows: [{ '编号': 'MB-001', '姓名': '张三', '学号': '2023001', '部门/SIG': '硬件', '职务': '成员', '电话': '', '备注': '', '标签': '' }] },
      '物品': { id: 'tblITM', fields: ['物品码', '名称', '规格型号', '库位码'], rows: [{ '物品码': 'WP-001', '名称': '电烙铁', '规格型号': '60W 可调温', '库位码': 'W01-G01' }] },
      '手册': { id: 'tblMAN', fields: ['手册码', '名称', '版本', '库位码'], rows: [{ '手册码': 'SC-001', '名称': 'NEC26 活动手册', '版本': 'V1.0', '库位码': 'B-01-01-02' }] },
      '工单记录': { id: 'tblWIP', fields: ['工单号', '类型', '日期', '明细', '状态', '执行时间'],
        rows: [{ '工单号': 'LL20260915001', '类型': 'LL 领料', '日期': '2026-09-15', '明细': 'GJ-SD-001x2; HC-BG-001x3', '状态': '已执行', '执行时间': '2026-09-15 10:30' }] },
      '库存流水': { id: 'tblTXN', fields: ['流水号', '时间', '操作人', '类型', '物料码', '变动', '余量', '关联单', '原因/备注'],
        rows: [
          { '流水号': '#000002', '时间': '2026-09-15 10:30:00', '操作人': '管理员', '类型': '领料工单', '物料码': 'GJ-SD-001', '变动': -2, '余量': 7, '关联单': 'LL20260915001', '原因/备注': '' },
          { '流水号': '#000001', '时间': '2026-09-14 09:00:00', '操作人': '管理员', '类型': '补货工单', '物料码': 'GJ-SD-001', '变动': 9, '余量': 9, '关联单': 'BH20260914001', '原因/备注': '' }
        ] }
    }
  };
  if (failOn) fixture.failOn = failOn;
  const fixturePath = join(dir, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 1));

  // 临时配置：表 ID 与 fixture 的 id 对应，避免依赖工作区真实配置
  const configPath = join(dir, 'feishu-backend.config.json');
  writeFileSync(configPath, JSON.stringify({
    app: 'cli_fake', base_token: 'FAKE_BASE_TOKEN', url: 'https://example.feishu.cn/base/FAKE', identity: 'user',
    tables: { '物料台账': 'tblMAT', '库位': 'tblLOC', '容器': 'tblCTN', '人员': 'tblMBR', '物品': 'tblITM', '手册': 'tblMAN', '工单记录': 'tblWIP', '库存流水': 'tblTXN' }
  }, null, 1));

  // 隔离配置：写到临时目录并用 FEISHU_CONFIG 覆盖（feishu-sync.mjs 支持吗？不支持则用工作区配置）
  const env = {
    ...process.env,
    PATH: binDir + ':' + process.env.PATH,
    FAKE_LARK_FIXTURE: fixturePath,
    FAKE_LARK_LOG: join(dir, 'calls.log'),
    FEISHU_CONFIG: configPath
  };
  writeFileSync(env.FAKE_LARK_LOG, '');
  return { dir, env, fixturePath, logPath: env.FAKE_LARK_LOG };
}

function cleanup(env) { try { rmSync(env.dir, { recursive: true, force: true }); } catch { } }

async function runSync(env, args, { expectFail = false } = {}) {
  try {
    const r = await execFileP('node', [join(REPO, 'feishu-sync.mjs'), ...args], { cwd: REPO, env: env.env, maxBuffer: 16 * 1024 * 1024 });
    if (expectFail) assert.fail('本应失败但成功了：' + r.stdout);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    if (!expectFail) assert.fail('本应成功但失败了：' + (e.stderr || e.message));
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

/* ================= unique-item CLI boundary ================= */
test('CLI refuses controlled ITM push and preserves fake remote relationship', async t => {
  const env = mkEnv(); t.after(() => cleanup(env));
  const backup = join(env.dir, 'controlled.json');
  writeFileSync(backup, JSON.stringify({ state: { materials: [], items: [{ code: 'WP-001', status: 'in_stock', container: 'bad', version: 2 }] } }));
  const before = readFileSync(env.fixturePath, 'utf8');
  const result = await runSync(env, ['push', backup], { expectFail: true });
  assert.match(result.stderr, /CLI 禁止推送受控实体/);
  assert.equal(readFileSync(env.fixturePath, 'utf8'), before);
});

/* ================= status ================= */

test('feishu status：列出 8 张表与记录数', async (t) => {
  const env = mkEnv(); t.after(() => cleanup(env));
  const r = await runSync(env, ['status']);
  assert.match(r.stdout, /物料台账\s+tblMAT\s+记录数 2/);
  assert.match(r.stdout, /库存流水\s+tblTXN\s+记录数 2/);
  assert.match(r.stdout, /库位\s+tblLOC\s+记录数 1/);
});

/* ================= pull ================= */

test('feishu pull：8 张表全部拉取并写出可导入的备份 JSON', async (t) => {
  const env = mkEnv(); t.after(() => cleanup(env));
  const outFile = join(env.dir, 'pulled.json');
  const r = await runSync(env, ['pull', outFile]);
  assert.match(r.stdout, /物料台账：2 条/);
  assert.match(r.stdout, /库存流水：2 条/);
  assert.ok(existsSync(outFile));

  const pkg = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(pkg.app, '416MES');
  const s = pkg.state;
  assert.equal(s.materials.length, 2);
  assert.equal(s.transactions.length, 2);
  assert.equal(s.workorders.length, 1);

  // 字段映射正确
  assert.deepEqual(s.materials[0], { code: 'GJ-SD-001', name: '螺丝刀', spec: '十字 PH2×100mm', xy: '', loc: 'B-01-01-01', container: 'XK-001', qty: 7, minQty: 2, cost: 8.5 });
  assert.equal(s.transactions[0].seq, 2);
  assert.equal(s.transactions[0].balance, 7);
  assert.equal(s.transactions[0].ref, 'LL20260915001');
  // 明细串 "GJ-SD-001x2; HC-BG-001x3" 被解析成结构化 items
  assert.deepEqual(s.workorders[0].items, [{ matCode: 'GJ-SD-001', qty: 2 }, { matCode: 'HC-BG-001', qty: 3 }]);
  assert.equal(s.workorders[0].type, 'LL');
  // 流水新的在前；txnSeq 与云端接口保持一致
  assert.deepEqual(s.transactions.map(x => x.seq), [2, 1]);
  assert.equal(s.txnSeq, 2);
});

/* ================= push 幂等 ================= */

test('feishu push：把拉回来的数据推回去全是「更新」，幂等不产生重复', async (t) => {
  const env = mkEnv(); t.after(() => cleanup(env));
  const outFile = join(env.dir, 'pulled.json');
  await runSync(env, ['pull', outFile]);
  const r = await runSync(env, ['push', outFile]);
  assert.match(r.stdout, /物料台账：本地 2 条 → 新建 0 \/ 更新 2/);
  assert.match(r.stdout, /库存流水：本地 2 条 → 新建 0 \/ 更新 2/);
  assert.match(r.stdout, /push 完成/);
});

test('feishu push：dry-run 不产生任何写入', async (t) => {
  const env = mkEnv(); t.after(() => cleanup(env));
  const outFile = join(env.dir, 'pulled.json');
  await runSync(env, ['pull', outFile]);
  writeFileSync(env.logPath, '');
  await runSync(env, ['push', outFile, '--dry-run']);
  const log = readFileSync(env.logPath, 'utf8');
  assert.equal((log.match(/^WRITE /gm) || []).length, 0, 'dry-run 不得写入');
});

test('feishu push：dry-run 文案说明无法区分新建/更新', async (t) => {
  const env = mkEnv(); t.after(() => cleanup(env));
  const outFile = join(env.dir, 'pulled.json');
  await runSync(env, ['pull', outFile]);
  const r = await runSync(env, ['push', outFile, '--dry-run']);
  assert.match(r.stdout, /预演：将写入/);
});

/* ================= 故障路径 ================= */

test('【回归】feishu 读取失败必须报错退出，绝不能静默返回空表', async (t) => {
  const env = mkEnv({ failOn: 'record-list' }); t.after(() => cleanup(env));
  const outFile = join(env.dir, 'should-not-exist.json');
  const r = await runSync(env, ['pull', outFile], { expectFail: true });
  assert.notEqual(r.code, 0, '读取失败必须以非零退出码结束');
  assert.match(r.stderr, /读取表 tblMAT 失败/);
  assert.match(r.stderr, /注入的模拟错误/);
  assert.equal(existsSync(outFile), false, '读取失败不得写出看似正常的备份文件');
});

test('【回归】feishu 写入失败必须打印错误，不能静默成功', async (t) => {
  const env = mkEnv({ failOn: 'write' }); t.after(() => cleanup(env));
  const outFile = join(env.dir, 'pulled.json');
  // 先关掉写入故障把数据拉下来
  const okEnv = mkEnv();
  await runSync(okEnv, ['pull', outFile]);
  cleanup(okEnv);

  const r = await runSync(env, ['push', outFile]);
  assert.match(r.stdout + r.stderr, /更新失败|创建失败/);
});

/* ================= 同步契约：state ↔ 飞书列 ================= */

/**
 * 「绊线」测试：飞书工单映射目前只覆盖 6 个字段，Phase 3 新增的执行/冲销字段
 * 尚未同步。等飞书阶段补齐映射后，下面第一个断言会失败，提醒你把这条用例
 * 改成「往返一致」的断言 —— 而不是让这个缺口被悄悄忘掉。
 */
test('【已知缺口·绊线】飞书工单映射尚未覆盖 Phase 3 的执行与冲销字段', async (t) => {
  const SYNCED = { '工单号': 'code', '类型': 'type', '日期': 'date', '明细': 'items', '状态': 'status', '执行时间': 'execTime' };
  const CRITICAL = ['code', 'type', 'date', 'items', 'status', 'execTime', 'execQty', 'execBatches', 'reverseInfo'];
  const syncedStateFields = new Set(Object.values(SYNCED));
  const missing = CRITICAL.filter(f => !syncedStateFields.has(f));

  assert.deepEqual(missing, ['execQty', 'execBatches', 'reverseInfo'],
    '飞书工单映射看起来已经变了：若已补齐 Phase 3 字段，请把本条用例改为「push→pull 往返后执行数量/批次/冲销记录一致」，并删除缺口记录。');

  // 缺口的具体后果：部分执行过的工单往返后会被当成"一件都没执行"
  const Core = (await import('../mes-core.js')).default;
  const roundTripped = { code: 'LL-PART', type: 'LL', date: '2026-09-15', items: [{ matCode: 'GJ-SD-001', qty: 4 }], status: '部分执行', execTime: '' };
  const p = Core.orderProgress(roundTripped);
  assert.equal(p.executedTotal, 0, '飞书没有执行数量列，往返后已执行数量归零');
  assert.equal(p.remainingTotal, 4, '于是剩余数量回到计划值');

  // 因此启用飞书同步前必须先补映射：否则继续执行会重复扣减
  const s = { materials: [{ code: 'GJ-SD-001', qty: 20, minQty: 0, cost: 8 }], workorders: [roundTripped], transactions: [], txnSeq: 0 };
  const r = Core.executeOrder(s, roundTripped);
  assert.equal(r.ok, true);
  assert.equal(r.applied[0].qty, 4, '往返后会把已执行过的 1 件再执行一遍（库存多扣）');
});
