# 416MES ↔ InvenTree 集成评估与本地部署

> 日期：2026-09-10 ｜ 结论：**可以融合**，推荐「InvenTree 做主数据后端 + 416MES 保留标签打印前端」的渐进路线。

## 一、本地已启动的服务

| 服务 | 本机链接 | 局域网链接 | 账号 |
|---|---|---|---|
| 416MES 仓储系统（静态页） | http://localhost:8000 | http://192.168.209.2:8000 | 无需登录 |
| InvenTree Web UI | http://localhost:8001 | http://192.168.209.2:8001 | `admin` / 密码见下「凭据」节 |
| InvenTree REST API | http://localhost:8001/api/ | http://192.168.209.2:8001/api/ | Token 见下「凭据」节 |

## 凭据（仅本文档记录，勿贴到公网页面/仓库）

- 管理员：`admin` / `NECmes-cvtvu4r7!`（2026-09-11 轮换，旧密码 inventree416 已作废）
- API Token：`inv-f16ebc70afa31592bdf7ea85173e5e77cee47c9e-20260911`（有效期 1 年；旧 Token inv-e337… 已吊销——它曾随 Vercel 部署泄露）
- Token 同步脚本已自动写入 `inventree-sync.config.json`（本地 .gitignore 排除）

- InvenTree 版本 1.5.4（stable），单容器 SQLite 模式，数据持久化在 `./inventree-data/`
- 容器名 `inventree`，已设 `--restart unless-stopped`（Docker Desktop 启动后自动拉起）
- 注意：单容器模式后台 worker 未运行（`worker_running: false`），定时任务/通知类功能不可用；如需完整功能改用官方 docker-compose（postgres + redis + worker + proxy）

## 二、数据模型映射（融合基础）

| 416MES | InvenTree | 说明 |
|---|---|---|
| 物料台账 `{code,name,spec,loc,container,qty,cost}` | **Part** + **StockItem** | Part 存名称/规格/成本；StockItem 存数量与所在库位 |
| 库位码 `B-01-03-04` / 工位格 `W01-G02` | **StockLocation**（树形） | 货架-层-位可建 3 级树；工位格另建分支 |
| 容器码 `XK-001` 等 | StockLocation（structural）或 Part packaging | 建议先按"虚拟库位"挂到货架下 |
| 工单 LL领料/BH补货/JH拣货/TL退料 | Stock API：remove / add / transfer | 扫码闭环动作可直接调 `/api/stock/...` |
| NEC 小工单 RW/CG/WX… | Build Order / 外部（飞书多维表格） | InvenTree Build Order 偏生产组装，NEC 工单维持飞书同步更顺 |
| Excel 台账导入导出 | InvenTree 原生支持 Parts/Stock CSV/Excel 导入 | 零代码融合的最短路径 |

扫码串兼容性：416MES 的 `MAT:/LOC:/CTN:/WIP:` 前缀格式，InvenTree 可通过自定义 barcode 插件解析（自带 barcode 扫描出入库页面）；二维码本身无需重打，只需在 InvenTree 里给 Part/Location 绑定相同编码字符串。

## 三、三条融合路线

- **A. Excel 桥（零开发，立即可用）**：416MES「导出 Excel 台账」→ InvenTree 后台导入 Parts/Stock。适合每周对账、报表汇总。
- **B. API 桥（推荐，已实现 ✅）**：`inventree-sync.mjs` 已落地，把导出的 Excel 台账推送到 `/api/part/`、`/api/stock/`，并把 `MAT:/LOC:/CTN:` 扫码串绑定为 InvenTree 条码（标签不用重打）。库存仍以 416MES 扫码闭环为准，InvenTree 做台账镜像与报表。工单记录/NEC工单不同步（NEC 仍走 `nec-sync.mjs` → 飞书）。

### inventree-sync.mjs 用法

```bash
npm install xlsx          # 首次需要（已装好）
node inventree-sync.mjs init      # 配置地址+Token，建根分类/根库位（支持 INVENTREE_BASE_URL / INVENTREE_TOKEN 环境变量非交互）
node inventree-sync.mjs push --dry-run   # 预演，不写数据
node inventree-sync.mjs push             # 正式同步（自动取目录下最新 416MES_台账_*.xlsx）
node inventree-sync.mjs status           # 连通性 + 数据量
```

映射：物料 → Part（IPN=物料码）+ StockItem（数量/成本/库位，容器优先）；库位 → StockLocation 树（货架三级、工位两级）；容器 → 挂实际库位下的 Location。幂等：重复执行不产生重复数据，名称/数量变化自动 PATCH。配置存于 `inventree-sync.config.json`（含 Token，已加入 .gitignore）。
- **C. 全量迁移（长期）**：库存、扫码、标签打印全部用 InvenTree（自带标签模板可定制 60×40mm），416MES 退役。收益是多人协作+BOM+采购管理，代价是失去"双击即用、离线单机"的轻量特性，且汉印 N41 打印需重新调模板。

## 四、镜像方向演进判断（重要）

当前：库存真源 = 416MES（localStorage + 扫码闭环），InvenTree 只做台账镜像。

**触发反转的信号**：出现「两人同时扫码」「手机也要录单」「多设备看同一库存」任一需求时，localStorage 就撑不住了——此时立即把真源切到 InvenTree（它原生支持扫码出入库和 REST API），416MES 退化为标签打印 + 轻前端。切换前务必先用「导出备份 JSON」留档，再以当日台账为基准在 InvenTree 盘点初始化，避免双写期间数据对不上。

公网访问注意：门户页部署在 Vercel（HTTPS），直接 fetch 本地 `http://主机:8001` 会被浏览器混合内容策略拦截。若未来自托管，用 nginx 反代把 InvenTree 挂到同域 `/inventree/` 路径下即可同时解决混合内容、CORS、手机访问三个问题（home.html 已内置该路径的探测逻辑）。

## 五、常用维护命令

```bash
# 查看/重启 InvenTree 容器
docker logs --tail 50 inventree
docker restart inventree

# 进入容器执行管理命令（如改密码）
docker exec -it inventree invoke superuser

# 启动 416MES 静态服务（本目录下）
python -m http.server 8000
```
