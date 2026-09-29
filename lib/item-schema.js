'use strict';
// Versioned, read-only contract. This module never creates tables or alters permissions.
const CONTRACT_VERSION = 1;
const REQUIREMENTS = {
  items: {
    '物品码': [1], '容器码': [1], '状态': [3, ['unknown', 'pending', 'in_stock', 'out', 'retired']],
    /* P2：物品子位化走既有「库位码」列（存量列，零结构变更）——
       容器存放与直存子位互斥（在库 XOR），复用该列即可表达。 */
    '库位码': [1],
    '业务版本': [2], '最后操作ID': [1], '最后更新时间': [1002]
  },
  containers: {
    /* A-1：容器不再强制携带库位（可放地面/未上架），「当前库位码」降为 OPTIONAL——
       缺列/缺值只进 warnings 不阻断；bitable 列保留，仅校验层放宽。 */
    '容器码': [1], '当前库位码': [1, null, true], '状态': [3, ['active', 'disabled']],
    '业务版本': [2], '最后操作ID': [1], '最后更新时间': [1002]
  },
  /* P2：库位角色 / 所属容器码 是「容器子位」功能的可选增强列。
     线上 bitable 尚未建这两列（真实部署现状），而 validate() 是 fail-closed 的 ——
     列缺失会让**所有**受控实体命令（含建档/入库/出库）一起被 ITM_SCHEMA_INVALID 挡死，
     用户完全无法作业。因此这两列降级为 OPTIONAL：有则校验，缺列只进 warnings 不阻断。
     等线上建了列自动生效，无需再改代码。 */
  locations: {
    '库位码': [1], '状态': [3, ['active', 'disabled']],
    '库位角色': [3, ['自由位', '容器子位'], true], '所属容器码': [1, null, true], '最后更新时间': [1002]
  },
  itemOperations: {
    '操作ID': [1], '操作类型': [[1, 3], ['receive', 'issue', 'transfer', 'placeContainer', 'moveContainer', 'verifyLegacy', 'retire', 'activateLocation', 'activateContainer', 'registerItem', 'registerLocation', 'registerContainer', 'receiveBatch', 'issueBatch']],
    '物品码': [1], '容器码': [1], '请求内容': [1], '请求摘要': [1],
    '操作前快照': [1], '目标快照': [1], '处理阶段': [3, ['PREPARED', 'APPLIED', 'REJECTED', 'REPAIR_REQUIRED']],
    '执行进度': [1], '操作人': [1], '设备': [1], '受理时间': [5], '完成时间': [5],
    '错误与恢复说明': [1], '最后更新时间': [1002]
  }
};
/**
 * @param {object} schemas  { table: [{name,type,options}] }
 * @param {object} tables   { table: tableId }
 * 字段声明写成 [type, options, optional]；第三位 true = 可选列：
 * 缺列/类型不符只进 warnings，不进 problems，不阻断写入。
 * 背景：P2「容器子位」的两列线上 bitable 尚未建，fail-closed 会让所有作业一起死。
 */
function validate(schemas, tables) {
  const problems = [], warnings = [];
  for (const [table, fields] of Object.entries(REQUIREMENTS)) {
    if (!tables || !tables[table]) { problems.push({ table, reason: 'missing-table' }); continue; }
    for (const [name, spec] of Object.entries(fields)) {
      const arr = Array.isArray(spec) ? spec : [spec];
      const type = arr[0], options = arr[1], optional = arr[2] === true;
      const sink = optional ? warnings : problems;
      const found = (schemas[table] || []).filter(f => f.name === name);
      if (found.length !== 1) { sink.push({ table, name, reason: found.length ? 'duplicate-column' : 'missing-column', optional }); continue; }
      const f = found[0];
      if (!(Array.isArray(type) ? type : [type]).includes(f.type)) { sink.push({ table, name, reason: 'wrong-type', actual: f.type, optional }); continue; }
      if (f.type === 3 && options) {
        const missing = options.filter(v => !(f.options || []).includes(v));
        if (missing.length) sink.push({ table, name, reason: 'missing-options', missing, optional });
      }
    }
  }
  return { schemaVersion: CONTRACT_VERSION, schemaValid: problems.length === 0, problems, warnings,
    // Schema alone cannot prove field ACLs, authentication or shared coordination.
    writeEnabled: false, externalGates: ['field-permissions', 'shared-coordination', 'authenticated-operator'] };
}
async function inspect(api) {
  const token = await api.tenantToken();
  const schemas = {};
  for (const table of Object.keys(REQUIREMENTS)) {
    if (!api.TABLES[table]) continue;
    /* 2.69.0 M2：listFieldsCached（5 分钟进程内缓存）——schema 校验在命令高频时
       不再每次都打 4 张表的 listFields。结构变更后最多延迟 5 分钟感知（可重启生效）。 */
    schemas[table] = api.listFieldsCached
      ? await api.listFieldsCached(token, api.TABLES[table])
      : await api.listFields(token, api.TABLES[table]);
  }
  return validate(schemas, api.TABLES);
}
function isControlledSchema(table, defs) {
  if (!REQUIREMENTS[table]) return false;
  // Any marker opts the table into protection; a partially migrated table must not reopen old writes.
  return defs.some(f => ['状态', '业务版本', '最后操作ID'].includes(f.name));
}
module.exports = { CONTRACT_VERSION, REQUIREMENTS, validate, inspect, isControlledSchema };
