# ITM 运行与协调契约

## 当前默认：首版试运行

用户明确要求先跑通现场验证，暂不接身份认证和持久共享协调。生产handler默认`feishu-trial`；`ITM_OPERATION_MODE=disabled`停写，`strict`恢复严格门禁。`createRuntime()`本身仍默认strict，测试和其他调用不隐式放开。

飞书试运行是best-effort，不是跨实例事务。仅一名操作员、同一时间一条在途命令，等待结果后再继续；未知结果只查原opId，不新建命令重发。无认证意味着知道接口地址的人可提交管理操作，不能把姓名视为验证身份；禁止直接编辑飞书受控列。页面常驻提示此边界。

保留schema检查、opId/载荷查重、PREPARED意图、写前二次核对、实体单次写/回读及异常REPAIR_REQUIRED；不能保证同时穿透检查的多实例互斥。空状态保持unknown，通过首次核实操作启用，不批量猜测在库。缺字段返回明确503；飞书操作表ID已只读核实为tblWyVuqDDBnU05t。

## 严格模式（未来多人正式使用）

`api/feishu/item-operation.js`通过`lib/item-runtime.js:createRuntime`组合真实飞书仓储与操作协议。strict模式无认证/协调时HTTP401/503拒绝，不发飞书写。

部署可接入 `createRuntime({api,authenticate,coordinator,enabled:true})` 后交 `handlerFor(service)`。api默认是现有feishu-api；仓储实现完整schema检查、PREPARED建行、按record_id改关系并显式清空、实体回读、日志终态回读。部署工厂不是测试fake仓储。

## 部署接线示例（需外部适配验收，默认文件不自动启用）

```js
// 在部署专用入口中组合，禁止把测试fixture复制成生产适配器。
const { createRuntime } = require('../../lib/item-runtime');
const { handlerFor } = require('./item-operation');
// 由部署方实现并通过持久性/跨实例/未知迟到验收：
const { authenticate, coordinator } = require('../../deployment/verified-item-adapters');
module.exports = handlerFor(createRuntime({ authenticate, coordinator, enabled: true }));
```

上例deployment模块当前不存在，不能直接复制后声称可上线；它是明确外部接入点。真实Repository已实现，不需替换业务协议；隔离测试通过相同工厂注入fake API地址与适配器。注册命令复用同一认领/日志/恢复协议，不走通用upsert。

## 认证

authenticate(req)须验证服务端会话/签名，返回{id,roles}；不能相信请求operator或客户端姓名。operator可创建与查看本人操作；admin/service可查看跨用户操作；恢复只允许service。没有roles一律403。GET无恢复写副作用。真实身份提供者尚未配置，为外部门禁。

## 持久协调适配器

必须提供contract=`durable-global-barrier-v1`、verified=true，并真实满足下列方法的持久、跨实例原子语义；字符串标记不是验收证明：

- claim({opId,requestHash,request,operator})：原子保存不可变命令和全局认领。已有同键异摘要返回conflict；已有同键返回existing；其他未决命令返回未取得。首版全局串行，包括容器操作。
- get(opId)：持久命令/operation/result读取。
- prepare(opId,operation)：飞书首次写前持久保存冻结计划。函数此后崩溃同样维持屏障。
- progress、uncertain：记录进度及未知原因，绝不释放认领。TTL不得解冻。
- finish(opId,result)：原子保存最终结果并释放认领；仅明确无副作用REJECTED或经过回读的APPLIED。
- claimRecovery(opId)：原子恢复认领，只能恢复当前屏障持有者，不允许恢复者并发。

`test/fixtures/item-protocol.js` 是内存模拟，只证明执行协议测试，生产不导入、不宣称持久。真实KV/队列/事务设施尚未选型验证，正式写保持关闭。

## 恢复与限制

日志创建超时/实体写超时/终态写超时都保持屏障。readAfter为before不证明请求不会迟到，恢复不重发apply；只有after一致且唯一日志摘要吻合，服务恢复可修复终态。日志重复或截断立即隔离。仓储每次调用tenantToken，依赖API已有过期缓存，不私建永久缓存。

前端fetch 15秒超时，AbortController不等于撤销远端业务，命令标未知且保留原opId；未知只提供查询。ACK本机落盘失败不能显示完成，未知标记也失败则合并报告并保留原命令。

当前环境模板仅为占位说明：

```
FEISHU_APP_ID=<isolated-app-id>
FEISHU_APP_SECRET=<isolated-secret>
FEISHU_BASE_TOKEN=<isolated-base-token>
FEISHU_TABLES=<nine-table-json-with-itemOperations>
```

不读取/复制真实环境。新表由用户创建不等于schema、ACL或生产协调已验证。不要把旧网页回滚当作恢复关键字段普通写权限。

## 2.64.0 部署边界与可选项（Phase D）
- 实体级分桶：trial 协调器对 PREPARED 行按实体键集相交互斥（unique-items.entityKeysOf），
  不同物品/容器可并行；REPAIR_REQUIRED 仍全局屏障；写前 TRIAL_PRECONDITION_CHANGED 重计划不变。
- 最小身份（可选）：Vercel 环境变量 ITM_OPERATOR_TOKENS = JSON（token→{id,roles}）。
  配置后 POST 必须带 X-416MES-Token，操作人记真实 id，register*/retire/activate* 的
  admin 校验激活；未配置则保持 trial-unverified（现状兼容）。
  前端在浏览器控制台执行 localStorage.setItem('mes416_itm_token','<token>') 一次性录入。
- 边界：共享 token 防误不防恶意；正式多用户走飞书 OAuth+持久协调器（长期方案）。
