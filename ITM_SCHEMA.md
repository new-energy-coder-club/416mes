# 唯一物品字段契约 v1

本文件及 `lib/item-schema.js` 为只读核验清单，不是自动迁移脚本。八表保留原 ID/原字段，新增 itemOperations 的 ID 必须显式配置在 FEISHU_TABLES 中；未配置仍可读取旧表。不得使用生产凭据执行开发核验。

## 扩列

| 表 | 本地字段 → 飞书列 | 类型/选项 |
|---|---|---|
| items | container→容器码；lastOpId→最后操作ID；materialCode→关联物料码 | 文本，materialCode可选 |
| items | status→状态 | 单选 unknown/pending/in_stock/out/retired |
| items | version→业务版本 | 数字整数，未核实0 |
| containers | status→状态 | 单选 active/disabled，旧空值本地unknown |
| containers | version→业务版本；lastOpId→最后操作ID | 数字整数/文本 |
| locations | status→状态 | 单选 active/disabled，旧空值本地unknown |

容器旧当前库位码为关系真源。物品旧库位码保留历史，不反向更新容器归属。全部参与增量的表需系统最后更新时间（type 1002）。MAT 与旧流水不变。

## 第九表 itemOperations

code→操作ID（文本业务键，不是原生唯一约束）；kind→操作类型（文本或单选）；itemCode→物品码；containerCode→容器码；request→请求内容；requestHash→请求摘要；before→操作前快照；after→目标快照；phase→处理阶段；progress→执行进度；operator→操作人；device→设备；requestedAt→受理时间；finishedAt→完成时间；error→错误与恢复说明。

request/before/after/progress 为文本JSON，时间为日期时间（type5），phase为单选 PREPARED/APPLIED/REJECTED/REPAIR_REQUIRED，其余为文本。操作类型支持 receive/issue/transfer/placeContainer/moveContainer/verifyLegacy/retire，以及用于旧档案启用的 activateLocation/activateContainer。

## 旧 LOC/CTN 核实入口

不把全部旧记录自动改 active。管理员受控操作依次：activateLocation（仅允许 unknown→active，要求 expected.locationStatus 一致；v1不支持停用/重新启用）→ activateContainer（核对现有库位线索，不匹配则拒绝；校验业务版本）→ verifyLegacy。三个操作都须按正式接口协议写日志和共享协调，不允许 ordinaryFields 带 status 绕过。领域层 bootstrap 已有自动化测试；页面及服务端接线属于后续 S3/S4。

库位没有引入未经需求批准的新 version 列，activateLocation 使用当前状态前置条件和共享串行仲裁；缓存接收时需要核验操作 after。非管理员不得核实/启用。

## 权限与默认安全

- READ_TABLES 包含九表；GENERIC_WRITE_TABLES 不含操作表；APPEND_PROTECTED_TABLES 包含 MAT流水/物品操作。
- 表存在任一状态/业务版本/最后操作ID标记即启用通用写保护，部分迁移不会重新打开旧旁路。普通改名剥离受控字段与相应 clearFields；禁止硬删或用通用 upsert 建新码。
- 旧完全未迁移 schema 维持既有回归行为，不把 MAT/WIP 全局封停。正式操作仍须关键列全部满足，不能依赖该兼容路径写 ITM。
- schema校验只证明列、类型、选项；不证明字段ACL、认证或共享协调。validate 的 writeEnabled 恒为 false，由正式服务端独立判断全部门禁。
- 权限需隔离飞书人工核验：关键列普通用户只读，操作表禁止普通编辑/删除，系统操作身份才可写。未核验不得启用正式作业。
