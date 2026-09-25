'use strict';
/* TASK-16 只读+低风险组实测：N1/N3/L5/H1-H4/K3/M2/M3
   生产环境；硬约束：不删既有库位/容器行（N3 用新造测试行验证守卫）。 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const OUT = '/tmp/opencode/t16';
const R = {};   // 结果收集

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.ITM_TEST_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await ctx.addInitScript(() => { window.confirm = () => false; window.prompt = () => null; window.alert = () => {}; });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));

  await page.goto('https://mes.newenergycoder.club/index.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => typeof localStoreReady !== 'undefined', null, { timeout: 60000, polling: 500 });
  await page.evaluate(() => localStoreReady);
  await page.waitForFunction(() => window.state && Array.isArray(state.locations) && state.locations.length > 100, null, { timeout: 120000, polling: 500 });
  R.boot = { ok: true, jsErrorsBefore: jsErrors.length };

  /* ---------- N1 资源档案列表渲染与计数 ---------- */
  await page.evaluate(() => goTab('res'));
  await page.waitForTimeout(600);
  R.N1 = await page.evaluate(() => {
    const types = [...document.querySelectorAll('.res-type')].map(b => ({ label: b.textContent.trim().replace(/\d+$/, ''), selected: b.getAttribute('aria-selected') === 'true' }));
    const rows = document.querySelectorAll('#resTable tbody tr, #resTableBody tr').length;
    const anyTable = document.querySelector('#resTable');
    return { typeButtons: types, visibleRows: rows, tableText: (anyTable ? anyTable.textContent : '').slice(0, 120), stateCounts: { locations: state.locations.length, containers: state.containers.length, items: state.items.length, manuals: (state.manuals || []).length } };
  });

  /* ---------- N3 删除守卫：新造测试容器 → 点删除 → confirm 应弹出且被拒 ---------- */
  R.N3 = await page.evaluate(async () => {
    // 兜底解除 confirm 假 deaf（本脚本需要感知 confirm 被调用）
    window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls++; return false; };
    // 造一个测试容器（纯本地 state 层造，不经过飞书 upsert —— 走资源档案「新增」会推飞书；这里改用 UI 的删除守卫对既有测试行验证：先造一个新行经正常入口，保证与生产行为一致）
    const before = state.containers.length;
    // 直接用新增入口：切到容器 tab
    const ctnBtn = [...document.querySelectorAll('.res-type')].find(b => /容器/.test(b.textContent));
    if (ctnBtn) ctnBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const editor = document.querySelector('#resEditorBox');
    const newBtn = editor ? [...editor.querySelectorAll('button')].find(b => /新增|新建/.test(b.textContent)) : null;
    let created = false;
    if (newBtn) { newBtn.click(); await new Promise(r => setTimeout(r, 300)); }
    const inputs = editor ? [...editor.querySelectorAll('input')].filter(i => !i.readOnly) : [];
    if (inputs.length) { inputs[0].value = 'ZZX-TEST16'; }
    const saveBtn = editor ? [...editor.querySelectorAll('button')].find(b => /保存/.test(b.textContent)) : null;
    if (saveBtn) { saveBtn.click(); await new Promise(r => setTimeout(r, 2500)); created = true; }
    const afterCreate = state.containers.length;
    // 现在对测试行点删除（守卫应弹 confirm；confirm=false → 不删）
    const row = state.containers.find(c => c.code === 'ZZX-TEST16');
    let guard = { confirmCalls: window.__confirmCalls, stillThere: !!row, rows: state.containers.length };
    if (row) {
      // 在表格里找到该行的删除按钮
      const tds = [...document.querySelectorAll('#resTable tbody tr')].find(tr => tr.textContent.includes('ZZX-TEST16'));
      const delBtn = tds ? [...tds.querySelectorAll('button')].find(b => /删/.test(b.textContent)) : null;
      if (delBtn) { delBtn.click(); await new Promise(r => setTimeout(r, 800)); }
      guard.confirmCalls = window.__confirmCalls;
      guard.stillThere = !!state.containers.find(c => c.code === 'ZZX-TEST16');
      guard.delBtnFound = !!delBtn;
    }
    return { created, before, afterCreate, guard };
  });

  /* ---------- L5 schema 校验入口 ---------- */
  R.L5 = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /schema|结构|校验|一致性|核对/.test(t));
    return { candidates: btns.slice(0, 8) };
  });
  if (R.L5.candidates.length) {
    // 一致性核对通常在同步页
    const clicked = await page.evaluate(async () => {
      goTab('sync');
      await new Promise(r => setTimeout(r, 500));
      const btn = [...document.querySelectorAll('button')].find(b => /核对|一致性/.test(b.textContent));
      if (!btn) return { found: false };
      btn.click();
      return { found: true, label: btn.textContent.trim() };
    });
    await page.waitForTimeout(8000);
    R.L5.clicked = clicked;
    R.L5.report = await page.evaluate(() => {
      const t = document.body.textContent;
      const m = t.match(/[^\n]*(一致|差异|consistent|8\s*表)[^\n]*/g);
      return (m || []).slice(0, 5);
    });
  }

  /* ---------- H1-H4 标签打印 ---------- */
  await page.evaluate(() => goTab('label'));
  await page.waitForTimeout(600);
  R.H1 = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('#tab-label .res-type, #tab-label [role="tab"], #labelTypebar .res-type, #labelTypebar button')].map(b => b.textContent.trim());
    return { typeButtons: chips.slice(0, 12), pageHasLabel: !!document.querySelector('#tab-label .label, #tab-label .labelcard, #printArea .label') };
  });
  // 逐类勾选预览
  R.H1.perType = await page.evaluate(async () => {
    const out = [];
    const types = [...document.querySelectorAll('#tab-label .res-type, #labelTypebar button')];
    for (const b of types.slice(0, 10)) {
      b.click(); await new Promise(r => setTimeout(r, 500));
      const label = document.querySelector('#tab-label .label');
      const zone = document.querySelector('#tab-label .zonecard');
      const cs = label ? getComputedStyle(label) : null;
      out.push({ type: b.textContent.trim(), hasLabel: !!label, hasZonecard: !!zone, w: cs ? cs.width : null, h: cs ? cs.height : null, mmW: cs ? cs.getPropertyValue('width') : null });
    }
    return out;
  });
  // H4: print 调用计数 + page.pdf
  await page.evaluate(() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; });
  const printBtn = await page.$('#tab-label button.btn--print, #tab-label button');
  R.H4 = { printBtnFound: !!printBtn };
  if (printBtn) {
    const label = printBtn.textContent.trim();
    if (/打印/.test(label)) { try { await printBtn.click({ timeout: 5000 }); } catch (e) { /* 打印可能走 iframe */ } }
    R.H4.btnLabel = label;
    R.H4.printCalls = await page.evaluate(() => window.__printCalls);
  }
  await page.pdf({ path: OUT + '/label-page.pdf', format: 'A4', printBackground: true }).then(() => { R.H4.pdfGenerated = true; }).catch(e => { R.H4.pdfGenerated = false; R.H4.pdfErr = e.message; });

  /* ---------- K3 NEC 标签（先建一条测试任务） ---------- */
  R.K3 = await page.evaluate(async () => {
    goTab('nec');
    await new Promise(r => setTimeout(r, 500));
    const sel = document.getElementById('necOwner');
    const owner = sel && sel.options.length ? sel.options[1] ? sel.options[1].value || sel.options[1].textContent : sel.options[0].textContent : '';
    const setv = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
    setv('necTitle', 'TASK16-K3-测试任务');
    setv('necMaterials', '');
    if (sel && sel.options.length > 1) { sel.value = sel.options[1].value || sel.options[1].textContent; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    const btn = document.getElementById('btnNecCreate');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 1500));
    const created = (state.necOrders || []).find(o => /TASK16-K3/.test(o.title || ''));
    return { created: !!created, code: created && created.code, owner: created && created.owner, status: created && created.status };
  });

  /* ---------- M3 JSON 备份导出（下载捕获） ---------- */
  const [dl1] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
    page.evaluate(() => { goTab('data'); const b = document.getElementById('btnBackupJson'); if (b) b.click(); }),
  ]);
  if (dl1) { await dl1.saveAs(OUT + '/backup.json'); R.M3 = { ok: true, file: dl1.suggestedFilename() }; }
  else R.M3 = { ok: false, note: '未捕获下载（可能按钮不在 data 页）' };

  /* ---------- M2 Excel 导出 → 原样导入往返 ---------- */
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 25000 }).catch(() => null),
    page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /导出.*Excel|Excel.*导出|导出台账/.test(x.textContent));
      if (b) b.click();
      return b ? b.textContent.trim() : null;
    }),
  ]);
  if (dl2) {
    await dl2.saveAs(OUT + '/export.xlsx');
    R.M2 = { exported: true, file: dl2.suggestedFilename() };
    // 原样导入
    await page.setInputFiles('#fileImport', OUT + '/export.xlsx');
    await page.waitForTimeout(9000);
    R.M2.importReport = await page.evaluate(() => {
      const t = document.body.textContent;
      const m = t.match(/[^\n]*(导入|差异|还原|恢复)[^\n]{0,80}/g);
      return (m || []).slice(-6);
    });
  } else R.M2 = { exported: false, note: '未找到导出按钮或未捕获下载' };

  R.jsErrors = jsErrors;
  fs.writeFileSync(OUT + '/read-only-results.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1).slice(0, 3000));
  await browser.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
