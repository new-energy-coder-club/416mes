'use strict';
// Versioned, read-only contract. This module never creates tables or alters permissions.
const CONTRACT_VERSION = 1;
const REQUIREMENTS = {
  items: {
    '物品码': [1], '容器码': [1], '状态': [3, ['unknown', 'pending', 'in_stock', 'out', 'retired']],
    '业务版本': [2], '最后操作ID': [1], '最后更新时间': [1002]
  },
  containers: {
    '容器码': [1], '当前库位码': [1], '状态': [3, ['active', 'disabled']],
    '业务版本': [2], '最后操作ID': [1], '最后更新时间': [1002]
  },
  locations: { '库位码': [1], '状态': [3, ['active', 'disabled']], '最后更新时间': [1002] },
  itemOperations: {
    '操作ID': [1], '操作类型': [[1, 3], ['receive', 'issue', 'transfer', 'placeContainer', 'moveContainer', 'verifyLegacy', 'retire', 'activateLocation', 'activateContainer']],
    '物品码': [1], '容器码': [1], '请求内容': [1], '请求摘要': [1],
    '操作前快照': [1], '目标快照': [1], '处理阶段': [3, ['PREPARED', 'APPLIED', 'REJECTED', 'REPAIR_REQUIRED']],
    '执行进度': [1], '操作人': [1], '设备': [1], '受理时间': [5], '完成时间': [5],
    '错误与恢复说明': [1], '最后更新时间': [1002]
  }
};
function validate(schemas, tables) {
  const problems = [];
  for (const [table, fields] of Object.entries(REQUIREMENTS)) {
    if (!tables || !tables[table]) problems.push({ table, reason: 'missing-table' });
    for (const [name, [type, options]] of Object.entries(fields)) {
      const found = (schemas[table] || []).filter(f => f.name === name);
      if (found.length !== 1) { problems.push({ table, name, reason: found.length ? 'duplicate-column' : 'missing-column' }); continue; }
      const f = found[0];
      if (!(Array.isArray(type) ? type : [type]).includes(f.type)) problems.push({ table, name, reason: 'wrong-type', actual: f.type });
      if (f.type === 3 && options) {
        const missing = options.filter(v => !(f.options || []).includes(v));
        if (missing.length) problems.push({ table, name, reason: 'missing-options', missing });
      }
    }
  }
  return { schemaVersion: CONTRACT_VERSION, schemaValid: problems.length === 0, problems,
    // Schema alone cannot prove field ACLs, authentication or shared coordination.
    writeEnabled: false, externalGates: ['field-permissions', 'shared-coordination', 'authenticated-operator'] };
}
async function inspect(api) {
  const token = await api.tenantToken();
  const schemas = {};
  for (const table of Object.keys(REQUIREMENTS)) {
    if (!api.TABLES[table]) continue;
    schemas[table] = await api.listFields(token, api.TABLES[table]);
  }
  return validate(schemas, api.TABLES);
}
function isControlledSchema(table, defs) {
  if (!REQUIREMENTS[table]) return false;
  // Any marker opts the table into protection; a partially migrated table must not reopen old writes.
  return defs.some(f => ['状态', '业务版本', '最后操作ID'].includes(f.name));
}
module.exports = { CONTRACT_VERSION, REQUIREMENTS, validate, inspect, isControlledSchema };
