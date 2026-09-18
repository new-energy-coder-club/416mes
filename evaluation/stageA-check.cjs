'use strict';
// 阶段A 浏览器核查：390px 底部导航应直接露出「物品作业」等主入口，无整页横向溢出。
const http = require('http'), fs = require('fs/promises'), path = require('path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root + path.sep)) throw 0;
      const b = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(b);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.ITM_TEST_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/*', route => { const u = new URL(route.request().url()); if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }); route.continue(); });
  const page = await ctx.newPage();
  page.on('dialog', d => d.dismiss());
  await page.goto('http://127.0.0.1:' + server.address().port + '/index.html#item-work', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof localStoreReady !== 'undefined');
  await page.evaluate(() => localStoreReady);
  const nav = await page.locator('#mainTabs button:visible').allInnerTexts();
  const navWidth = await page.evaluate(() => ({ inner: innerWidth, body: document.body.scrollWidth, doc: document.documentElement.scrollWidth }));
  await page.screenshot({ path: path.join(__dirname, 'stageA-mobile-nav.png') });
  const primary = await page.evaluate(() => [...document.querySelectorAll('#mainTabs button[data-primary]')].map(b => b.dataset.tab));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  console.log(JSON.stringify({ nav, navWidth, primary }));
  await browser.close(); server.close();
  const ok = nav.some(t => t.includes('物品作业')) && navWidth.body <= 390;
  if (!ok) { console.error('STAGE-A FAIL'); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

// 追加：作业区按钮组核查（二次运行时独立检查布局）
