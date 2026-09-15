#!/usr/bin/env node
/**
 * feishu-import.mjs — 飞书表「A416零件位置明细」→ 416MES 台账 Excel（供审阅后导入）
 *
 * 用法：
 *   node feishu-import.mjs                # 拉取并生成 416MES_导入_A416零件_YYYYMMDD.xlsx
 *   node feishu-import.mjs --dry-run      # 只在控制台打印映射结果，不写文件
 *
 * 映射规则：
 *   区域父记录（位置=N / N焊接区）→ 库位码 YH-NN（玉衡A416 内部细位置，kind=区域）
 *   物品子记录：名称→名称，数量→库存数量，父记录→当前库位码，图片文件名→图片链接
 *   分类：按名称关键词自动猜测（JG/DJ/DZ/GZ/TS/GJ/HC/QT），物料码 = 分类-3位流水
 */
import { execFileSync } from 'node:child_process';
import XLSX from 'xlsx';

// 源表：优先读环境变量（避免把标识写死在源码里），未配置时回退到「A416零件位置明细」
const BASE_TOKEN = process.env.FEISHU_A416_BASE_TOKEN || 'E5pEbt6fJalkUvstfmJc23kongd';
const TABLE_ID = process.env.FEISHU_A416_TABLE_ID || 'tbl4ASLFeTdssZIF';

/* ---------- 分类关键词（顺序即优先级） ---------- */
const CAT_RULES = [
  ['TS', ['示波器', '万用表', '调试器', '烧录器', '下载器', '逻辑分析仪', '稳压电源', '可调电源', '显微镜', '检测仪', '功率计', '仿真器', '测试仪']],
  ['GZ', ['雷达', '相机', '镜头', '图传', 'Jetson', '树莓派', '妙算', '整机', '云台', '机器狗']],
  ['DJ', ['电机', '马达', '舵机', '电调', '驱动板', '减速电机', 'M3508', 'GM6020', 'M2006', '520']],
  ['GJ', ['烙铁', '热风枪', '压线钳', '钳', '镊', '螺丝刀', '扳手', '剪刀', '胶枪', '吸锡', '焊台', '美工刀', '卷尺', '卡尺', '喷漆', '画笔', '喷笔', '气泵', '冲击钻', '木工钻', '套筒', '批头', '直尺', '打磨机']],
  ['JG', ['型材', '齿轮', '支架', '轴承', '螺栓', '螺丝', '螺母', '法兰', '联轴器', '同步带', '同步轮', '碳板', '玻纤', '打印件', '铝管', '铝板', '垫片', '弹簧', '轴', '滑台', '模组', '减速箱', '万向轮', '铜柱', '螺柱', '压痕轮', '防撞条']],
  ['DZ', ['主控', '开发板', '传感器', '电池', '充电', '芯片', '屏幕', '彩屏', 'TFT', '模块', '电容', '电阻', '二极管', '电位器', 'LED', '按键', '开关', '继电器', '排线', '杜邦线', '线材', '硅胶线', '端子线', '鳄鱼夹', '跳线', '灯带', '补光灯', '控制器', '读写器', '单片机', 'ESP', 'STM32', 'SIM900', '变频器', '转换器', '分线器', '遥控器', '风扇', '板']],
  ['HC', ['焊锡', '锡丝', '锡膏', '扎带', '热缩管', '打印纸', '润滑', '酒精', '胶带', '胶水', '擦拭', '清洗剂', '清洗液', '抛光液', '生料带', '锁固剂', '颜料', '硅胶', '耗材', '墨水', '手套', '口罩', '面具', '呼吸器']]
];
function guessCat(name) {
  for (const [cat, kws] of CAT_RULES) if (kws.some(k => name.includes(k))) return cat;
  return 'QT';
}

/* ---------- 拉取飞书记录 ---------- */
function lark(args) {
  const out = execFileSync('lark-cli', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' });
  return JSON.parse(out);
}
function larkRaw(args) {
  return execFileSync('lark-cli', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' });
}
function fetchAll() {
  const rows = [];
  let offset = 0;
  for (; ;) {
    const res = lark(['base', '+record-list', '--base-token', BASE_TOKEN, '--table-id', TABLE_ID,
      '--limit', '200', '--offset', String(offset), '--format', 'json', '--jq', '.data']);
    const page = res.data || [];
    rows.push(...page);
    if (page.length < 200) break;
    offset += 200;
  }
  return rows;
}

/* ---------- 主流程 ---------- */
const dryRun = process.argv.includes('--dry-run');
const rows = fetchAll();   // 列序：位置|名称|链接|数量|物品描述|图片|父记录
console.log(`拉取 ${rows.length} 条记录`);

// 区域父记录：位置有值且名称为空
const zoneByPos = {};    // 位置值 → 库位码
const zones = rows.filter(r => r[0] && !r[1]);
const locRows = [];
zones.forEach(z => {
  const raw = String(z[0]).trim();
  const m = raw.match(/^(\d+)(.*)$/);
  const num = m ? m[1].padStart(2, '0') : raw;
  const alias = m && m[2] ? m[2].trim() : '';
  const code = 'YH-' + num;
  zoneByPos[raw] = code;
  locRows.push([code, '区域', '玉衡A416 · 原位置' + raw]);
});
console.log(`区域 ${zones.length} 个：${Object.values(zoneByPos).join(' ')}`);

// json 视图不含 record_id，用 markdown 视图建立 record_id → 位置 映射（父记录链路）
const md = larkRaw(['base', '+record-list', '--base-token', BASE_TOKEN, '--table-id', TABLE_ID, '--limit', '200', '--format', 'markdown']);
// 从 markdown 表解析 record_id → 位置（区域行）
const id2pos = {};
String(md).split('\n').forEach(line => {
  const cells = line.split('|').map(s => s.trim());
  if (cells.length > 7 && /^rec/.test(cells[1] || '')) {
    const [, rid, pos, name] = cells;
    if (pos && !name) id2pos[rid] = pos;
  }
});

const items = rows.filter(r => r[1]);
const serial = {};
const matRows = [];
const unmatched = [];
items.forEach(r => {
  const name = String(r[1]).trim();
  const qty = parseFloat(r[3]) || 0;
  const parentId = Array.isArray(r[6]) && r[6][0] ? r[6][0].id : '';
  const pos = id2pos[parentId];
  const loc = pos ? zoneByPos[pos] : '';
  if (!loc) unmatched.push(name);
  const cat = guessCat(name);
  serial[cat] = (serial[cat] || 0) + 1;
  const code = cat + '-' + String(serial[cat]).padStart(3, '0');
  const img = Array.isArray(r[5]) && r[5][0] ? (r[5][0].name || '') : '';
  matRows.push([code, cat, name, '', '', loc, '', qty, 0, 0, img]);
});
console.log(`物品 ${items.length} 条 → 分类分布：` +
  Object.entries(serial).map(([c, n]) => `${c}:${n}`).join(' '));
if (unmatched.length) console.log(`⚠️ ${unmatched.length} 条未能映射库位（父记录不在区域表）：${unmatched.slice(0, 5).join('、')}…`);

if (dryRun) {
  console.log('\n[dry-run] 前 10 行预览：');
  matRows.slice(0, 10).forEach(r => console.log(' ', r.join(' | ')));
  console.log('\n[dry-run] 库位 sheet：');
  locRows.forEach(r => console.log(' ', r.join(' | ')));
  process.exit(0);
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['物料码', '分类', '名称', '规格型号', '闲鱼XY编号', '当前库位码', '容器码', '库存数量', '安全库存', '成本', '图片链接'],
  ...matRows]), '物料台账');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['库位码', '类型', '说明'], ...locRows]), '库位');
const d = new Date();
const fname = `416MES_导入_A416零件_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.xlsx`;
XLSX.writeFile(wb, fname);
console.log(`\n✅ 已生成 ${fname}（${matRows.length} 物料 + ${locRows.length} 库位）`);
console.log('下一步：打开 index.html → 物料台账 → 先「导出 Excel 台账」备份 → 用 Excel 打开本文件审阅分类/库位 → 「导入 Excel 台账」');
console.log('⚠️ 导入为整表替换：如需保留现有物料，请先把导出台账的物料行合并进本文件再导入');
