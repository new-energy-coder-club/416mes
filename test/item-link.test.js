'use strict';
/* 短码算法一经印刷冻结——本测试锁死字符集/位序/期望值，任何改动都必须有意为之。 */
const test = require('node:test'), assert = require('node:assert/strict');
const L = require('../lib/item-link');

test('期望值锁定（算法冻结点）', () => {
  assert.equal(L.fromItemCode('WP-001'), 'KW4QYSBD');
  assert.equal(L.fromItemCode('WP-TS-001'), '5W4QY7BQ');
  assert.equal(L.fromItemCode('WP-JG-7'), 'MHVJWBGX');
  assert.equal(L.linkFor('WP-001'), 'https://mes.newenergycoder.club/i/KW4QYSBD');
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
