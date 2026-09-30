/* ctn-link.js — 容器二维码短链：8 位短码 ↔ 容器码（UMD，浏览器/Node 共用）
 *
 * 容器码格式：<类型前缀>-<序号>（如 A4SH-001）；类型前缀 = index.html 建档下拉六类白名单
 * （A4SH/SLG/XK/ZZX/SC4/KF，ctnIndex 1..6）。受控建档允许自由现场编号（如 C-A）——
 * 非白名单码**没有短码**，标签/扫码回退 CTN:<裸码> 前缀串（与物品「非规范码无短码」同构）。
 * 短码 = 8 位 Crockford Base32：数据 25bit（类型 4bit + 序号 21bit）+ 校验 15bit。
 *   scrambled = (raw * 20740581 + 104729) mod 2^25
 *   chk = FNV1a32('416mes-ctn:'+type+':'+serial) >>> 17    ← 换盐：与物品短码互不误判
 * ⚠ 本模块与 lib/item-link.js 同骨架但**各自独立冻结**：物品算法印刷即冻结（lib/item-link.js:7），
 * 本模块一旦印出第一批容器标签同样冻结——禁止对拼接值使用位运算（int32 截断坑），一律乘除/取模。
 * 逆元 17308653 为硬编码（mod 2^25，扩展欧几里得离线算出）。
 * D8 立规：裸 8 位码是物品专用识别通道，本模块 parseScanText 只认 /c/ URL 形态，结构上不设裸码入口。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CtnLink = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford：无 I/L/O/U（与物品同）
  const MOD = 33554432;          // 2^25（与物品同值：加扰参数非安全参数，同值即可，盐已隔离）
  const MULT = 20740581;
  const OFFSET = 104729;
  const INV = 17308653;          // MULT 在 mod 2^25 下的乘法逆元（离线算出，勿改）
  const CHK_MOD = 32768;         // 2^15
  /* 印刷版短链整条大写（QR alphanumeric 模式）；/C/ 大写主路由 + /c/ 小写兼容入口（双路由，
     物品侧曾因只配小写生产 404——两条都必须配）。整链 42 字符 = V3-M 容量 61 余 19。 */
  const BASE_URL = 'HTTPS://MES.NEWENERGYCODER.CLUB/C/';

  /* 类型白名单：顺序必须与 index.html 建档容器类型下拉的 option value 前缀段一致
     （index.html #gCtnType，test/ctn-link.test.js 耦合锁）。 */
  const CTN_CATS = ['A4SH', 'SLG', 'XK', 'ZZX', 'SC4', 'KF'];

  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
  }

  function ctnIndex(letters) {
    const i = CTN_CATS.indexOf(String(letters || '').trim().toUpperCase());
    return i < 0 ? null : i + 1;
  }
  function ctnLetters(i) {
    return i >= 1 && i <= CTN_CATS.length ? CTN_CATS[i - 1] : null;
  }

  /* 容器码 → {type, serial}；任何不规范形态返回 null（无短码，调用方回退 CTN: 前缀串）。
     规则：前缀可含数字（A4SH/SC4，教训同 index.html nextCode 的前缀解析）；
     序号 <1000 必须恰好 3 位补零、≥1000 原样大写（与 nextCode 产物一致）——
     往返恒等校验用 trim 后【未大写】的原串比较：大写归一会掩盖 'a4sh-001' 这类
     存储键错位（短链落地 toCtnCode 解析成 'A4SH-001'，与存储业务键 'a4sh-001' 不符 → 查无此容器）。 */
  function parseCtnCode(code) {
    const raw = String(code == null ? '' : code).trim();
    if (!raw) return null;
    const m = raw.toUpperCase().match(/^([A-Z0-9]+)-(\d+)$/);
    if (!m) return null;
    const type = ctnIndex(m[1]);
    if (type === null) return null;
    const serial = parseInt(m[2], 10);
    if (!Number.isSafeInteger(serial) || serial < 1 || serial > 2097151) return null;
    if (toCtnCode({ type, serial }) !== raw) return null;   // 往返恒等：A4SH-7→A4SH-007 错位即拒
    return { type, serial };
  }

  function checksum(type, serial) { return fnv1a('416mes-ctn:' + type + ':' + serial) >>> 17; }

  /* {type,serial} → 8 位短码 */
  function encode(type, serial) {
    const raw = type * 2097152 + serial;                      // 类型高 4bit + 序号低 21bit
    const scrambled = (raw * MULT + OFFSET) % MOD;
    const packed = scrambled * CHK_MOD + checksum(type, serial);
    let v = packed, out = '';
    for (let i = 0; i < 8; i++) { out = ALPHABET[v % 32] + out; v = Math.floor(v / 32); }
    return out;
  }

  /* 8 位短码 → {type, serial}；校验不过返回 null（Crockford 易混字符映射与物品同） */
  function decode(short) {
    const s = String(short || '').trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, '');
    if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(s)) return null;
    let v = 0;
    for (const ch of s) v = v * 32 + ALPHABET.indexOf(ch);
    const chk = v % CHK_MOD, scrambled = Math.floor(v / CHK_MOD);
    const raw = ((scrambled - OFFSET) % MOD + MOD) % MOD * INV % MOD;
    const type = Math.floor(raw / 2097152), serial = raw % 2097152;
    if (serial < 1 || type < 1 || type > CTN_CATS.length) return null;
    if (checksum(type, serial) !== chk) return null;
    return { type, serial };
  }

  function toCtnCode(decoded) {
    if (!decoded) return null;
    const p = ctnLetters(decoded.type);
    if (!p) return null;
    return p + '-' + String(decoded.serial).padStart(3, '0');
  }

  function fromCtnCode(code) {
    const p = parseCtnCode(code);
    return p ? encode(p.type, p.serial) : null;
  }
  function linkFor(code) {
    const s = fromCtnCode(code);
    return s ? BASE_URL + s : null;
  }

  /* 扫码统一入口：**仅** /c/ URL 形态（任意主机、尾斜杠与 ?query/#hash 容忍、大小写不敏感——
     印刷版整条大写，扫码枪读到的是全大写串）。裸 8 位码是物品专用通道（D8 仓库立规），
     这里结构上不设入口：裸 8 位一律返回 null，由物品 ItemLink.parseScanText 接管。 */
  function parseScanText(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/\/c\/([0-9A-Za-z]{8})\/?(?:[?#].*)?$/i);
    if (!m) return null;
    const d = decode(m[1]);
    return d ? { short: m[1].toUpperCase(), code: toCtnCode(d) } : null;
  }

  return { ALPHABET, BASE_URL, CTN_CATS, encode, decode, parseCtnCode, fromCtnCode, linkFor, toCtnCode, parseScanText, ctnIndex, ctnLetters };
});
