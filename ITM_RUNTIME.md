# 416MES ITM 运行时与恢复契约

> 当前基线：v3.13.42 / 2026-10-08
> 本文说明当前真实运行模式、持久化、同步、身份与失败恢复边界。

## 1. 推荐运行方式

开发/现场调试优先通过 HTTP 启动：

```bash
npm ci
npm run dev
# 或
npm run serve:static
```

早期“直接双击 index.html 就是完整产品”的说法已不再准确。当前应用的正常能力涉及：

- IndexedDB；
- Web Lock / 单写者约束；
- Vercel / 本地 API；
- 飞书同步；
- item / container 短链；
- 相机与 worker；
- 受控 item-operation。

纯静态环境仍可降级查看/操作部分本机能力，但不代表完整在线闭环。

## 2. 本地持久化

### LocalStorage

主要承担：

- 应用状态快照；
- UI 偏好；
- deviceId / operator 等轻量状态；
- 部分启动与备份标记。

### IndexedDB

当前 ITM 可靠性主路径之一，保存：

- records / transactions 等持久状态；
- syncMeta；
- 草稿；
- outbox / itemOperation 命令；
- baseline / conflict / deletion journal 等仓库。

### 单写者

`item-persistence.js` 配合 Web Lock 控制一个浏览器生命周期中的写者，降低多标签页同时写本地状态的竞态。

## 3. item-operation 执行模型

客户端提交一个稳定 opId 的 request。

服务端大体流程：

```text
认证/模式检查
  -> 读取当前真源
  -> plan（before / after）
  -> PREPARED 日志
  -> apply
  -> readAfter
  -> APPLIED / REJECTED / REPAIR_REQUIRED
  -> 客户端 acknowledge
```

原则：

- requestHash 防止同 opId 被换载荷；
- expected version 防止陈旧镜像覆盖新状态；
- apply 后必须回读；
- 结果未知时保留命令；
- 重试优先查询原 opId；
- 不因网络超时就默认“没写进去”。

## 4. 当前运行模式

`lib/item-mode.js` 当前支持：

- `disabled`
- `strict`
- `feishu-trial`

若没有设置 `ITM_OPERATION_MODE`，默认是 **feishu-trial**。

这仍是“单操作员/小规模现场试运行”语义，不是正式多用户事务系统。

## 5. 身份与授权

### ITM_OPERATOR_TOKENS

`api/feishu/item-operation.js` 支持：

```text
ITM_OPERATOR_TOKENS = {
  "<token>": { "id": "...", "roles": ["operator"] }
}
```

配置后，请求需要携带 `X-416MES-Token`。

未配置时，为兼容试运行：

```text
id = trial-unverified
roles = [admin, operator]
```

因此：

- 页面显示的“操作人”不等同于强身份；
- Same-Origin 不等同于身份认证；
- 共享 token 也只是有限门禁；
- 真正多人生产化应使用可验证身份（如飞书 OAuth / 服务端 session）与明确 RBAC。

## 6. 飞书 9 表与同步

当前主数据 9 表：

`materials, locations, containers, members, items, manuals, workorders, transactions, itemOperations`。

同步路径包含：

- full state；
- changes 探测；
- incremental；
- three-way merge；
- reconcile；
- outbox；
- schema / schema-options；
- item-operation 专用受控写。

受控关系字段不应走普通 upsert 绕过协议。

## 7. 离线与失败恢复

### 普通同步/outbox

普通网络失败可以进入 outbox，并在恢复后重试；达到阈值后进入 needs_attention，由用户决定重试或放弃/导出。

### ITM 命令

ITM 命令更严格：

- 已提交/结果未知时不能擅自换 opId 重发；
- 查询原 opId 的云端终态；
- REPAIR_REQUIRED / unknown 必须保留可见人工出口；
- 本地 acknowledge 只有在持久化成功后才能把 UI 宣称为完成。

## 8. 草稿

扫码会话会自动保存到 IndexedDB，刷新后自动恢复路径会：

- 过滤不兼容旧序列；
- 丢弃没有命令背书的僵尸锁定行；
- 按 savedAt 选择最近可用草稿；
- restore 后 render。

v3.13.40 起，手动“恢复最近草稿”和自动恢复共用同一套可用草稿筛选、`savedAt` 排序和 `render()` 路径；真 IndexedDB 刷新恢复已纳入 browser 回归。

## 9. 子位与位置

当前关系真源：

```text
locations.role = 容器子位
locations.parentContainer = CTN
```

物品现状：

- 容器链：`item.container`
- 子位直存：`item.loc`

读取面必须同时支持两种，不得再假设“所有物品位置都由容器派生”。

## 10. 批量

批量不是另一套领域协议，而是单件步骤机的批量壳：

- receive：每件独立 LOC / CTN / ITM；
- subloc：LOC / ITM；
- issue：逐件 ITM；
- submit 时按 LOC 分组为 batch request；
- 版本在提交时重新从当前 state 派生，而不是扫描时冻结。

## 11. schema 失配策略

当飞书关键列缺失、类型不匹配或选项不合法时，应 fail closed：

- 不允许“少一列就先写其它列”破坏受控状态组；
- schema 面板应告诉用户缺什么；
- 修复 schema 后再恢复写入。

普通描述字段和受控字段要分开处理。

## 12. 当前运行边界与发布门禁

- 子位 unbind 已在 v3.13.40 完成领域、Repository、UI、占用门禁和审计闭环；自由位使用显式 `role='自由位'`。
- `verifyLegacy` 只保留为历史兼容/replay 分支，已从新建作业 UI 下线；v3.13.41 同时补齐新子位模型的 replay 兼容，正常新业务统一走 `receive`。
- 默认 `feishu-trial` 在未配置 token 时仍不是强身份认证；多人生产化应另行推进 OAuth/session/RBAC。
- GitHub Actions 已在 Vercel build/deploy 前执行 `npm test` 和 Chromium browser 回归；测试红灯会阻断生产部署。
- v3.13.42 Browser 回归当前 11/11 全绿；增加根入口/门户/只读搜索深链测试；源码卫生测试锁住 Git 冲突标记、门户死链和同步表数硬编码。

v3.13.41 的当前结论与完整验证状态见 `CURRENT_STATUS.md`。
