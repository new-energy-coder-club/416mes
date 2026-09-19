# 物料台账（MAT）vs 唯一物品（ITM）功能盘点与合并路径研究

> 只读研究，未改业务代码。基于当前 main 工作区 `/srv/416mes` 实际代码核实，行号为当前快照。

## 0. 一页结论

- **MAT 与 ITM 不是「功能重叠」，而是「字段重叠、语义正交」**：MAT 是「按物料码记账的数量账」（一个 code 对应 N 件同类物），ITM 是「一件一码的实物状态机」（一个 code 对应唯一实物）。名称/规格/库位/容器/标签/扫码这些**表面字段重叠**，但 qty/minQty/流水/WIP/盘点这条数量链路 MAT 独有，且被全站深度依赖。
- **「物料台账页直接换成关联物品表」不可行**（会把数量账、WIP 领料、盘点、闲鱼同步、安全库存预警全部打断）。两表之间其实**已经有桥梁**：飞书「物品」表已有 `materialCode → 关联物料码` 列（`lib/feishu-api.js:220`），本地 `ordinaryFields` 也放行该字段（`lib/unique-items.js:156`），但**前端 UI 几乎没有用它**——这是低成本收益最大的改进点。
- **推荐路径 A+（保留两表、分工明确、打通关联）**，并给出分阶段方案；路径 C（台账页改物品列表）只可作为纯视图层补充，不可替代台账；路径 B（物品表吸收 MAT 字段）等于在 ITM 里重造一套 MAT，爆炸半径最大，不推荐。

---

## 1. MAT 功能全清单（代码位置 + 依赖方）

### 1.1 字段模型与分类体系

| 项 | 代码位置 | 说明 |
|---|---|---|
| 字段清单 code/cat/name/spec/xy/loc/container/zone/qty/minQty/cost/img | `index.html:2866` `MAT_COLS` | 12 列；`SECONDARY_MAT_COLS=['spec','xy','cost','img']` 默认折叠（2868） |
| 分类体系 `MAT_CATS`（JG机构件/DJ电机驱动/DZ电子件/GZ贵重件/TS调试设备/GJ工具/HC耗材/QT其他） | `index.html:2870` | 台账行内下拉（2909）、Excel 导入归一化 `normCat`（3358）、自动编号前缀来源 |
| 飞书映射 | `lib/feishu-api.js:150-172` `TABLE_DEFS.materials` | 飞书表「物料台账」，12 列双向映射；注释明确「不能用编号前缀反推分类：线上已有 PJ-LD-001」 |
| 种子数据 | `index.html:1950-1951` 等 | GJ-SD-001 螺丝刀、HC-BG-001 打印纸 |
| 载入归一化 | `index.html:2211` | 补 minQty=0/cat=QT/img='' |

### 1.2 编号自动生成

| 功能 | 代码位置 | 依赖方 |
|---|---|---|
| 空白码自动编号「分类-3位流水」（JG-001） | `index.html:2980-2989`（`btnAutoCode`，内联 `maxOf`，**不是** `nextCode`） | 台账页按钮；编号后补 `fsPushRecord('materials', blanks)` 建档 |
| 通用 `nextCode(arr, prefix)` | `index.html:4295-4308` | 成员 MB、手册 SC、容器 A4SH、物品 WP（资源档案 6374）；**物料不走它** |
| 工单号取号问飞书 | `index.html:4368` `/api/feishu/nextcode` | WIP 工单 |

### 1.3 库存数量管理（核心，全部由 mes-core.js 独占）

| 功能 | 代码位置 | 依赖页面/流程 |
|---|---|---|
| `applyStockChange()` 数量唯一写入口（改数+写流水不可分离、拒绝负数） | `mes-core.js:416` | 被 applyManualAdjust/applyStocktake/executeOrder/reverseOrder/导入合并 全部调用 |
| `recordTransaction()` 流水唯一写入口（seq 单调、balance 链） | `mes-core.js:320` | 同上；流水页 `renderTxns`（index.html:2552） |
| 台账行内改库存（必填原因 prompt、先本地后飞书、flashQty 反馈） | `index.html:2918-2945` | 台账页「库存数量」列（唯一高风险写入口，注释见 702） |
| 盘点 `parseStocktakeInput/applyStocktake`（严格校验，绝不静默转 0） | `mes-core.js:750`；UI `index.html:5337-5363`（扫码页盘点模式）、横幅 5704-5710、账本修数收敛 2615 | 扫码页 chkStocktake |
| 手工调整 `applyManualAdjust` | `mes-core.js:771` | 台账行内编辑 |
| 回放审计 `replayAudit` / 修账 `ledgerRepairPlan` | `mes-core.js:987 / ~906` | 数据健康面板（index.html:2511、2589） |
| 飞书库存直写 `fsPushStock`（物料 qty + 库存流水 append） | `index.html:8896`；服务端 `api/feishu/stock.js`、`lib/feishu-api.js:1023-1360`（余量核验、重复流水清理） | 所有数量变动 |
| 三方合并 qty 专属闸门 | `lib/three-way-merge.js:265-333` | 增量同步，qty 只允许自动快进，冲突强制人工 |
| 导入合并写「导入合并」流水 | `index.html:3509` | JSON 备份导入 |

### 1.4 Excel 导入导出

| 功能 | 代码位置 |
|---|---|
| 导出「物料台账」sheet（12 列） | `index.html:3116-3121`（btnExport） |
| 导出 库存流水/物品/手册/工单/NEC 等 9 sheet | `index.html:3122-3152`、`txnSheetRows` 3162 |
| 导入：sheet 白名单、列校验（物料台账必填 物料码/名称/规格型号/分类/库存数量/安全库存） | `index.html:3235、3258、3342-3400`（normCat、num 校验）、导入合并策略 3617-3624（不静默清 minQty） |
| 填表说明 sheet | `index.html:3549-3556` |
| 测试 | `test/excel-schema.test.js`、`test/ledger-identity.test.js` |

### 1.5 闲鱼同步（xianyu-sync）

| 功能 | 代码位置 |
|---|---|
| CLI `xianyu-sync.mjs`（status/import/fetch，CSV/TSV/JSON，字段映射 outer_id→物料码、stock→库存、售价/100→成本） | `xianyu-sync.mjs` 全文 |
| 核心合并 `pickXianyu/normalizeXianyuRow/mergeXianyu`（不覆盖 cat/loc/container/zone/minQty/spec；qty/cost 例外始终采用外部值） | `mes-core.js:1388-1470` |
| 依赖字段 | MAT 的 `xy`（闲鱼XY编号）、`qty`、`cost`、`img` |

### 1.6 WIP 工单领料（吃 MAT 数量，硬绑定 matCode+qty）

| 功能 | 代码位置 | 对 MAT 的依赖 |
|---|---|---|
| 建单校验物料存在 + 同行合并 `normalizeItems/createOrder` | `mes-core.js:147-216`；UI `index.html:4331-4350、4416` | `findMaterial` 查不到即拒；UI 实时提示「未在物料台账建档，无法生成工单」（4346） |
| 明细 datalist `refreshMatDatalist` | `index.html:4324` | 工单页物料码输入 |
| 执行前校验 `validateExecution`（汇总后校验库存） | `mes-core.js:463` | 读 `m.qty` |
| 执行 `executeOrder`（applyStockChange 逐料扣/增，execQty/execBatches） | `mes-core.js:513`；UI 执行卡 `index.html:5560-5660`（实时预览执行后库存 5605-5626） | 直接改 MAT qty + 写流水 + `fsPushStock`（5652） |
| 部分执行/取消/冲销 `cancelOrder/reverseOrder/updateOrderPlan` | `mes-core.js:563-700`；冲销 UI `index.html:4874` | 同样走 applyStockChange/fsPushStock |
| 工单 Excel 往返（明细 `matCode×qty` 文本） | `index.html:3138-3144、3391-3394` | 列格式绑定 matCode |
| 工单标签打印明细 | `index.html:2755、3785`（labelAttrs wip 分支） | `i.matCode+'×'+i.qty` |

### 1.7 标签打印

| 功能 | 代码位置 |
|---|---|
| 类型注册 `TYPES.mat`（prefix `MAT:`） | `index.html:1820` |
| 标签属性 `labelAttrs('mat')` = 名称/规格/库位 | `index.html:3779` |
| 数据源 `recordsOf('mat') = state.materials` | `index.html:3771` |
| 勾选集 `sel.mat`、删除后清下标 | `index.html:1928、3015` |
| 建码后直通打印 `nextStrip` | `index.html:4541` |
| 60×40/A4 PDF 排版 | `index.html:4050-4110` |

### 1.8 安全库存预警与扫码/定位

| 功能 | 代码位置 |
|---|---|
| 台账行预警底色（row-neg/row-low） | `index.html:2904-2905`、CSS 727/899 |
| 扫码 MAT 卡：负库存/低于安全库存 badge | `index.html:5366-5386` |
| 30S 定位 `locateMaterial`（台账 loc→最近带位置扫码→最近流水/工单 兜底链） | `mes-core.js:1338-1370`；UI `index.html:5388-5402` |
| 扫库位/容器/模块区反查在放物料 `scanWhere`（按 m.loc/m.container/m.zone 过滤并合计 qty） | `index.html:5408-5435` |
| 扫码记录 `recordScan/scanHistoryFor` | `mes-core.js:1085-1153` |
| NEC 任务「关联物料」按文本包含反查 MAT 显示库存 | `index.html:5450`（scanNec `related`） |
| 上下文条物料 chip | `index.html:5765` |

### 1.9 同步/持久化/其他依赖面

- 上行：`fsPushRecord('materials')`（8912）、`fsPushDelete`（8918）；下行：`fsMerge→CORE.mergeRemote`（mes-core.js:1508，MERGE_TABLES 含 materials 1481）；增量 `fsIncrementalSync`（7248）+ `lib/incremental.js` + `lib/census-status.js`。
- IDB 持久化：`persistStateToIdb` 表清单含 materials（约 2274，见《库位、容器、物品逻辑落地.md》§2.1）。
- 飞书服务端校验：`lib/feishu-api.js:1226`（validateFields 库存数量）、`1229-1360`（流水创建/核验/去重/余量修复）。
- Vercel API：`api/feishu/stock.js / upsert.js / delete.js / nextcode.js / state.js / incremental.js / reconcile.js`。
- 测试：`test/mes-core.test.js`（数量规则主体）、`three-way-merge.test.js`、`p4-conflict-paths.test.js`、`excel-schema.test.js`、`ledger-identity.test.js`、`feishu-sync.test.mjs` 等。

---

## 2. ITM（唯一物品）现状

### 2.1 字段（飞书「物品」表 ↔ 本地）

`lib/feishu-api.js:212-223`：`code 物品码 / name 名称 / spec 规格型号 / loc 库位码（历史线索，不反向更新）/ container 容器码 / status 状态(unknown/pending/in_stock/out/retired) / version 业务版本 / lastOpId 最后操作ID / materialCode 关联物料码`。
**无 qty**——`normalize()` 显式 `delete r.qty`（unique-items.js:23），`plan()` 对带 qty/delta 的请求直接 `ITM_HAS_NO_QTY` 拒绝（:71）。

### 2.2 流程（lib/unique-items.js `plan()` 状态机 + itemOperations 第九表）

- 作业类：`receive`（pending/out→in_stock，需 库位+容器 pair 校验）、`issue`（in_stock→out）、`transfer`（换容器）、`placeContainer/moveContainer`（容器定位/移库）、`verifyLegacy`（管理员，unknown→in_stock，旧 loc 仅历史线索可显式覆盖）、`retire`（pending/out/unknown→retired）。
- 建档/启用类（仅管理员）：`registerItem/registerLocation/registerContainer`、`activateLocation/activateContainer`。
- 每次操作：乐观版本校验（version+1）、before/after 快照进 itemOperations（phase: PREPARED/APPLIED/REJECTED/REPAIR_REQUIRED）。
- UI：`items` 页（查询）+ `item-work` 页（扫码作业台），`lib/item-ui.js`（草稿、待提交命令、冲突面板、引导式启用）；`ITM:xxx` 一维条码（WP- 前缀）走 `lib/item-barcode.js` + ZXing。
- 试运行协调：`lib/item-trial-coordinator.js`（feishu-trial-best-effort-v1，明确不承诺跨实例原子锁）；模式开关 `lib/item-mode.js`（ITM_OPERATION_MODE）。
- 标签打印已支持 itm 类型（`TYPES.itm` prefix `ITM:`，`labelAttrs('itm')` 名称/规格/库位）。
- UI 里已有明确分工提示：物品建档处「消耗品请走物料台账」（index.html:1476）；旧 MAT/WIP 台提示「唯一物品请进入独立模式」（1655）。

### 2.3 已存在但未用起来的桥

`items.materialCode`（关联物料码）在飞书表契约（ITM_SCHEMA.md）、字段映射、ordinaryFields 白名单中都已就位，但 **item-ui.js 的 detail/search 不显示它，registerItem 建档表单也不填它**——关联目前只是 schema 层面的占位。

---

## 3. 「台账直接换成关联物品表」逐条可行性

### 3.1 MAT 有而 ITM 没有（硬缺口）

| MAT 能力 | ITM 现状 | 换成物品表的后果 |
|---|---|---|
| qty 数量账 + 非负保护 | **设计上禁止**（ITM_HAS_NO_QTY） | 数量型物料无法记账 |
| minQty 安全库存预警（台账底色+扫码 badge） | 无 | 预警消失 |
| 库存流水 transactions（seq/balance 链、replayAudit 回放审计） | itemOperations 是操作快照日志，语义不同（文档明确「不复用旧流水承载 ITM」） | 审计链断裂 |
| WIP 工单 matCode×qty 领/补/拣/退 + 部分执行/冲销 | 无数量概念 | 工单体系整体瘫痪 |
| 盘点 applyStocktake | 无（逐件核实=verifyLegacy，语义是位置核实不是数量盘点） | 盘点模式失效 |
| cost 成本 / xy 闲鱼编号 / img 图片 | 无列 | 闲鱼同步无处落脚 |
| Excel 台账往返（9 sheet 契约+测试） | 物品 sheet 只有 4 列（码/名称/规格/库位） | 批量维护能力退化 |
| locateMaterial 30S 定位 / scanWhere 位置合计 | ITM 有 currentPosition，但只到单件 | 数量级位置合计消失 |
| 分类体系 MAT_CATS + 分类前缀自动编号 | 无 cat | 分类筛选、编号规则丢失 |

### 3.2 真正重叠的部分

名称 name、规格 spec、库位 loc（MAT 是手工文本字段；ITM 是 container→loc 关系真源+旧 loc 历史线索）、容器 container、标签打印（MAT:/ITM: 都已支持）、扫码查询、Excel「物品」sheet、资源档案 CRUD。重叠的是**档案属性**，不是**账**。

### 3.3 三种路径对比

| 维度 | A 保留两表分工 | B 物品表吸收 MAT 字段逐步替代 | C 台账页改为物品列表+类别分组 |
|---|---|---|---|
| 核心思路 | MAT 管数量型，ITM 管唯一单件，用 materialCode 打通 | items 表加 cat/qty/minQty/cost/xy/img/zone，废弃 materials | 页面层合并视图，物品按关联物料分组展示 |
| 数量型耗材 | MAT 原样管 | 需要给 ITM 发明「批次/数量」概念，**违反唯一单件契约**（要删 ITM_HAS_NO_QTY、恢复 delete r.qty，状态机、快照、回放全部重设计） | 无法回答——物品表没有数量 |
| WIP 工单 | 不动 | 工单明细从 matCode×qty 改成扫单件码列表，等于重写 mes-core 工单+执行+冲销+流水 | 不动（视图层） |
| 飞书表变更 | 零（materialCode 列已存在） | 物品表加 ≥7 列+单选选项，且受控 schema（item-schema.js REQUIREMENTS）要改版 | 零 |
| mes-core.js 改动 | 零 | 伤筋动骨：数量唯一写入口、三方合并 qty 闸门、replayAudit 全要双轨 | 零 |
| 页面改动 | 台账页加「关联物品」列/展开；物品详情显示物料信息 | 全部页面 | 台账页重写为分组列表（只读视图） |
| 测试影响 | 新增少量联动测试 | mes-core.test.js 大面积改写；p4/p5/p6、three-way-merge、excel-schema 连锁 | 新增视图测试 |
| 风险 | 低 | 高（两套账并行期数据一致性、迁移期 WIP 冻结） | 中（用户误以为物品列表就是库存） |
| 可逆性 | 高 | 低 | 高 |

---

## 4. 两个重点问题的回答

### 4.1 按类数量型物料（PJ-LD-001 LED灯珠 20个）在唯一单件模型下怎么办？

**不要逐件贴码。** 三个理由：
1. 成本上：20 颗灯珠打 20 张码、入库扫 20 次、领料扫 N 次，现场不可行；ITM 的价值（追溯唯一实物去向）对耗材为零。
2. 架构上：ITM 领域层**显式拒绝数量**（`ITM_HAS_NO_QTY`、`delete r.qty`），第九表契约、状态机、版本仲裁全部按「一件一码」证明过正确性；硬塞数量等于推翻已验收的契约（ITM_SCHEMA.md 是「只读核验清单」）。
3. 分类体系本身已给出答案：`MAT_CATS.HC = 耗材`，UI 提示「消耗品请走物料台账」（index.html:1476）——**设计上就是分工的**。

正确做法：**数量型物料保留 MAT 数量管理**；只有当某类物料里出现「需要单独追溯的个体」（如贵重件 GZ 里的某台仪器）时，才为其建 ITM 单件档案，并用 `materialCode` 指回 PJ-LD-001 这类物料码。边界规则建议：**cat∈{HC,DZ,QT} 默认纯 MAT；cat∈{GZ,TS,GJ,DJ,JG} 允许 MAT（总数账）+ ITM（重点单件）双轨**，ITM 在库单件数可作为 MAT qty 的「已贴码部分」展示，但不做强制相等校验（灯珠 20 个里 0 个贴码是合法的）。

### 4.2 改动物料台账会牵连什么（WIP 视角）

WIP 是 MAT 的**头号下游**，绑定链：
建单（物料必须建档 4346 / datalist 4324）→ 明细合并 normalizeItems → 执行校验 validateExecution（读 m.qty）→ executeOrder（applyStockChange 逐料扣减）→ fsPushStock 直写飞书物料 qty + 追加库存流水（stock.js 含余量核验与去重）→ 部分执行 execQty/冲销 reverseOrder 同样走数量 → 工单 Excel 往返列格式 `matCode×qty` → 工单标签明细 → replayAudit 用流水链验账 → 三方合并对 materials.qty 有专属冲突闸门。
**任何「台账页换物品表」的动作，如果不先回答 WIP 的数量来源，等于同时推翻 mes-core.js 的核心契约和它的测试主体（mes-core.test.js）。** 这也是路径 B/C 真正贵的地方，不在页面，在这条链。

---

## 5. 推荐方案：路径 A+（保留两表 + 打通 materialCode + 视图层增强）

### 阶段 0（纯展示，零 schema 变更，1 个迭代）
- 物品查询/详情（item-ui.js detail/candidate）显示 `materialCode` 及从 MAT 带入的名称/规格/当前库存。
- registerItem 建档表单加「关联物料码」下拉（数据源 state.materials），写入已有 ordinaryFields 白名单字段，**不需要改受控 schema**（materialCode 是普通字段）。
- 台账页每行加「已建档单件 n」列（`state.items.filter(i=>i.materialCode===m.code && i.status==='in_stock').length`），点击跳到 items 页带筛选——这就是用户想要的「关联物品表」的**最小实现**，不动台账本身。
- 测试：item-ui.test.js 加 materialCode 展示/建档用例；unique-items.test.js 补 ordinaryFields 回归。

### 阶段 1（飞书数据回填，无结构变更）
- 飞书「物品」表 `关联物料码` 列**已存在**（ITM_SCHEMA.md 扩列清单），仅需人工/脚本回填存量 WP-xxx 的 materialCode；回填脚本走 `feishu-sync.mjs` 同款的 upsert 通道，dry-run 先行。
- 制定双轨编码边界规则（见 4.1）并写进 README/需求书。

### 阶段 2（视图层可选：台账页「按类别分组+展开单件」）
- 即路径 C 的安全版：台账页保持为数量账权威，增加分组视图模式（按 cat 分组，行内可展开该物料的 ITM 单件列表，只读）；**不删任何 MAT 列与写入口**。
- 若此时仍觉得两页割裂，再评估把「物品查询」页签与台账页做 tab 合并（同一个页面两个视图），数据层不动。

### 阶段 3（仅在确有需求时：单件级领料）
- WIP 增加可选的「指定单件」附件（工单行记录 itemCodes 列表，仅追溯用、数量仍走 MAT qty），需改 workorders 表加一列 JSON——**独立评估，不捆绑本次**。

### 测试点汇总
- 单元：mes-core 全套不动必须常绿；unique-items ordinaryFields 含 materialCode；item-ui 详情联动。
- 集成：Excel 导出 9 sheet 契约不变（excel-schema.test.js）；三方合并 materials.qty 闸门回归（three-way-merge.test.js、p4-conflict-paths）。
- 浏览器门禁：`npm run test:browser`（item-browser.browser.cjs）。
- 飞书核验：物品表 materialCode 列类型=文本；回填后抽 10 条下行 normalize 核对。
- 现场：扫 MAT 码→台账卡显示关联单件数；扫 ITM 码→详情卡显示物料名称与当前物料库存。

## 6. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 用户真实诉求是「页面太多/字段重复看着乱」，误把合并当解法 | 中 | 阶段 0/2 的视图整合先验证是否已满足 |
| materialCode 回填与 MAT 改名/删码脱节（悬空引用） | 中 | 删除物料时检查引用（现有 resImpact 模式可复用到台账删除）；悬空码在物品详情显示「物料已不存在」而非报错 |
| 双轨边界不清，有人给灯珠逐件贴码或把仪器只进 MAT | 中 | 阶段 1 明文规则 + 建档表单按 cat 给提示 |
| MAT qty 与「已贴码单件数」被误认为必须相等 | 低 | UI 文案明确「单件数 ≠ 库存数量，仅追溯用」 |
| 路径 B 的诱惑（“都加到物品表里”） | 高 | 本报告 §3.3：B 需要推翻 ITM 数量禁令与已验收契约，且 WIP/流水/回放全重写，成本远超收益 |
| 台账页删除物料的飞书同步已有坑（物料不存在导致库存写失败进离线队列） | 已有 | 不在本次范围，但阶段 0 改动台账行时注意不要触碰既有 fsPushRecord 顺序逻辑（2918-2945 注释警告） |
