'use strict';
const Operation = require('./item-operation');
const Repository = require('./item-repository');
/** Explicit composition root. The deployment supplies reviewed authentication and durable
 * coordinator implementations; an environment flag alone never constructs either capability.
 */
function createRuntime({ api, authenticate, coordinator, enabled = false } = {}) {
  const feishu = api || require('./feishu-api');
  return Operation.create({ repository: Repository.create(feishu), authenticate,
    coordinator, enabled: enabled === true });
}
module.exports = { createRuntime };
