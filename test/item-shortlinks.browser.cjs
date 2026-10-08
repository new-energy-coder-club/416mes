'use strict';
/* E2（定稿 §五/§6.7.1-2）：标签页二维码换短链的运行时断言 + 物品短链面板 DOM 行为。
   - jsQR 真实解码 labelHtml / pdfLabelPage / pdfA4SheetPage 三条路径的产物，
     内容必须 === 大写短链；回退路径（ItemLink 缺失 / WP-随机串）=== 旧 ITM: 格式；
   - 面板只在 curType==='itm' 渲染、行数 === sel.itm.size、非规范码标「需先改顺序码」、
     不是 #printSheet 后代。 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const LINK_001 = 'HTTPS://MES.NEWENERGYCODER.CLUB/I/KW4QYSBD';   // test/item-link.test.js 锁值（冻结大写形态）

test('E2: 标签二维码 jsQR 解码 === 短链（三路径）+ 回退 + 短链面板行为', { timeout: 180000 }, async t => {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root + path.sep)) throw Error('path');
      const bytes = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(bytes);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.ITM_TEST_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'offline fixture' }) });
    return route.continue();
  });
  const page = await context.newPage(); page.on('dialog', d => d.dismiss());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem('e2-test-seeded')) {
      localStorage.setItem('e2-test-seeded', 'yes');
      localStorage.setItem('mes416_state_v1', JSON.stringify({
        materials: [{ code: 'M-001', name: 'MAT', qty: 7 }],
        locations: [{ code: 'L-A', status: 'active' }],
        containers: [
          { code: 'A4SH-001', type: 'A4四抽收纳盒', spec: '蓝色', loc: 'L-A', status: 'active', version: 1, lastOpId: '' },
          { code: 'C-A', type: '自由编号', spec: '', loc: '', status: 'active', version: 1, lastOpId: '' }
        ],
        items: [
          { code: 'WP-001', name: '齿轮', spec: 'S1', loc: 'L-A', materialCode: 'M-001', status: 'pending', container: '', version: 0, lastOpId: '' },
          { code: 'WP-TS-002', name: 'TS件', spec: '', loc: '', materialCode: '', status: 'pending', container: '', version: 0, lastOpId: '' },
          { code: 'WP-a1b2c3d4', name: '历史随机码', spec: '', loc: '', materialCode: '', status: 'pending', container: '', version: 0, lastOpId: '' }
        ],
        transactions: [], workorders: [], members: [], manuals: []
      }));
    }
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof localStoreReady !== 'undefined');
  await page.evaluate(() => localStoreReady);
  await page.addScriptTag({ path: path.join(root, 'jsqr.min.js') });

  /* ---------- 运行时 jsQR：三条生成路径解码 === 大写短链（§6.7.1） ---------- */
  const decoded = await page.evaluate(async () => {
    async function decodeSvg(svg) {
      const patched = svg.replace('width="100%"', 'width="264"').replace('height="100%"', 'height="264"');
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg rasterize failed')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(patched); });
      const cv = document.createElement('canvas'); cv.width = 264; cv.height = 264;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 264, 264); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 264, 264);
      const r = jsQR(d.data, d.width, d.height);
      return r && r.data;
    }
    function decodeCanvas(cv) {
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height);
      const r = jsQR(d.data, d.width, d.height);
      return r && r.data;
    }
    const rec = { code: 'WP-001', name: '齿轮', spec: 'S1', loc: 'L-A', materialCode: 'M-001' };
    const out = {};
    /* 路径①：屏幕预览 labelHtml */
    const html = labelHtml('itm', rec);
    out.htmlQr = await decodeSvg(html.match(/<svg[\s\S]*?<\/svg>/)[0]);
    out.htmlCode = /<div class="code">WP-001<\/div>/.test(html);
    out.htmlShortAttr = html.includes('短码') && html.includes('KW4QYSBD');
    /* 路径②：标签纸 PDF pdfLabelPage */
    const p1 = await pdfLabelPage(rec, 'itm', null);
    out.pdfQr = decodeCanvas(p1.cv);
    /* 路径③：A4 整版 pdfA4SheetPage */
    const p2 = await pdfA4SheetPage([rec], 'itm', null);
    out.a4Qr = decodeCanvas(p2.cv);
    /* 人读区：PDF 侧 attrs 与 HTML 同源（labelAttrs） */
    out.attrs4 = JSON.stringify(labelAttrs('itm', rec)[3]);
    /* 回退①：ItemLink 缺失 → 旧 ITM: 格式 */
    const saved = window.ItemLink; window.ItemLink = undefined;
    out.fallbackNoIL = await decodeSvg(labelHtml('itm', rec).match(/<svg[\s\S]*?<\/svg>/)[0]);
    window.ItemLink = saved;
    /* 回退②：WP-随机串非规范码 → ITM:<原码> */
    out.fallbackRandom = await decodeSvg(labelHtml('itm', { code: 'WP-a1b2c3d4', name: '旧' }).match(/<svg[\s\S]*?<\/svg>/)[0]);
    /* 非 itm 类型不受影响 */
    out.locQr = await decodeSvg(labelHtml('loc', { code: 'L-A', kind: '货架', desc: '' }).match(/<svg[\s\S]*?<\/svg>/)[0]);
    return out;
  });
  assert.equal(decoded.htmlQr, LINK_001, 'labelHtml 预览 QR 必须解出大写短链');
  assert.equal(decoded.pdfQr, LINK_001, 'pdfLabelPage 标签纸 PDF QR 必须解出同一条短链');
  assert.equal(decoded.a4Qr, LINK_001, 'pdfA4SheetPage A4 整版 QR 必须解出同一条短链');
  assert.equal(decoded.htmlCode, true, '人读主码 .code 必须仍是 WP-001');
  assert.equal(decoded.htmlShortAttr, true, '右栏必须含「短码 KW4QYSBD」行');
  assert.equal(decoded.attrs4, '["短码","KW4QYSBD"]', 'PDF 侧 attrs 第 4 条必须是同一短码行');
  assert.equal(decoded.fallbackNoIL, 'ITM:WP-001', 'ItemLink 缺失必须回退旧 ITM: 格式');
  assert.equal(decoded.fallbackRandom, 'ITM:WP-a1b2c3d4', 'WP-随机串必须回退 ITM:<原码>（旧标签永久可读）');
  assert.equal(decoded.locQr, 'LOC:L-A', '非 itm 类型必须保持原前缀格式');

  /* ---------- 面板 DOM 行为（§6.7.2） ---------- */
  await page.evaluate(() => goTab('label'));
  await page.locator('#typeBar button[data-t="itm"]').click();
  const panelState0 = await page.evaluate(() => {
    const panel = document.getElementById('itemLinksPanel');
    return {
      hidden: panel.hidden,
      inPrintSheet: !!panel.closest('#printSheet'),
      parentIsPanel: panel.parentElement.classList.contains('panel'),
      prevIsLabelLayout: !!panel.previousElementSibling && panel.previousElementSibling.classList.contains('label-layout'),
      nextIsCtnPanel: !!panel.nextElementSibling && panel.nextElementSibling.id === 'ctnLinksPanel',
      ctnPanelNextIsDanger: !!document.getElementById('ctnLinksPanel').nextElementSibling && document.getElementById('ctnLinksPanel').nextElementSibling.classList.contains('danger-zone'),
      rows: panel.querySelectorAll('#linksTable tbody tr:not(.links-empty)').length
    };
  });
  assert.equal(panelState0.hidden, false, 'itm 类型下面板必须渲染');
  assert.equal(panelState0.inPrintSheet, false, '面板不得是 #printSheet 后代（打印自动隐藏的结构保证）');
  assert.equal(panelState0.parentIsPanel, true, '面板必须是 .panel 直子');
  assert.equal(panelState0.prevIsLabelLayout, true, '物品短链面板必须紧跟 .label-layout');
  assert.equal(panelState0.nextIsCtnPanel, true, 'v3.13.35 后物品短链面板之后应是容器短链面板');
  assert.equal(panelState0.ctnPanelNextIsDanger, true, '两个短链面板整体必须位于 danger-zone 之前');
  assert.equal(panelState0.rows, 0, '未勾选时无数据行');

  /* 勾选 WP-001（下标0）与 WP-a1b2c3d4（下标2）→ 行数 === sel.itm.size */
  const boxes = page.locator('#recTable tbody .recSel');
  await boxes.nth(0).check();
  await boxes.nth(2).check();
  const rowsInfo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#linksTable tbody tr:not(.links-empty)')];
    return {
      selSize: sel.itm.size,
      count: rows.length,
      cells: rows.map(tr => [...tr.querySelectorAll('td')].slice(0, 6).map(td => td.textContent.trim())),
      disabledBtns: rows.map(tr => [...tr.querySelectorAll('button')].filter(b => b.disabled).length)
    };
  });
  assert.equal(rowsInfo.count, rowsInfo.selSize, '面板行数必须 === sel.itm.size（与导出 PDF 同一选择集）');
  assert.equal(rowsInfo.count, 2);
  assert.deepEqual(rowsInfo.cells[0].slice(0, 5), ['WP-001', '齿轮', 'M-001', 'KW4QYSBD', LINK_001]);
  assert.equal(rowsInfo.cells[0][5], '可生成');
  assert.equal(rowsInfo.cells[1][0], 'WP-a1b2c3d4');
  assert.equal(rowsInfo.cells[1][3], '', '非规范码行短码单元格必须为空');
  assert.equal(rowsInfo.cells[1][4], '', '非规范码行短链接必须为空');
  assert.equal(rowsInfo.cells[1][5], '需先改顺序码', '非规范码行状态必须标「需先改顺序码」');
  assert.equal(rowsInfo.disabledBtns[1], 2, '非规范码行的复制/预览按钮必须禁用');

  /* 行内预览二维码：复用 qrSvg，内容与标签 QR 同源 */
  await page.locator('#linksTable tbody tr:not(.links-empty)').first().locator('.links-qr').click();
  const qrPreview = await page.evaluate(() => {
    const box = document.getElementById('linksQrPreview');
    return { hidden: box.hidden, hasSvg: !!box.querySelector('svg'), text: box.textContent };
  });
  assert.equal(qrPreview.hidden, false);
  assert.equal(qrPreview.hasSvg, true, '预览二维码必须复用 qrSvg 出 SVG');
  assert.ok(qrPreview.text.includes(LINK_001));

  /* 复制全部 / 导出 CSV 按钮存在且接到纯函数 */
  assert.equal(await page.locator('#btnLinksCopyAll').count(), 1);
  assert.equal(await page.locator('#btnLinksCsv').count(), 1);
  const copyText = await page.evaluate(() => shortlinksCopyText(document.getElementById('itemLinksPanel')._rows));
  assert.equal(copyText, LINK_001, '复制全部只产出有短链的行，每行一条完整 URL');

  /* 切到非 itm 类型：面板隐藏、无数据行 */
  await page.locator('#typeBar button[data-t="loc"]').click();
  const panelStateLoc = await page.evaluate(() => {
    const panel = document.getElementById('itemLinksPanel');
    return { hidden: panel.hidden, rows: panel.querySelectorAll('#linksTable tbody tr').length };
  });
  assert.equal(panelStateLoc.hidden, true, '非 itm 类型面板必须隐藏');
  assert.equal(panelStateLoc.rows, 0, '非 itm 类型面板不得有数据行');

  /* ---------- 容器短链面板（v3.13.35 W7-W9/D9）：平行行为 ---------- */
  const C = require('../lib/ctn-link');
  const CTN_LINK_001 = 'HTTPS://MES.NEWENERGYCODER.CLUB/C/' + C.fromCtnCode('A4SH-001');   // XW4QYGBY
  /* 容器标签三路径 QR === /c/ 短链；非规范容器码回退 CTN:<码> */
  const ctnDecoded = await page.evaluate(async (ctnLink) => {
    async function decodeSvg(svg) {
      const patched = svg.replace('width="100%"', 'width="264"').replace('height="100%"', 'height="264"');
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg rasterize failed')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(patched); });
      const cv = document.createElement('canvas'); cv.width = 264; cv.height = 264;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 264, 264); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 264, 264);
      const r = jsQR(d.data, d.width, d.height);
      return r && r.data;
    }
    function decodeCanvas(cv) {
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height);
      const r = jsQR(d.data, d.width, d.height);
      return r && r.data;
    }
    const rec = { code: 'A4SH-001', type: 'A4四抽收纳盒', spec: '蓝色', loc: 'L-A' };
    const out = {};
    const html = labelHtml('ctn', rec);
    out.htmlQr = await decodeSvg(html.match(/<svg[\s\S]*?<\/svg>/)[0]);
    out.htmlShortAttr = html.includes('短码') && html.includes('XW4QYGBY');
    const p1 = await pdfLabelPage(rec, 'ctn', null);
    out.pdfQr = decodeCanvas(p1.cv);
    const p2 = await pdfA4SheetPage([rec], 'ctn', null);
    out.a4Qr = decodeCanvas(p2.cv);
    out.attrs4 = JSON.stringify(labelAttrs('ctn', rec)[3]);
    /* 非规范容器码（C-A 自由编号）→ 回退 CTN:<码>（D6 存量零失效） */
    out.fallbackFreeCode = await decodeSvg(labelHtml('ctn', { code: 'C-A', type: '自由编号', spec: '' }).match(/<svg[\s\S]*?<\/svg>/)[0]);
    return out;
  });
  assert.equal(ctnDecoded.htmlQr, CTN_LINK_001, '容器 labelHtml 预览 QR 必须解出 /c/ 大写短链');
  assert.equal(ctnDecoded.pdfQr, CTN_LINK_001, '容器 pdfLabelPage QR 必须解出同一条短链');
  assert.equal(ctnDecoded.a4Qr, CTN_LINK_001, '容器 pdfA4SheetPage QR 必须解出同一条短链');
  assert.equal(ctnDecoded.htmlShortAttr, true, '容器标签右栏必须含「短码 XW4QYGBY」行');
  assert.equal(ctnDecoded.attrs4, '["短码","XW4QYGBY"]', '容器 PDF 侧 attrs 第 4 条必须是短码行');
  assert.equal(ctnDecoded.fallbackFreeCode, 'CTN:C-A', '自由编号容器必须回退 CTN:<码>（旧标签零失效）');

  /* 容器短链面板：curType==='ctn' 才渲染；行数 === sel.ctn.size；非规范码禁用 */
  await page.locator('#typeBar button[data-t="ctn"]').click();
  const ctnPanelState = await page.evaluate(() => {
    const panel = document.getElementById('ctnLinksPanel');
    return {
      hidden: panel.hidden,
      exists: !!panel,
      inPrintSheet: !!panel.closest('#printSheet'),
      rows: panel.querySelectorAll('#ctnLinksTable tbody tr:not(.links-empty)').length,
      itemPanelHidden: document.getElementById('itemLinksPanel').hidden
    };
  });
  assert.equal(ctnPanelState.exists, true, '#ctnLinksPanel 必须存在');
  assert.equal(ctnPanelState.hidden, false, 'ctn 类型下容器短链面板必须渲染');
  assert.equal(ctnPanelState.inPrintSheet, false, '容器面板不得是 #printSheet 后代');
  assert.equal(ctnPanelState.itemPanelHidden, true, '物品面板此时必须隐藏（互斥渲染）');

  const ctnBoxes = page.locator('#recTable tbody .recSel');
  await ctnBoxes.nth(0).check();   // A4SH-001
  await ctnBoxes.nth(1).check();   // C-A
  const ctnRowsInfo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#ctnLinksTable tbody tr:not(.links-empty)')];
    return {
      selSize: sel.ctn.size,
      count: rows.length,
      cells: rows.map(tr => [...tr.querySelectorAll('td')].slice(0, 6).map(td => td.textContent.trim())),
      disabledBtns: rows.map(tr => [...tr.querySelectorAll('button')].filter(b => b.disabled).length)
    };
  });
  assert.equal(ctnRowsInfo.count, ctnRowsInfo.selSize, '容器面板行数必须 === sel.ctn.size');
  assert.equal(ctnRowsInfo.count, 2);
  assert.deepEqual(ctnRowsInfo.cells[0].slice(0, 5), ['A4SH-001', 'A4四抽收纳盒', '蓝色', 'XW4QYGBY', CTN_LINK_001]);
  assert.equal(ctnRowsInfo.cells[0][5], '可生成');
  assert.equal(ctnRowsInfo.cells[1][0], 'C-A');
  assert.equal(ctnRowsInfo.cells[1][3], '', '非规范容器码短码单元格必须为空');
  assert.equal(ctnRowsInfo.cells[1][5], '无短链，印 CTN: 码', '非规范容器码状态提示');
  assert.equal(ctnRowsInfo.disabledBtns[1], 2, '非规范容器码行的复制/预览按钮必须禁用');

  /* 复制全部（容器）接到平行纯函数；切回 itm 后容器面板隐藏 */
  assert.equal(await page.locator('#btnCtnLinksCopyAll').count(), 1);
  assert.equal(await page.locator('#btnCtnLinksCsv').count(), 1);
  const ctnCopyText = await page.evaluate(() => ctnLinksCopyText(document.getElementById('ctnLinksPanel')._rows));
  assert.equal(ctnCopyText, CTN_LINK_001, '容器复制全部只产出有短链的行');
  await page.locator('#typeBar button[data-t="itm"]').click();
  const ctnPanelHiddenAfterItm = await page.evaluate(() => document.getElementById('ctnLinksPanel').hidden);
  assert.equal(ctnPanelHiddenAfterItm, true, '切回 itm 后容器面板必须隐藏');

  /* /c/ 链接扫码归一（handleScan W1）：扫整条短链 → CTN 查询定位 */
  const scanResult = await page.evaluate(async (url) => {
    goTab('scan');
    handleScan(url);
    await new Promise(r => setTimeout(r, 50));
    const box = document.getElementById('scanResult');
    return { text: box.textContent, hasCtnCard: !!box.querySelector('.scan-prefix--ctn') || box.textContent.includes('CTN:A4SH-001') };
  }, CTN_LINK_001);
  assert.ok(scanResult.hasCtnCard || scanResult.text.includes('A4SH-001'), '/c/ 链接扫码必须归一为容器查询，不得报「未找到物料」');
  assert.ok(!scanResult.text.includes('未找到物料'), '磨损守卫反向：正常 /c/ 短链绝不能落 MAT: 兜底');

  /* 磨损 /c/ URL（校验位破坏）→ 容器磨损警示卡（W1 建议②：大小写不敏感守卫） */
  const wornShort = C.fromCtnCode('A4SH-001').slice(0, 7) + (C.fromCtnCode('A4SH-001')[7] === 'X' ? 'Y' : 'X');
  const wornResult = await page.evaluate(async (url) => {
    handleScan(url.toUpperCase());
    await new Promise(r => setTimeout(r, 50));
    return document.getElementById('scanResult').textContent;
  }, 'https://mes.newenergycoder.club/c/' + wornShort);
  assert.match(wornResult, /容器短码识别失败/, '大写磨损 /c/ URL 必须出容器磨损卡（守卫大小写不敏感）');
  assert.ok(!wornResult.includes('未找到物料'), '磨损 URL 绝不能静默落 MAT: 兜底');

  assert.deepEqual(errors, [], '页面不得有未捕获异常');
  console.log(JSON.stringify({ threePaths: decoded.htmlQr === decoded.pdfQr && decoded.pdfQr === decoded.a4Qr, fallback: [decoded.fallbackNoIL, decoded.fallbackRandom], panelRows: rowsInfo.count, ctnThreePaths: ctnDecoded.htmlQr === ctnDecoded.pdfQr && ctnDecoded.pdfQr === ctnDecoded.a4Qr, ctnPanelRows: ctnRowsInfo.count, pageErrors: errors }));
});
