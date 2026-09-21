'use strict';
const Operation = require('./item-operation');
const Repository = require('./item-repository');
/** Explicit composition root. The deployment supplies reviewed authentication and durable
 * coordinator implementations; an environment flag alone never constructs either capability.
 */
function createRuntime({ api, authenticate, coordinator, enabled = false, mode = 'strict' } = {}) {
  const feishu = api || require('./feishu-api');
  const repository = Repository.create(feishu);
  /* 2.81.0 C1：埋点存储由组合根注入（item-operation 不自行 require feishu-api，避免加载顺序耦合） */
  if (mode === 'feishu-trial') return Operation.create({ repository, coordinator: require('./item-trial-coordinator').create(repository), enabled: true, mode, feishuMetrics: feishu.feishuMetrics });
  return Operation.create({ repository, authenticate, coordinator, enabled: enabled === true, mode, feishuMetrics: feishu.feishuMetrics });
}
module.exports = { createRuntime };
