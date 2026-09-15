#!/usr/bin/env node
/**
 * check-inline-js.mjs — 检查 index.html 内联 <script> 的语法
 *
 * 为什么需要它：`node --check` 只能检查独立 .js/.mjs 文件，而 index.html 里的
 * 应用逻辑是内联脚本。曾出现「内联脚本重复声明变量 → 整页白屏」却没被 npm run check
 * 发现的情况，因此把内联脚本也纳入语法检查。
 *
 * 用法：node scripts/check-inline-js.mjs [file...]     默认检查 index.html
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['index.html', 'home.html', 'join.html'];

let checked = 0, failed = 0;
for (const rel of files) {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.log(`  – ${rel}（不存在，跳过）`); continue; }
  const html = fs.readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!blocks.length) { console.log(`  – ${rel}（无内联脚本）`); continue; }
  blocks.forEach((m, i) => {
    const code = m[1];
    if (!code.trim()) return;
    const lineOffset = html.slice(0, m.index).split('\n').length;   // 便于把报错定位回 html 行号
    try {
      // 只做语法解析，不执行
      new vm.Script(code, { filename: `${rel}#inline-${i + 1}` });
      checked++;
      console.log(`  ✅ ${rel} 内联脚本 #${i + 1}（${code.split('\n').length} 行，起始 html 第 ${lineOffset} 行）`);
    } catch (e) {
      failed++;
      const m2 = /#inline-\d+:(\d+)/.exec(e.stack || '');
      const inner = m2 ? Number(m2[1]) : null;
      console.error(`  ❌ ${rel} 内联脚本 #${i + 1} 语法错误：${e.message}` +
        (inner ? `　→ 约 index.html 第 ${lineOffset + inner} 行` : ''));
    }
  });
}

console.log(`\n内联脚本语法检查：${checked} 个通过，${failed} 个失败`);
process.exit(failed ? 1 : 0);
