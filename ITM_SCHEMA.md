# 416MES ITM / LOC / CTN 字段与状态契约

> 当前基线：v3.13.42 / 2026-10-08
> 代码真源：`lib/unique-items.js`、`lib/feishu-api.js`、`lib/item-schema.js`、`lib/item-repository.js`。
> 本文描述**当前有效契约**，不是迁移脚本。

## 1. 飞书当前 9 表

`materials`、`locations`、`containers`、`members`、`items`、`manuals`、`workorders`、`transactions`、`itemOperations`。

其中 ITM 受控作业直接涉及四张表：

- `items`
- `containers`
- `locations`
- `itemOperations`

## 2. items（物品）

关键字段：

| 本地字段 | 飞书列 | 类型 | 说明 |
|---|---|---|---|
| code | 物品码 | 文本 | 业务键 |
| name | 名称 | 文本 | 普通字段 |
| spec | 规格型号 | 文本 | 普通字段 |
| loc | 库位码 | 文本 | 子位直存时为当前位置；其它状态可为空/历史兼容 |
| container | 容器码 | 文本 | 容器链在库时的当前容器 |
| status | 状态 | 单选 | pending / in_stock / out / retired 等受控状态 |
| version | 业务版本 | 数字 | 乐观版本前置 |
| lastOpId | 最后操作ID | 文本 | 最近受控操作 |
| materialCode | 关联物料码 | 文本 | 品类/物料关联，不是数量库存真相 |

受控字段：`container, loc, status, version, lastOpId`。

### 在库位置不变量

合法在库形态是二选一：

```text
A. 容器链：container != '' && loc == ''
B. 子位直存：container == '' && loc != ''
```

即 `container XOR loc`。

## 3. containers（容器）

| 本地字段 | 飞书列 | 类型 |
|---|---|---|
| code | 容器码 | 文本 |
| type | 容器类型 | 单选 |
| spec | 规格 | 文本 |
| loc | 当前库位码 | 文本 |
| status | 状态 | 单选 |
| version | 业务版本 | 数字 |
| lastOpId | 最后操作ID | 文本 |

受控字段：`loc, status, version, lastOpId`。

### 关于 containers.loc

v3.13.32 以后的**新子位模型不再用 `containers.loc` 表示容器拥有的子位**。

`containers.loc` 仍存在是为了：

- 旧模型数据兼容；
- 旧容器位置读取；
- 历史命令/迁移路径。

新的容器—子位归属真源在 locations。

## 4. locations（库位）

| 本地字段 | 飞书列 | 类型 | 说明 |
|---|---|---|---|
| code | 库位码 | 文本 | 业务键 |
| kind | 类型 | 单选 | 货架/工位/站点等 |
| desc | 说明 | 文本 | 描述 |
| grants | 授权人员 | 文本 | 当前业务很少使用 |
| role | 库位角色 | 单选 | 空/自由位语义或“容器子位” |
| parentContainer | 所属容器码 | 文本 | 子位的 owning CTN |
| status | 状态 | 单选 | active/disabled；旧空值会规范化为 unknown |

受控字段：`status, role, parentContainer`。

### 子位不变量

一个 LOC 是容器子位时：

```text
role === '容器子位'
parentContainer === <唯一 CTN code>
```

一格只能从属一个容器。

解除从属的目标状态是：

```text
role === '自由位'
parentContainer === ''
```

v3.13.40 已完成端到端实现：UI 先做占用与确认门禁，领域层生成受控 `activateLocation` 命令，Repository 显式把飞书单选“库位角色”写为“自由位”，同时清空“所属容器码”。不再依赖空字符串去清除 SELECT，因此不会形成半解绑状态。

## 5. itemOperations（物品操作账）

关键字段：

| 本地字段 | 飞书列 | 说明 |
|---|---|---|
| code | 操作ID | opId，幂等键 |
| kind | 操作类型 | receive / issue / transfer / batch / register / activate 等 |
| itemCode | 物品码 | 主物品 |
| containerCode | 容器码 | 相关容器 |
| request | 请求内容 | JSON |
| requestHash | 请求摘要 | 防同 opId 异载荷 |
| before | 操作前快照 | JSON |
| after | 目标快照 | JSON |
| phase | 处理阶段 | PREPARED / APPLIED / REJECTED / REPAIR_REQUIRED 等 |
| progress | 执行进度 | JSON |
| operator | 操作人 | 审计字段 |
| device | 设备 | 审计字段 |
| requestedAt | 受理时间 | 时间 |
| finishedAt | 完成时间 | 时间 |
| error | 错误与恢复说明 | 文本 |

### 核心原则

- opId 幂等；
- 同 opId 不允许悄悄换 request；
- 受控字段写入必须有 before/after；
- 提交后必须回读；
- 未知结果先查原 opId；
- 不能用“再生成一个新命令”掩盖未知结果；
- REPAIR_REQUIRED 必须保留人工恢复路径。

## 6. 常用操作状态机

### 物品

```text
pending
  ├─ receive ─> in_stock
  ├─ retire  ─> retired
  └─（其它非法迁移拒绝）

in_stock
  ├─ issue    ─> out
  ├─ transfer ─> in_stock（位置变化）
  └─（直接 retire 受现行规则限制）

out
  ├─ receive  ─> in_stock
  └─ retire   ─> retired

retired
  └─ 当前为终态
```

### 库位 / 容器启用

unknown/空状态可以经受控 activate 进入 active。disabled 的重新启用/停用策略不应通过普通 upsert 旁路实现。

## 7. 普通字段与受控字段边界

普通描述字段可按普通 CRUD 更新；关系、位置、状态、版本必须通过受控操作路径。

尤其禁止用普通 upsert 直接改：

- items.container / loc / status / version / lastOpId
- containers.loc / status / version / lastOpId
- locations.status / role / parentContainer

否则会绕过版本、幂等、before/after 和 itemOperations 审计链。

## 8. MAT 与 ITM 的关系

MAT 是品类/历史数量账层；ITM 是现场逐件实物层。

G3 之后：

- MAT 数量账封存；
- MAT 台账作为历史/品类信息保留；
- 当前“东西实际在哪里、是否在库”应以 ITM 与操作记录为准；
- 不应重新把 `materials.qty` 当作 ITM 数量的自动汇总真源，除非未来另立明确的聚合读模型。

## 9. 当前契约边界

1. `verifyLegacy` 仅保留给历史命令/草稿/replay：v3.13.41 已从新建作业 UI 下线；旧模型继续识别 `containers.loc`，迁移后的新模型识别 `locations.role='容器子位' + parentContainer`，因此历史 replay 不再依赖已退役的单一 pair 语义。
2. location 的本地 `unknown` 与飞书单选 active/disabled 的表达并不完全对称；当前通过空值/规范化兼容，这是迁移边界而不是现行业务 bug。
3. `retired` 当前为终态；如未来要恢复退役件，应新增显式生命周期迁移，不允许直接旁路改飞书。

这些边界都已在测试和运行文档中明确。
