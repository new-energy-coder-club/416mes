/* item-link.js — 物品二维码短链：8 位短码 ↔ 物品码（UMD，浏览器/Node 共用）
 *
 * 物品码格式：WP-<分类>-<序号>（如 WP-TS-001）或存量 WP-<序号>（如 WP-001，分类=0）。
 * 短码 = 8 位 Crockford Base32：数据 25bit（分类 4bit + 序号 21bit）+ 校验 15bit。
 *   scrambled = (raw * 20740581 + 104729) mod 2^25   （乘数实测散布不连号）
 *   chk = FNV1a32('416mes:'+cat+':'+serial) >>> 17
 * ⚠ 算法已印刷即冻结。禁止对拼接值使用位运算（int32 截断坑），一律乘除/取模。
 * 逆元 17308653 为硬编码（mod 2^25，扩展欧几里得离线算出）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ItemLink = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford：无 I/L/O/U
  const MOD = 33554432;          // 2^25
  const MULT = 20740581;
  const OFFSET = 104729;
  const INV = 17308653;          // MULT 在 mod 2^25 下的乘法逆元（离线算出，勿改）
  const CHK_MOD = 32768;         // 2^15
  /* 冻结（定稿 §二/§6.3）：印刷版短链整条大写 —— 全字符落入 QR alphanumeric 字符集，
     V3-M 容量 61 字符，42 字符余量 19。/I/ 大写路径由 vercel.json / feishu-server.mjs 双路由承接，
     /i/ 小写仅作兼容入口（parseScanText 两态都认）。 */
  const BASE_URL = 'HTTPS://MES.NEWENERGYCODER.CLUB/I/';

  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
  }

  /* 物品码 → {cat, serial}；不匹配 WP 数字格式返回 null（走在线查表兜底，v1 不支持） */
  function parseItemCode(code) {
    const m = String(code || '').trim().toUpperCase().match(/^WP-(?:([A-Z]{2})-)?(\d+)$/);
    if (!m) return null;
    const cat = m[1] ? catIndex(m[1]) : 0;
    const serial = parseInt(m[2], 10);
    if (cat === null || !Number.isSafeInteger(serial) || serial < 1 || serial > 2097151) return null;
    return { cat, serial };
  }
  function catIndex(letters) {
    const CATS = ['JG', 'DJ', 'DZ', 'GZ', 'TS', 'GJ', 'HC', 'QT'];
    const i = CATS.indexOf(letters);
    return i < 0 ? null : i + 1;
  }
  function catLetters(i) {
    const CATS = ['JG', 'DJ', 'DZ', 'GZ', 'TS', 'GJ', 'HC', 'QT'];
    return i >= 1 && i <= 8 ? CATS[i - 1] : null;
  }

  function checksum(cat, serial) { return fnv1a('416mes:' + cat + ':' + serial) >>> 17; }

  /* {cat,serial} → 8 位短码 */
  function encode(cat, serial) {
    const raw = cat * 2097152 + serial;                       // 分类高 4bit + 序号低 21bit
    const scrambled = (raw * MULT + OFFSET) % MOD;
    const packed = scrambled * CHK_MOD + checksum(cat, serial);
    let v = packed, out = '';
    for (let i = 0; i < 8; i++) { out = ALPHABET[v % 32] + out; v = Math.floor(v / 32); }
    return out;
  }

  /* 8 位短码 → {cat, serial}；校验不过返回 null */
  function decode(short) {
    const s = String(short || '').trim().toUpperCase().replace(/[ILOU]/g, '');
    if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(s)) return null;
    let v = 0;
    for (const ch of s) v = v * 32 + ALPHABET.indexOf(ch);
    const chk = v % CHK_MOD, scrambled = Math.floor(v / CHK_MOD);
    const raw = ((scrambled - OFFSET) % MOD + MOD) % MOD * INV % MOD;
    const cat = Math.floor(raw / 2097152), serial = raw % 2097152;
    if (serial < 1 || cat > 8) return null;
    if (checksum(cat, serial) !== chk) return null;
    return { cat, serial };
  }

  function toItemCode(decoded) {
    if (!decoded) return null;
    const c = catLetters(decoded.cat);
    return (c ? 'WP-' + c + '-' : 'WP-') + String(decoded.serial).padStart(3, '0');
  }

  function fromItemCode(code) {
    const p = parseItemCode(code);
    return p ? encode(p.cat, p.serial) : null;
  }
  function linkFor(code) {
    const s = fromItemCode(code);
    return s ? BASE_URL + s : null;
  }

  /* 服务端发号（纯函数）：rows=快照物品数组，category=八类字母之一。
   * 同分类（cat 独立序列，0=未分类存量与八类互不干扰）取 max(serial)+1，归一 3 位序号。
   * 必须走 parseItemCode 过滤——天然排除 WP-uuid / WP-DEMO-001 等污染，小写存码归一计入（防撞号）。
   * 分类非法返回 null（调用方拒 BAD_CATEGORY）；序号超 21bit 上限抛 SERIAL_EXHAUSTED。 */
  function nextItemCode(rows, category) {
    const cat = catIndex(String(category == null ? '' : category).trim().toUpperCase());
    if (cat === null) return null;
    let max = 0;
    for (const row of rows || []) {
      const p = parseItemCode(row && typeof row === 'object' ? row.code : row);
      if (p && p.cat === cat && p.serial > max) max = p.serial;
    }
    if (max >= 2097151) { const e = new Error('SERIAL_EXHAUSTED'); e.code = 'SERIAL_EXHAUSTED'; throw e; }
    return toItemCode({ cat, serial: max + 1 });
  }

  /* 扫码/手输统一入口：整条短链 URL 或裸 8 位码都可识别（任意主机，离线可用）。
     URL 部分大小写不敏感：印刷版按冻结规格整条大写（QR 数字字母模式只容大写），
     扫码枪/微信读到的就是全大写串，必须能解；8 位码本身 decode 内已归一大写。 */
  function parseScanText(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/\/i\/([0-9A-Za-z]{8})(?:[?#].*)?$/i);
    const body = m ? m[1] : (/^[0-9A-Za-z]{8}$/.test(s) ? s : null);
    if (!body) return null;
    const d = decode(body);
    return d ? { short: body.toUpperCase(), code: toItemCode(d) } : null;
  }

  return { ALPHABET, BASE_URL, encode, decode, parseItemCode, fromItemCode, linkFor, toItemCode, parseScanText, catIndex, catLetters, nextItemCode };
});
