'use strict';
/* 短码算法一经印刷冻结——本测试锁死字符集/位序/期望值，任何改动都必须有意为之。 */
const test = require('node:test'), assert = require('node:assert/strict');
const L = require('../lib/item-link');

test('期望值锁定（算法冻结点）', () => {
  assert.equal(L.fromItemCode('WP-001'), 'KW4QYSBD');
  assert.equal(L.fromItemCode('WP-TS-001'), '5W4QY7BQ');
  assert.equal(L.fromItemCode('WP-JG-7'), 'MHVJWBGX');
  assert.equal(L.linkFor('WP-001'), 'HTTPS://MES.NEWENERGYCODER.CLUB/I/KW4QYSBD', '冻结印刷版整条大写（定稿 §二/§6.3）');
});

test('编码往返：存量未分类 + 八分类边界 + 序号上限（解码归一到 3 位序号）', () => {
  for (const code of ['WP-001', 'WP-2097151', 'WP-JG-001', 'WP-DJ-001', 'WP-DZ-001', 'WP-GZ-001', 'WP-TS-001', 'WP-GJ-001', 'WP-HC-001', 'WP-QT-001', 'WP-QT-2097151']) {
    const s = L.fromItemCode(code);
    assert.ok(s, code + ' 可编码');
    assert.equal(L.toItemCode(L.decode(s)), code, code + ' 往返');
  }
  // 非规范写法归一化到三位序号（WP-1 ≡ WP-001）
  assert.equal(L.toItemCode(L.decode(L.fromItemCode('WP-1'))), 'WP-001');
});

test('大样本零碰撞（前 3000 序号 × 全部分类）', () => {
  const seen = new Set();
  for (let cat = 0; cat <= 8; cat++) for (let serial = 1; serial <= 3000; serial++) {
    const s = L.encode(cat, serial);
    assert.ok(!seen.has(s), '碰撞 ' + s);
    seen.add(s);
  }
});

test('篡改/非法字符/大小写处理', () => {
  const s = L.fromItemCode('WP-001');
  assert.equal(L.decode(s.slice(0, 7) + (s[7] === 'D' ? 'E' : 'D')), null, '篡改一位必须校验失败');
  assert.equal(L.decode('!!!!!!!!'), null);
  assert.equal(L.decode('KW4QYSB'), null, '不足 8 位拒绝');
  assert.deepEqual(L.decode('kw4qysbd'), L.decode('KW4QYSBD'), '大小写不敏感');
  assert.equal(L.fromItemCode('WP-abc'), null, '随机历史码不走结构化短码');
});

test('parseScanText：URL / 裸码 / 任意主机 / 非本系统不误判', () => {
  const short = L.fromItemCode('WP-TS-002');
  assert.equal(L.parseScanText('https://mes.newenergycoder.club/i/' + short).code, 'WP-TS-002');
  assert.equal(L.parseScanText('http://192.168.1.5:8000/i/' + short).code, 'WP-TS-002');
  assert.equal(L.parseScanText(short).code, 'WP-TS-002');
  assert.equal(L.parseScanText('https://example.com/i/' + short).code, 'WP-TS-002', '任意主机本地可解');
  assert.equal(L.parseScanText('https://example.com/other/' + short), null);
  assert.equal(L.parseScanText('ITM:WP-001'), null, '前缀串不走短链分支');
  assert.equal(L.parseScanText(''), null);
});

/* ================= A 阶段：服务端发号 nextItemCode ================= */

test('nextItemCode：各分类独立序列，污染快照取号正确', () => {
  const rows = [
    { code: 'WP-001' }, { code: 'WP-002' }, { code: 'WP-003' },        // cat=0 未分类存量
    { code: 'WP-' + 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },          // WP-uuid 污染
    { code: 'WP-DEMO-001' },                                            // 3 字母假分类污染
    { code: 'wp-ts-009' },                                              // 小写存码归一计入 TS 序列（防撞号）
    { code: 'WP-TS-003' }, { code: 'WP-JG-002' },
    { code: '' }, { code: null }, {}, 'WP-QT-004'
  ];
  assert.equal(L.nextItemCode(rows, 'TS'), 'WP-TS-010', 'TS 序列取 max(9,3)+1，小写也计入');
  assert.equal(L.nextItemCode(rows, 'JG'), 'WP-JG-003');
  assert.equal(L.nextItemCode(rows, 'QT'), 'WP-QT-005');
  assert.equal(L.nextItemCode(rows, 'DJ'), 'WP-DJ-001', '空序列从 001 起');
  assert.equal(L.nextItemCode([], 'HC'), 'WP-HC-001');
});

test('nextItemCode：分类非法返回 null；序号耗尽抛 SERIAL_EXHAUSTED', () => {
  assert.equal(L.nextItemCode([], 'XX'), null);
  assert.equal(L.nextItemCode([], ''), null);
  assert.equal(L.nextItemCode([], undefined), null);
  assert.equal(L.nextItemCode([], 0), null, '未分类序列不对新建开放');
  assert.throws(() => L.nextItemCode([{ code: 'WP-TS-2097151' }], 'TS'), e => e.code === 'SERIAL_EXHAUSTED');
  assert.equal(L.nextItemCode([{ code: 'WP-TS-2097150' }], 'TS'), 'WP-TS-2097151', '上限边界可用');
});

test('CATS 顺序与 index.html MAT_CATS 强耦合锁死（P8：扩类必须同步两处）', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/const MAT_CATS = \{([^}]+)\}/);
  assert.ok(m, 'index.html 必须存在 MAT_CATS 定义');
  const keys = [...m[1].matchAll(/([A-Z]{2})\s*:/g)].map(x => x[1]);
  assert.deepEqual(keys, ['JG', 'DJ', 'DZ', 'GZ', 'TS', 'GJ', 'HC', 'QT']);
  keys.forEach((k, i) => {
    assert.equal(L.catIndex(k), i + 1);
    assert.equal(L.catLetters(i + 1), k);
  });
});

test('扩类守卫：cat 9~15 现状 decode 拒绝（扩类前不可印码）', () => {
  for (const cat of [9, 15]) assert.equal(L.decode(L.encode(cat, 5)), null, 'cat=' + cat + ' 必须拒绝');
});

test('parseScanText：印刷版全大写 URL / 带 query / 锚点（D2：整条大写已纳入冻结清单，扫码必须能解）', () => {
  const short = L.fromItemCode('WP-001');
  const printed = L.linkFor('WP-001').toUpperCase();
  assert.equal(printed, 'HTTPS://MES.NEWENERGYCODER.CLUB/I/' + short, '印刷形态=整条大写');
  assert.equal(L.parseScanText(printed).code, 'WP-001', '全大写 URL 必须能解（QR 数字字母模式只容大写）');
  assert.equal(L.parseScanText(L.linkFor('WP-001') + '?to=feishu').code, 'WP-001', '带 query 也可解');
  assert.equal(L.parseScanText(L.linkFor('WP-001') + '#frag').code, 'WP-001', '带锚点也可解');
  assert.equal(L.parseScanText(short.toLowerCase()).code, 'WP-001', '小写裸码归一');
  assert.equal(L.parseScanText('HTTPS://X.COM/I/' + short + '?to=feishu').code, 'WP-001', '任意主机+大写+query');
});
