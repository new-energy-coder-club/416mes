# 416MES 当前状态

> 当前版本：**v3.13.42（工作树待验证/提交）**
> 日期：2026-10-08
> 分支：`main`
> 本文只描述当前有效状态；历史审计过程见 `需求书校准记录.md` 与本地 `dev-docs/`。

## v3.13.42 首页与默认路由重构（2026-10-08）

- **默认入口**：Vercel 在 `/` 使用 307 定向 `/home.html`；原因是现有 `index.html` 会优先命中文件系统，普通 root rewrite 不能稳定覆盖。两套本地 HTTP 服务的根入口均为主页。
- **门户信息架构**：只读查询、扫码作业和 WIP 工单优先；概况、数据状态、工具、历史归档按使用频率分层。取消静态主页强制 4 秒加载遮罩，新增响应式布局。
- **首页数据口径**：ITM/WIP 来自当前浏览器 localStorage 快照，本机未决队列来自已有 IndexedDB 的只读事务；数据缺失/异常显示“—”，不能误报成零；备份无记录不再伪造 99 天；网络连接与飞书同步成功必须分开表达。
- **查询深链**：`#items?q=...` 会等本地 IDB 就绪后执行只读查询，URL 可刷新复用，绝不自动生成/提交库存操作。
- **验收**：增加 `test/home-portal.test.js` 与 `test/home-portal.browser.cjs`，覆盖根路由、真实页签、移动/平板/桌面、无快照、备份、离线、IDB、搜索与刷新。 **最终本地全量：Node 1383/1383、Chromium Browser 11/11，均 0 fail。**
- **部署状态**：以上仅为当前工作树改动，尚未推送 GitHub；生产域名继续显示上一版，直到 CI/部署完成。

## 一、当前结论

v3.13.40 完成了 v3.13.39 全项目审计中发现的跨层缺口与一致性问题；v3.13.41 又收口了最后一个历史兼容矛盾：新作业 UI 不再暴露已并入普通入库的 `verifyLegacy`，但历史命令/草稿 replay 同时兼容旧 `containers.loc` 与新“容器子位 + parentContainer”关系。当前主要收口项包括：

- 手动草稿恢复与自动恢复统一为同一套兼容性过滤、`savedAt` 排序和 render 路径；
- 历史含小写随机码的 ITM 标签恢复可生成/可重打，HTML / PDF / A4 QR 路径均覆盖；
- 容器子位解除从属补齐领域、仓储写入、UI、占用门禁和审计命令；
- MAT 数量账相关 browser 测试更新为 G3 后的“历史归档”口径；
- WIP 冲销 browser fixture 更新为真实 itemized 执行后状态；
- 查询页、同步页、门户和历史招募页的旧业务文案已统一；
- 清除了 `index.html` 中遗留的 Git 冲突标记；
- 门户失效的 `#gen` 入口修正到当前有效页签；
- 新增源码卫生测试，防止冲突标记、门户死链和同步表数硬编码回流；
- GitHub Actions 改为测试全绿后才允许 Vercel 生产部署。

当前没有已知的、可复现的业务逻辑 bug 或 UI bug。

## 二、核心业务闭环

### 唯一物品

当前现场库存真相围绕 ITM：

`建档 → 标签/短链 → 入库 → 查询/定位 → 移库/换箱 → 出库 → 工单执行/冲销 → 操作审计 → 退役`

MAT 数量账只作为历史数据保留，不再作为实时库存真相。

### LOC / CTN / ITM

在库位置有两种合法形态：

```text
容器链：item.container != '' && item.loc == ''
子位直存：item.container == '' && item.loc != ''
```

即 `container XOR loc`。

容器子位关系真源：

```text
location.role = 容器子位
location.parentContainer = CTN
```

普通自由库位在 v3.13.40 中明确使用：

```text
location.role = 自由位
location.parentContainer = ''
```

### 子位解除从属

当前已形成完整闭环：

1. UI 管理员入口确认解除；
2. 若子位仍有在库物品，前置拒绝；
3. 生成受控 `activateLocation` 命令；
4. 领域 plan 目标状态为 `role='自由位'`、`parentContainer=''`；
5. Repository 显式写飞书“库位角色=自由位”，同时清空所属容器；
6. 操作账保留 before / after 与 opId；
7. 本地不先改镜像冒充成功。

这样避免了“角色仍是容器子位、所属容器却为空”的半解绑状态。

### 批量作业

- 入库：每件独立 `LOC → CTN → ITM`；
- 子位直存：`LOC → ITM`；
- 出库：逐件 ITM；
- 不同件可位于不同 LOC / CTN；
- 提交按 LOC 稳定分组；
- 提交时重新读取版本，不用扫描时旧快照。

### 工单

新工单使用 itemized 逐件模型，支持：

- 逐件计划；
- 部分执行；
- 防串单；
- 执行批次留痕；
- 当前状态驱动的冲销；
- skipped / exemption 审计；
- 取消/冲销后状态收口。

## 三、v3.13.40 修复项

### 1. 草稿恢复

此前手动“恢复最近草稿”存在提示成功但 UI 没刷新、且没有按时间取最新草稿的问题。

现在手动和自动恢复共用 `usableDrafts()`：

- 过滤不兼容旧步骤序列；
- 清理无命令背书的僵尸锁定行；
- 按 `savedAt` 降序；
- `scan.restore()` 后立即 `render()`。

Chromium + 真 IndexedDB 刷新链路已覆盖。

### 2. 历史小写码 QR

旧随机码例如：

```text
WP-a1b2c3d4
```

现在 QR 生成先判断是否符合 QR Alphanumeric 字符集：

- 合法大写短链 → Alphanumeric；
- 小写/其它合法文本 → Byte。

PDF Canvas 绘制 QR 时关闭 image smoothing，避免缩放灰边降低 jsQR / 扫码枪识别率。

已覆盖：

- HTML 标签；
- 单标签 PDF；
- A4 整版；
- 单独 QR 图片/下载路径；
- 旧小写随机 ITM 码。

### 3. 子位解绑

v3.13.40 不再尝试把飞书单选字段 `role` 写成空字符串，而是显式写成“自由位”。

这是有意的契约变化，不是显示层 workaround：飞书 SELECT 空值不能依赖普通字段转换稳定清除，显式“自由位”可写、可回读、可审计。

## 四、UI 当前状态

本轮实页审查覆盖：

- 390×844 手机；
- 1280×900 桌面；
- 主应用 14 个页签；
- `home.html`；
- `join.html`。

检查项：

- 页面是否可见；
- 普通控件是否掉出视口；
- 页面级横向溢出；
- 显式滚动容器；
- 重复 ID；
- loader 是否永久遮罩；
- pageerror / console error；
- 门户 hash 是否对应真实页签。

结果：

- 14 个页签均可正常渲染；
- 手机/桌面无页面级横向爆版；
- 未发现常规控件掉出；
- 无重复 DOM id；
- loader 正常移除；
- 无页面级 JS error；
- 门户主入口全部指向有效页签。

同时已修：

- 查询页对子位直存位置的旧文案；
- 同步成功提示由硬编码“8 表”改为 `SYNC_TABLES.length`；
- `home.html#gen` 死链接；
- 门户 MAT 数量中心看板，改为 ITM / 在库 / 工单 / 操作记录；
- `join.html` 旧 MAT 实时库存宣传；
- loader “6 秒”旧注释与实际 10 秒兜底不一致；
- `index.html` 残留 Git 冲突标记。

## 五、测试与发布门禁

### Node

v3.13.41 已跑完整 `npm test`：**1378/1378，0 fail**。业务、持久化、同步、飞书、并发、工单、扫码、批量、子位、历史 replay、缓存版本与源码卫生门禁全部通过。

新增 `test/source-hygiene.test.js`：

- 生产源码不得含 Git 冲突标记；
- 门户 `index.html#...` 必须指向当前真实 tab；
- 同步成功表数不得重新硬编码成 8。

### Browser

`npm run test:browser` 当前 **7/7 全绿**。

覆盖：

- IndexedDB 草稿刷新恢复；
- ITM 短链与历史随机码；
- 标签 HTML/PDF/A4 QR 解码；
- MAT 归档口径；
- WIP 冲销；
- 盘点差异出口；
- 查询、打印等 browser 链路。

### CI

`.github/workflows/vercel-deploy.yml` 当前顺序：

```text
checkout
→ setup-node
→ npm ci
→ npm test
→ 安装 Chromium
→ npm run test:browser
→ Vercel pull
→ Vercel build
→ Vercel production deploy
```

因此 main 上任何 Node 或 Browser 回归失败都会阻止生产部署。

## 六、仍然存在但不是 bug 的边界

以下属于明确产品/架构边界，不应误报成缺陷：

### verifyLegacy

`verifyLegacy` 自 v2.58.0 起已经并入普通 `receive`；v3.13.41 修正了后来误回流的独立 UI 入口。现在用户新建作业只看到入库 / 出库 / 换箱，unknown 旧物品统一走入库。

历史 `verifyLegacy` 命令、草稿和操作记录仍可 replay：旧模型按 `containers.loc` 校验；容器已迁移到新模型时，按 `locations.role='容器子位' + parentContainer` 校验，并以子位直存形态落库。

### retired

`retired` 当前是终态。没有“恢复退役物品”按钮是现行生命周期设计。

### 身份

默认 `feishu-trial` 在未配置 `ITM_OPERATOR_TOKENS` 时使用 `trial-unverified`，不是强身份认证。

这不影响单操作员试运行的业务正确性，但若系统进入正式多人生产，应单独推进飞书 OAuth / 服务端 session / RBAC。它属于安全与身份能力升级，不是当前仓储逻辑 bug。

### 旧 containers.loc

新子位归属不以 `containers.loc` 为真源，但该字段仍用于旧数据/迁移兼容。删除它属于未来数据迁移，不应在当前版本贸然强拆。

## 七、当前文档真相源

按优先级：

1. `README.md`：产品入口与总体架构；
2. `CURRENT_STATUS.md`：当前完成状态、测试与边界；
3. `ITM_SCHEMA.md`：字段/状态/受控关系契约；
4. `ITM_RUNTIME.md`：持久化、同步、身份、恢复与运行约束；
5. `需求书校准记录.md`：需求与版本演进记录。

`分阶段解决方案.md`、`用户视角业务逻辑整改方案.md`、`逻辑功能测试文档.md` 保留为历史演进记录，不再作为当前状态依据。

本地 `dev-docs/` 保存更细 RCA 与阶段验证，但因 `.gitignore` 不会进入 GitHub。
