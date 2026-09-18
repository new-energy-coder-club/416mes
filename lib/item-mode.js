'use strict';
// 用户明确授权的首版试运行；服务端环境变量可立即关闭。
// 不提供身份安全或跨实例原子事务，仅供单操作员串行现场验证。
function currentMode(env = process.env) {
  if (env.ITM_OPERATION_MODE === 'disabled') return 'disabled';
  if (env.ITM_OPERATION_MODE === 'strict') return 'strict';
  return 'feishu-trial';
}
module.exports = { currentMode };
