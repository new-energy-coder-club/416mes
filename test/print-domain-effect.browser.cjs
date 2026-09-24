/**
 * TASK-09 M9：打印域**效果级**冒烟测试（补 align-recovery 冻结块之外的空白）。
 *
 * 背景：align-recovery.test.js:800 已有「冻结块原文不得改」的保护（防人改 @page /
 * @media print 源码），但**没有任何测试验证算出来的效果**——60×40mm 实际尺寸、
 * 区卡只在 A4 下可见这类行为，一旦被某次重构碰坏，只会安静地打印错版。
 *
 * 本文件断言**计算值/行为**，不比对源码字符串：
 *   ① .label 计算宽高 = 60mm × 40mm
 *   ② @page 规则确实存在于样式表
 *   ③ body:not(.a4paper) 下 .zonecard 被 display:none 挡住（区卡只能在 A4 打印）
 *
 * 条码可扫性需真机（待办.md §2.2），此处**不做**，保留人工。
 * 运行：npm run test:browser
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
/* 与其它 browser 测试共用一个只服务本仓库文件的静态服务器 + 禁止一切外网。
   页面启动会试图拉飞书/云端，这里一律 abort，只验证本地渲染与打印规则。 */
function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root + path.sep)) throw new Error('path');
      const bytes = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(bytes);
    } catch { res.statusCode = 404; res.end(); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, origin: 'http://127.0.0.1:' + server.address().port })));
}

test('print domain effect smoke：label 60×40mm、@page 在位、区卡仅 A4 可见', { timeout: 120000 }, async t => {
  const { server, origin } = await startServer();
  t.after(() => new Promise(r => server.close(r)));
  const browser = await chromium.launch({
    executablePath: process.env.ITM_TEST_CHROMIUM || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const denied = [];
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin !== origin) { denied.push(u.origin); return route.abort(); }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  /* 种子状态：放一个模块区库位（kind='模块区'），否则区卡页类型没记录可欲，
     A4 硬哦卫那句根本跑不到。 */
  await page.addInitScript(() => {
    try {
      const raw = localStorage.getItem('mes416_state_v1');
      const st = raw ? JSON.parse(raw) : { locations: [], containers: [], items: [], materials: [] };
      st.locations = st.locations || [];
      if (!st.locations.some(l => l.kind === '模块区')) {
        st.locations.push({ code: 'M-99', kind: '模块区', desc: '审查用模块区' });
      }
      localStorage.setItem('mes416_state_v1', JSON.stringify(st));
    } catch (e) {}
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof localStoreReady !== 'undefined');
  await page.evaluate(() => localStoreReady);

  /* ① .label 计算尺寸 = 60mm × 40mm。
     用 mm→px 换算校验（96dpi 下 1mm ≈ 3.7795px），容差 1px 防四舍五入。 */
  await page.evaluate(() => goTab('label'));
  await page.waitForFunction(() => document.getElementById('printSheet'));
  /* renderPreview 只在**勾选了记录**时才渲染 .label（空选择集只渲染一句提示）。
     故先勾第一张表的第一个复选框，再触发一次渲染。 */
  await page.evaluate(() => {
    const box = document.querySelector('#tab-label input[type=checkbox]');
    if (box) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
    if (typeof renderPreview === 'function') renderPreview();
  });
  const labelBox = await page.evaluate(() => {
    const el = document.querySelector('#printSheet .label');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, count: document.querySelectorAll('#printSheet .label').length };
  });
  assert.ok(labelBox, '打印预览里必须有 .label 元素');
  const MM = 3.7795275591;
  assert.ok(Math.abs(labelBox.w - 60 * MM) <= 1, '.label 计算宽度应 ≈ 60mm，实际 ' + labelBox.w + 'px（期望 ' + (60 * MM).toFixed(1) + '）');
  assert.ok(Math.abs(labelBox.h - 40 * MM) <= 1, '.label 计算高度应 ≈ 40mm，实际 ' + labelBox.h + 'px（期望 ' + (40 * MM).toFixed(1) + '）');

  /* ② @page 规则存在于样式表（冻结声明 @page{size:60mm 40mm;margin:0;}）。 */
  const pageRule = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const rule of rules) {
        if (rule.constructor && rule.constructor.name === 'CSSPageRule') {
          return { selectorText: rule.selectorText, style: rule.style ? rule.style.cssText : '' };
        }
      }
    }
    return null;
  });
  assert.ok(pageRule, '样式表里必须有 @page 规则');
  assert.match(pageRule.style || '', /60mm|40mm/, '@page 必须声明 60mm/40mm');

  /* ③ 区卡 CSS 硬守卫：非 A4 纸型下 .zonecard 必须 display:none（区卡只能在 A4 打印）。
     当前默认纸型可能是标签纸或 A4，故两种都测：非 a4 → none；a4 → 非 none。 */
  /* 区卡只在选到 zone 类型时才渲染；主动切过去以覆盖 A4 硬守卫这条路径。 */
  const zoneGuard = await page.evaluate(() => {
    const btn = document.querySelector('#tab-label button[data-t=zone]');
    if (btn) btn.click();
    /* 切到区卡类型后选择集是空的（sel 按类垏分），必须勾一条才会渲染。 */
    const box = document.querySelector('#tab-label input[type=checkbox]');
    if (box) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
    if (typeof renderPreview === 'function') renderPreview();
    const z = document.querySelector('#printSheet .zonecard');
    return { hasZone: !!z, paper: document.body.className, zoneCount: (state.locations||[]).filter(l=>l.kind==='模块区').length, btnFound: !!btn };
  });
  if (zoneGuard.hasZone) {
    /* 硬哦卡在 @media print 块内（index.html:1069 起），只在真正打印时生效；
       屏幕模式读到的总是普通 display，必须把媒体模拟成 print才能验证。 */
    await page.emulateMedia({ media: 'print' });
    const printStyles = await page.evaluate(() => {
      const read = () => getComputedStyle(document.querySelector('#printSheet .zonecard')).display;
      document.body.classList.remove('a4paper');
      const notA4 = read();
      document.body.classList.add('a4paper');
      const a4 = read();
      return { notA4, a4 };
    });
    await page.emulateMedia({ media: 'screen' });
    assert.equal(printStyles.notA4, 'none',
      '非 A4 纸型下区卡必须被 CSS 硬哦卡隐藏（index.html:1094），实际 display=' + printStyles.notA4);
    assert.notEqual(printStyles.a4, 'none', 'A4 纸型下区卡必须可见');
  }

  assert.deepEqual(errors, [], '不应有页面 JS 错误');
  console.log(JSON.stringify({ labelW: Math.round(labelBox.w), labelH: Math.round(labelBox.h), mm: `${(labelBox.w / MM).toFixed(1)}x${(labelBox.h / MM).toFixed(1)}`, zoneChecked: zoneGuard.hasZone, pageErrors: errors, deniedExternal: denied.length }));
});
