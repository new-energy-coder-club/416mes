# GPT-6 唯一物品实现设计（S0）

## 边界与基线

- 本线路仅在 `/srv/416mes/.dev-lines/gpt6`、`feature/unique-item-gpt6` 开发，基线 `55d9297`。
- 已完整阅读《三线独立开发与验收计划.md》（78行）与《库位、容器、物品逻辑落地.md》（718行）。需求原文保留，不读取其他路线。
- 不访问真实凭据、飞书或生产；不 push、不部署；测试使用 fake 数据、localhost HTTP 和 fake-indexeddb。父级依赖仅由 Node 解析复用，不修改。
- 保留 mes416-state / v1 / 七 store；MAT 数量、流水和工单逻辑不迁移。

## 阶段实施

### S1 实体与字段契约

增加浏览器/Node 共用唯一物品领域模块：unknown/pending/in_stock/out/retired，严格重复码检测，派生当前位置，受控字段组与正式操作计划。旧空状态必须 unknown；LOC/CTN 未核实不得自动 active。ITM 无 qty 写语义。

扩展 lib/feishu-api.js 唯一字段映射与九表读取注册；把读取、普通写、操作写和历史保护名单分开。操作日志 code 映射操作ID，JSON 字段双向转换。关键列、类型、单选选项验证为只读检查，缺失禁写；第九表未配置不阻断旧八表读取。

### S2 持久化和同步

统一保存串行队列：普通保存、拉取落盘、命令入队和回执提交共享队列，在任务执行时固定快照，不在事务内网络 await。draft 放 syncMeta itmDraft 命名空间；outbox op=itemOperation 稳定 ID/载荷；state+outbox+草稿原子提交。成功回执落盘后才更新界面。跨标签以 Web Locks 协调；无法获得能力禁正式命令而保留草稿。

启动恢复 IDB 命令及已确认受控字段优先于 LS dirty；records replaceAll 包含操作缓存且不覆盖 drafts。pending 投影与确认值分别展示。全量和增量均通过受控字段组验证，不采用时间戳或 opId 字典序裁决；同版本异关系、无合法日志或日志 after 不一致进入隔离冲突。操作历史不参与自动判删。CLI 同步补齐字段并封受控写旁路；导入关系只预览不覆盖。

### S3 页面与扫码

接入现有导航、资源页和扫码页，独立 LOC→CTN→ITM 查询下钻；查询无写作用。严格行会话状态机携带 sessionId/rowId/step/generation，迟到和切行丢弃；同码去重，确认锁定，数量固定1。支持入/出/换箱及容器定位/移库各自流程。

条码能力检测优先 BarcodeDetector；解码器与扫描校验解耦。无相机/不支持一维码时显式提示扫码枪或手输，不把 jsQR 宣称一维解码。依赖选型须锁版并记录许可证/包体，提供真实条码 fixture 自动解码测试；硬件仍待验证。

### S4 操作接口与恢复

新增 POST/GET item-operation，生产和本地适配共用 handler。服务端认证决定 operator，规范化请求摘要与稳定 opId；请求不能带 qty 或绕过权限。共享协调适配器必须持久唯一认领、结果和未知屏障；缺配置/未通过验证 fail-closed。测试中的共享 fake 仅为模拟，不冒充 Vercel 全局锁。

执行 PREPARED→快照写入→回读→APPLIED；任何写入超时或崩溃留屏障，不能回读 before 后盲重试。回读 after 一致时允许修复原日志，不重做实体。未知日志创建同样在协调设施留阻断，租约过期不解冻。无可靠协调时 GET、查询、草稿继续，POST 拒绝。

### S5 集成与交付

fake飞书→页面控制器→真实 fake-indexeddb→API→另一客户端全量/增量闭环；故障注入、旧MAT/WIP回归、缺列/重复码/清空/分页/跨实例重试矩阵。全套 npm test 通过并检查 git diff。交付 schema、占位环境模板、开关默认值、停写/恢复/回退手册、LINE_REPORT.md。

## 已检查的现有衔接风险

- index.html:2204 save 是防抖异步，2274 持久化跨 await 读取全局 state，且 records 清单漏新表、事务不含 outbox。
- initLocalStore dirty 分支保留 LS 并仅继承 __base，需要保护已落盘命令/确认关系。
- lib/store.js 七 store 已足够，保留网页显式 dbName，不修改模块默认库名来冒充迁移。
- lib/feishu-api.js 普通 upsert 和混用读写表清单必须逐消费者收口，不能仅增加 TABLE_DEFS。
- index.html 全量 fsMerge 与增量 fsThreeWayApply 是不同入口，两者必须接线。
- 现有源码包含历史内置远端标识；不调用默认远端或复制真实环境配置。所有新增测试显式 fake 配置。

## 外部门禁（不构成开发停工理由）

真实隔离飞书 schema/权限/分页上限、手机 Android/iOS/飞书相机、共享协调设施持久性与生产/Preview 隔离均待授权验证。交付代码及模拟测试不等于允许上线正式写入。
