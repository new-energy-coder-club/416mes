#!/usr/bin/env python3
"""Patch: Phase B-refactor 同步页分区标题 + 总览条 + 冲突横幅自解释"""
import sys

p = 'index.html'
lines = open(p, encoding='utf-8').read().split('\n')
changed = []

def section(title, desc):
    return ("    html += '<div class=\"sync-section\"><div class=\"sync-section__t\">" + title +
            "</div><div class=\"sync-section__d\">" + desc + "</div></div>';\n")

# 在各分区首行前插入标题卡（从后往前插避免行号位移）
marks = []
for i, l in enumerate(lines):
    if "html += '<div class=\"local-dup-box mt-6\">🚨" in l:
        marks.append((i, '① 重复工单（本地同号多行）',
                      '成因：历史导入/测试期重复建单。飞书按工单号只保留一行，本地多行永远对不上。处理：点「保留第一行，删除其余」一键收敛（有凭据可撤销）。'))
    elif "html += '⚠️ <b>飞书表结构要补齐" in l:
        marks.append((i, '② 飞书表结构要补齐', '单选列缺选项、缺列——补齐后这些内容才能同步上去。点每条右侧按钮可一键在飞书补选项（只新增不改删）。'))
    elif "html += '☁️ <b>本地有 '" in l and 'pendingCount' in l:
        marks.append((i, '③ 待推送（本地新建）', '本地新建、还没推上飞书的记录。点「立即同步」会自动补推。'))
    elif "html += '🔒 <b>' + blocked.length" in l:
        marks.append((i, '④ 推送受阻', '飞书侧拒绝了某些字段（如缺单选选项），本地值已保留不被覆盖。先处理②的表结构，再「立即同步」。'))
    elif "html += '🗑️ <b>有 '" in l and 'pendDelCount' in l:
        marks.append((i, '⑤ 待人工确认删除', '飞书里找不到的记录（多为你测试期删的）。确认是垃圾后点「立即核对删除」即可清掉本地副本。'))

# 倒序插入
for i, title, desc in sorted(marks, key=lambda x: -x[0]):
    lines[i:i] = section(title, desc).split('\n')
    changed.append(title[:12])

# 总览条：插在函数开头的一致性表标题之前——找 renderAlignBox 内第一处 html 拼接前
# 直接用 CSS+标题实现：在 cloudGapBox 输出开头加总览
overview_anchor = "  const rows = SYNC_TABLES.filter(k => rep.tables[k]).map(k => {"
if overview_anchor in s:
    ins = overview_anchor.replace("  const rows =",
        "  /* 2.62.0 重构：总览条——先给结论，再看明细 */\n" +
        "  const okTables = SYNC_TABLES.filter(k => rep.tables[k] && rep.tables[k].diff === 0).length;\n" +
        "  const badTables = SYNC_TABLES.filter(k => rep.tables[k] && rep.tables[k].diff !== 0).length;\n" +
        "  html += '<div class=\"sync-overview\">' +\n" +
        "    '<span class=\"so-item ok\">✓ 一致 ' + okTables + ' 表</span>' +\n" +
        "    (badTables ? '<span class=\"so-item bad\">⚠ ' + badTables + ' 表不一致</span>' : '') +\n" +
        "    '<span class=\"so-item\">本地 ' + (state.transactions || []).length + ' 条流水</span></div>';\n" +
        "  const rows =")
    s = s.replace(overview_anchor, ins, 1)
    changed.append('overview')

open(p, 'w', encoding='utf-8').write(s)
print('changed:', changed)
