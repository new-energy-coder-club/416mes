'use strict';
const Operation = require('./item-operation');
const Repository = require('./item-repository');
/** Explicit composition root. The deployment supplies reviewed authentication and durable
 * coordinator implementations; an environment flag alone never constructs either capability.
 */
function createRuntime({ api, authenticate, coordinator, enabled = false, mode = 'strict' } = {}) {
  const feishu = api || require('./feishu-api');
  const repository = Repository.create(feishu);
  if (mode === 'feishu-trial') return Operation.create({ repository, coordinator: require('./item-trial-coordinator').create(repository), enabled: true, mode });
  return Operation.create({ repository, authenticate, coordinator, enabled: enabled === true, mode });
}
module.exports = { createRuntime };
