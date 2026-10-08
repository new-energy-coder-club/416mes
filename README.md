# 416MES 仓储 / 物品作业系统

> **当前主线：v3.13.42（2026-10-08，首页重构候选版）**
>
> 本 README 只描述**当前有效架构与业务口径**。v2.x 阶段方案、早期 InvenTree 方案、旧 MAT 数量账方案均属于历史资料，不再代表现状。当前状态、验证结果与明确架构边界见 [CURRENT_STATUS.md](CURRENT_STATUS.md)。

416MES 是面向 A416 现场仓储的 Web MES。当前核心已经从早期“物料 × 数量”模式迁移为**唯一物品（ITM）逐件作业**：物品建档、标签、入库、出库、移库/换箱、盘点、工单执行、操作审计与飞书同步围绕单件物品闭环；旧物料（MAT）数量账仅保留为历史归档视图。

## 当前业务模型

### 1. 唯一物品是现行业务主线

现行业务对象：

- **LOC**：库位。
- **CTN**：容器。
- **ITM**：唯一物品，一件一码。
- **WIP**：库存工单，当前新建工单走物品化明细。
- **MAT**：物料/品类历史主数据；数量账已封存，不再作为实时库存真相。

物品在库的合法位置有两种，满足 **`container XOR loc`**：

1. **容器链**：`item.container = CTN`，实际库位由容器关系派生。
2. **子位直存**：`item.container = ''`，`item.loc = 子位 LOC`。

### 2. 容器—库位关系

v3.13.32 起采用“容器子位”模型：

- authoritative relation：`locations.role = '容器子位'`
- owner：`locations.parentContainer = <CTN code>`
- `containers.loc` 只保留旧模型兼容语义，不是新模型下的子位归属真源。

子位 LOC 在入库/移库时会自动走两步流（如 `LOC → ITM`），普通库位走 `LOC → CTN → ITM`。

### 3. 批量作业

v3.13.36 起，批量入库不再共享“锚点”：

- 每件独立扫描 `LOC → CTN → ITM`；
- 子位件自动退化为 `LOC → ITM`；
- 不同件可以位于不同库位/容器；
- 提交时按 LOC 稳定分组为 `receiveBatch`；
- 批量出库直接逐件扫 ITM，来源位置由当前物品状态派生。

## 当前页面

主作业端 `index.html` 目前有 14 个页签：

1. 库位/容器/物品查询
2. ITM 作业
3. 建档管理
4. 扫码工作台
5. 库存工单（WIP）
6. 操作记录
7. 物料台账·历史
8. 库存流水
9. 资源档案
10. 成员名录
11. 标签打印
12. 排版工具
13. NEC 任务
14. 同步与状态

**主页入口：** 生产环境访问 `https://mes.newenergycoder.club/` 会以临时 307 跳转到 `/home.html`；主业务端仍保留 `/index.html#...`，物品/容器短链和 API 不受影响。本地两种 HTTP 服务的 `/` 同样进入主页。

`home.html` 为移动优先的仓库工作台：优先展示扫码作业、库存工单和只读查询；`home.css` 提供样式、`home.js` 只读取本地快照、备份记录和既有 IndexedDB 出队列。主页不直接写入库存或飞书，也不把网络在线误报为云端已同步。首页搜索通过 `index.html#items?q=...` 只读深链进入主应用，等待 IndexedDB 初始化后执行查询，刷新不会丢关键词。

`join.html` 是历史招募页面，不属于业务主流程。

## 架构

### 浏览器端

- `home.html` / `home.css` / `home.js`：入口门户、响应式工作台与只读本机摘要。
- `index.html`：页面结构、传统 MAT/WIP 页面逻辑及应用启动。
- `mes-core.js`：历史 MAT 数量账、工单与审计等纯领域逻辑。
- `lib/unique-items.js`：LOC / CTN / ITM 状态机与受控字段约束。
- `lib/item-scan.js`：单件/批量扫码会话状态机。
- `lib/item-ui.js`：ITM 查询、作业、草稿、待处理区与批量 UI。
- `lib/item-persistence.js` + `lib/store.js`：IndexedDB / LocalStorage 持久化与单写者约束。
- `lib/item-client.js` / `item-operation.js` / `item-repository.js` / `item-runtime.js`：受控命令提交、幂等、版本前置、飞书仓储与运行模式。
- `lib/item-sync.js` / `incremental.js` / `three-way-merge.js` / `outbox.js`：全量/增量同步、三方合并、离线队列。
- `lib/scan-*.js`：相机、条码/二维码解码与 worker。
- `lib/item-link.js` / `ctn-link.js`：物品/容器短链。

### 云端 / 飞书

当前飞书主数据共 **9 表**：

`materials`、`locations`、`containers`、`members`、`items`、`manuals`、`workorders`、`transactions`、`itemOperations`。

Vercel API 位于 `api/feishu/`，包含 state、changes、incremental、upsert、delete、stock、reconcile、schema、item-operation 等接口；物品与容器短链分别由 `api/item-link/`、`api/ctn-link/` 提供。

字段和状态契约见 [ITM_SCHEMA.md](ITM_SCHEMA.md)，运行时与身份边界见 [ITM_RUNTIME.md](ITM_RUNTIME.md)。

## 快速启动

安装依赖：

```bash
npm ci
```

本地开发（静态页面 + 本地飞书代理；无配置时可降级）：

```bash
npm run dev
```

只启动静态页面：

```bash
npm run serve:static
```

默认地址：

```text
http://localhost:8000/             # 默认主页（或 /home.html）
http://localhost:8000/index.html    # 完整业务工作台
```

> 早期 README 所写“`index.html` 双击即可完整离线使用”已经不再是推荐运行方式。当前应用仍保留离线/降级能力，但 ITM 持久化、短链、云端真源和受控写入均以 HTTP 环境为正常路径。

## 测试与发布门禁

常用命令：

```bash
npm run check
npm test
npm run test:browser
npm run lib:manifest
```

**v3.13.42 本地回归已完成（尚未推送/部署）：**

- `npm test`：**1383/1383，0 fail**；覆盖领域、持久化、同步、飞书、并发、工单、扫码、批量、子位、缓存版本与源码卫生守卫。
- `npm run test:browser`：**11/11 全绿**；含 4 项新增门户测试：根入口、响应式布局、只读本机看板、备份/离线、IndexedDB 和搜索深链；既有 7 项 QR、PDF、WIP、草稿与盘点回归不变。
- GitHub Actions 已加入 `npm test` + Chromium browser 回归；任一测试失败都会在 Vercel 生产部署前阻断。
- 新增源码卫生守卫，禁止 Git 冲突标记、门户无效 hash 和同步表数硬编码回流。

详细状态见 [CURRENT_STATUS.md](CURRENT_STATUS.md)。

## 标签打印

当前标签页以**浏览器预览 + PDF/图片输出**为主，不直接驱动打印机协议。

- 支持 LOC / CTN / MAT / ITM / MAN / WIP / NEC 等标签。
- 支持 60×40 标签排版与 A4 整版。
- ITM 与 CTN 已支持短链。
- v3.13.38~3.13.39 对容器标签 QR 的静区、纠错级别、尺寸与页脚重叠进行了专项修正。
- v3.13.40 补齐历史小写随机码的 Byte 模式兼容，并在 PDF Canvas 缩放 QR 时关闭平滑，HTML/PDF/A4 路径均已通过解码回归。

## 数据、备份与同步

浏览器状态并非只存在 LocalStorage：

- LocalStorage：应用快照、偏好与部分启动信息。
- IndexedDB：ITM 持久化、草稿、命令/outbox 等。
- 飞书：在线主数据与操作账。
- JSON 备份：包含公开业务状态；可选是否包含人员 PIN。
- Excel：当前导入/导出按多工作表业务数据组织，不应再按早期“四表”文档理解。

同步页提供状态、冲突、重拉、重置与审计入口。涉及受控字段时，不应直接绕过 item-operation 协议写飞书。

## 当前已移除或冻结的方向

- **InvenTree**：已经从当前产品范围移除，不是待接入模块。
- **闲鱼 → MAT 数量账**：G3 后冻结；`xianyu-sync.mjs` 仅保留历史/兼容脚本，不应恢复为当前库存真源。
- **MAT 数量库存告警**：数量账已归档，低库存/负库存颜色预警已主动取消。
- **旧 MAT 工单执行模式**：保留历史查看/迁移兼容，新业务应使用物品化工单。

## 运行安全边界

当前 item-operation 默认模式仍是单操作员试运行语义：

- 未配置 `ITM_OPERATOR_TOKENS` 时，不提供真正的用户身份认证。
- Same-Origin 校验不是用户身份认证。
- `strict` / token 模式可增强门禁，但目前还不是飞书 OAuth 多用户正式方案。

因此不要把“线上可用”理解为“已完成多用户零信任授权”。详见 [ITM_RUNTIME.md](ITM_RUNTIME.md)。

## 文档真相源

当前文档优先级：

1. **README.md**：当前产品入口与总体架构。
2. **CURRENT_STATUS.md**：当前版本审计、已知缺口、测试状态。
3. **ITM_SCHEMA.md**：现行 LOC/CTN/ITM/操作账字段与不变量。
4. **ITM_RUNTIME.md**：运行模式、持久化、同步、身份与恢复。
5. `需求书校准记录.md`：需求范围变更摘要。

以下文件保留为**历史演进证据**，不再作为当前状态依据：

- `分阶段解决方案.md`
- `用户视角业务逻辑整改方案.md`
- `逻辑功能测试文档.md`

本地 `dev-docs/` 包含更细的阶段 RCA、生产验证和截图，但该目录被 `.gitignore` 排除，不会自动出现在 GitHub。