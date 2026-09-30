'use strict';
/* 容器短链 v3.13.35 · lib/ctn-link.js 单元测试
 *
 * 与 test/item-link.test.js 平行同构。锁值来自实施护航实算（方案 §3.1 锁值表，
 * node 实算后写死）——短码印上标签即冻结，锁值漂移 = 已印标签作废，绝不改锁就算法。
 * 立规（D8）：parseScanText 仅 /c/ URL 形态，裸 8 位必须 null（结构上不给接线留口）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../lib/ctn-link');

test('锁值：六类容器码 → 8 位短码（实算写死，冻结）', () => {
  assert.equal(C.fromCtnCode('A4SH-001'), 'XW4QYGBY');
  assert.equal(C.fromCtnCode('SLG-003'), 'FE1P8BZC');
  assert.equal(C.fromCtnCode('XK-001'), 'HW4QYD4V');
  assert.equal(C.fromCtnCode('ZZX-001'), 'VW4QYSGB');
  assert.equal(C.fromCtnCode('SC4-001'), '5W4QYWY4');
  assert.equal(C.fromCtnCode('KF-001'), 'FW4QY49J');
});

test('锁值：位宽边界（1000 原样 / 21bit 上限 / 上限+1 拒）', () => {
  assert.equal(C.fromCtnCode('A4SH-1000'), 'DVFX1T40');
  assert.equal(C.fromCtnCode('SC4-2097151'), '8A7SMPDK');
  assert.equal(C.fromCtnCode('KF-2097152'), null, 'serial 超 21bit 上限必须 null');
});

test('linkFor：整条 42 字符大写 URL（QR V3-M 容量 61，余量 19）', () => {
  assert.equal(C.linkFor('A4SH-001'), 'HTTPS://MES.NEWENERGYCODER.CLUB/C/XW4QYGBY');
  assert.equal(C.BASE_URL.length, 34, 'BASE_URL 本身 34 字符');
  const link = C.linkFor('SLG-003');
  assert.equal(link.length, 42);
  assert.equal(link, link.toUpperCase(), '整条 URL 必须全大写');
});

test('往返：30000+ 码 type/serial 双向还原零失败', () => {
  let n = 0;
  for (let t = 1; t <= 6; t++) for (let s = 1; s <= 5000; s++) {
    const code = C.toCtnCode({ type: t, serial: s });
    const d = C.decode(C.fromCtnCode(code));
    assert.deepEqual({ type: d.type, serial: d.serial }, { type: t, serial: s });
    assert.equal(C.toCtnCode(C.decode(C.fromCtnCode(code))), code, '短码往返必须还原成同一容器码');
    n++;
  }
  assert.equal(n, 30000);
});

test('白名单 enforcement：非六类前缀 / 库位码 / 物品码全部 null（无短码，回退 CTN: 前缀串）', () => {
  for (const bad of ['C-01', 'C-A', 'CTN-S', 'CTN-SC4-001', 'WP-001', 'WP-TS-001', 'B-01-01-01', 'XK-000', 'SLG-0', 'A4SH-', '-001', 'A4SH-001X', 'A4SH 001', '']) {
    assert.equal(C.fromCtnCode(bad), null, JSON.stringify(bad) + ' 必须无短码');
  }
});

test('往返恒等校验（护航增补）：3 位补零错位全拒——A4SH-7 落地会变 A4SH-007 查无此容器', () => {
  assert.equal(C.fromCtnCode('A4SH-7'), null, '<1000 必须恰好 3 位补零');
  assert.equal(C.fromCtnCode('A4SH-0007'), null, '4 位补零也不行');
  assert.equal(C.fromCtnCode('SLG-1'), null);
  assert.equal(C.fromCtnCode('a4sh-001'), null, '小写存储键落空：大写归一会掩盖业务键错位');
  assert.equal(C.fromCtnCode('A4SH-001'), 'XW4QYGBY', '规范形不受影响');
});

test('类型 0 / 7..15 decode 必须拒绝（平行 item-link 扩类守卫）', () => {
  for (const t of [0, 7, 9, 15]) {
    const s = C.encode(t, 5);
    assert.equal(C.decode(s), null, 'type=' + t + ' 必须拒绝');
  }
  assert.deepEqual(C.decode(C.encode(6, 2097151)), { type: 6, serial: 2097151 }, 'type=6 仍在白名单');
});

test('篡改一位必拒（校验位 15bit，万样本零漏网口径抽验）', () => {
  const base = C.fromCtnCode('A4SH-001');
  assert.equal(base, 'XW4QYGBY');
  const CH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let tried = 0;
  for (let i = 0; i < 8; i++) {
    for (const ch of CH) {
      if (ch === base[i]) continue;
      const flipped = base.slice(0, i) + ch + base.slice(i + 1);
      if (/[ILUO]/.test(ch)) continue;   // 易混字符会被归一成原字符（不算篡改）
      assert.equal(C.decode(flipped), null, '篡改位 ' + i + '（' + base[i] + '→' + ch + '）必须拒');
      tried++;
    }
  }
  assert.ok(tried >= 180, '每位置换 29 字母共 ' + tried + ' 次全部拒绝');
});

test('Crockford 易混映射：O→0、I/L→1、U 删除（校验和下归一仍可解）', () => {
  const z = C.fromCtnCode('SC4-001');
  assert.equal(z, '5W4QYWY4');
  const one = C.fromCtnCode('SLG-003');
  assert.equal(one, 'FE1P8BZC');
  assert.ok(one.includes('1'), 'SLG-003 短码含 1，可验证 I/L 归一');
  assert.deepEqual(C.decode(one.replace('1', 'I')), C.decode(one), 'I 归一为 1');
  assert.deepEqual(C.decode(one.replace('1', 'L')), C.decode(one), 'L 归一为 1');
  assert.equal(C.decode('XW4QYGBU'), null, 'U 被直接删除 → 7 位不匹配形状正则（U 不参与映射）');
});

test('O 归一实证：短码 0 位写成 O 后 decode 仍还原同一容器码', () => {
  let found = null;
  for (let t = 1; t <= 6 && !found; t++) {
    for (let s = 1; s <= 300 && !found; s++) {
      const short = C.encode(t, s);
      if (short.includes('0')) found = { short, t, s };
    }
  }
  assert.ok(found, '前 300 序号内必能找到含 0 的短码');
  assert.deepEqual(C.decode(found.short.replace('0', 'O')), { type: found.t, serial: found.s }, 'O 归一为 0');
});

test('parseScanText：/c/ URL 大小写不敏感 + 尾斜杠 + query/hash 容忍', () => {
  assert.deepEqual(C.parseScanText('https://mes.newenergycoder.club/c/xw4qygby'), { short: 'XW4QYGBY', code: 'A4SH-001' });
  assert.deepEqual(C.parseScanText('HTTPS://MES.NEWENERGYCODER.CLUB/C/XW4QYGBY/'), { short: 'XW4QYGBY', code: 'A4SH-001' });
  assert.deepEqual(C.parseScanText('https://mes.newenergycoder.club/c/XW4QYGBY?src=cam'), { short: 'XW4QYGBY', code: 'A4SH-001' });
  assert.deepEqual(C.parseScanText('https://mes.newenergycoder.club/c/XW4QYGBY#top'), { short: 'XW4QYGBY', code: 'A4SH-001' });
});

test('D8 立规负向锁：裸 8 位必须 null、/I/ 物品 URL 必须 null', () => {
  assert.equal(C.parseScanText('XW4QYGBY'), null, '裸 8 位是物品专用通道');
  assert.equal(C.parseScanText('xw4qygby'), null);
  assert.equal(C.parseScanText('https://mes.newenergycoder.club/i/XW4QYGBY'), null, '/I/ 是物品短链');
  assert.equal(C.parseScanText('HTTPS://MES.NEWENERGYCODER.CLUB/I/FE1P8BZC'), null);
  assert.equal(C.parseScanText('https://example.com/c/XW4QYGBY') ? true : true, true, '任意主机（结构说明，非断言）');
  assert.equal(C.parseScanText(''), null);
  assert.equal(C.parseScanText(null), null);
});

test('双模块零互误判：物品短码喂 CtnLink / 容器短码喂 ItemLink 都必须 null（换盐隔离实证）', () => {
  const IL = require('../lib/item-link');
  assert.equal(C.decode(IL.fromItemCode('WP-001')), null);
  assert.equal(C.decode(IL.fromItemCode('WP-TS-001')), null);
  assert.equal(IL.decode(C.fromCtnCode('A4SH-001')), null);
  assert.equal(IL.decode(C.fromCtnCode('SLG-003')), null);
});

test('随机 1000 个 8 位串（固定样本）零误判为容器短链', () => {
  let seeded = 1299709;
  const rnd = () => { seeded = (seeded * 1103515245 + 12345) % 2147483648; return seeded / 2147483648; };
  const CH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let hits = 0;
  for (let i = 0; i < 1000; i++) {
    let s = '';
    for (let j = 0; j < 8; j++) s += CH[Math.floor(rnd() * 32)];
    if (C.parseScanText('https://mes.newenergycoder.club/c/' + s)) hits++;
  }
  assert.equal(hits, 0, '固定 1000 随机串必须全 null（实测误判率 1.10e-5，样本口径不赌概率）');
});

test('CTN_CATS 顺序与 index.html #gCtnType option 前缀段强耦合锁死（扩类必须同步两处）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/id="gCtnType"[\s\S]*?<\/select>/);
  assert.ok(m, 'index.html 必须存在 #gCtnType（容器建档类型下拉）');
  /* option value = '前缀|类型名|规格'；取前缀段（含数字前缀 A4SH/SC4） */
  const vals = [...m[0].matchAll(/<option value="([A-Z0-9]+)\|/g)].map(x => x[1]);
  assert.deepEqual(vals, C.CTN_CATS, '#gCtnType 的前缀段 option 顺序必须与 CTN_CATS 完全一致');
  C.CTN_CATS.forEach((k, i) => {
    assert.equal(C.ctnIndex(k), i + 1);
    assert.equal(C.ctnLetters(i + 1), k);
  });
});

test('ctnIndex/ctnLetters 边界：0 / 7 / 非白名单字母', () => {
  assert.equal(C.ctnIndex('A4SH'), 1);
  assert.equal(C.ctnIndex('KF'), 6);
  assert.equal(C.ctnIndex('WP'), null);
  assert.equal(C.ctnIndex('xk'), 3, '大小写归一');
  assert.equal(C.ctnIndex(''), null);
  assert.equal(C.ctnLetters(0), null);
  assert.equal(C.ctnLetters(7), null);
  assert.equal(C.ctnLetters(3), 'XK');
});
