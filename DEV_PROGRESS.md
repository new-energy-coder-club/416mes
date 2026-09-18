# GPT-6 独立路线开发进度

## 执行约束

cwd `/srv/416mes/.dev-lines/gpt6`；分支 `feature/unique-item-gpt6`；共同基线 `55d9297292db09ffc74497a1a4318ee724073ccc`。无 push/部署；未读取真实配置或其他路线；所有 HTTP 测试仅 localhost/fake。真实飞书/手机相机/共享协调为外部门禁。

same-session goal 已建立：`goal-0b8690b2-4cf4-4842-aa7c-7ced4fd750ff`，目标 S0–S5 全部代码、隔离验证和交付，而非方案止步。

## S0 — 已完成（1430714）

- 完整读取两份需求（78/718行）及只读统一验收矩阵（113行）。
- 检查现有字段映射、IDB/save/恢复、双向同步和 outbox 投影接线。设计见 `ITM_IMPLEMENTATION.md`。
- Node `v24.19.0`，npm `11.17.0`；现有 package-lock 保持不变。
- Node 只读解析父目录已有 fake-indexeddb/xlsx；未修改父 node_modules，无新增依赖。
- 测试命令：`set -o pipefail; npm test 2>&1 | tee test-logs/S0-npm-test.log`。
- 退出码 **0**，**511 tests / 511 pass / 0 fail / 0 skipped**，158485ms；完整日志保存在本 worktree，强制纳入 Git（仓库默认忽略 *.log）。
- 既有失败：无。静态发现 CLI 工单执行/冲销字段已有绊线测试标注缺口，后续不把其作为新 ITM 成果。
- `git diff --check` 通过。
- 本地提交：`1430714a7fc2b5ee86e9b953326b4a367bcd5b8a`。提交后已更新本进度文件，随下一阶段提交保留该 hash。

## 权限审核补充

用户授权必要的项目内开发/测试/本地 Git 权限由主会话审核；`/srv/416mes/.git/worktrees/gpt6` 为本路线 Git 元数据。遇沙箱拒绝记录原命令、路径及拒绝结果，仅按平台流程对原命令精确升级，不换路径规避；审批拒绝后停止该操作。其他路线业务代码、项目外修改、push/deploy、生产飞书及真实凭据仍未授权。S0 本地 Git 元数据审批已成功。

## S1 — 已完成（2a4a8f0）

- 新增 `lib/unique-items.js`：状态/关系/版本/权限校验，纯操作计划、显式出库清空、唯一代码、普通字段白名单，保持MAT隔离；index.html 启动迁移已接入。
- 新增 `lib/item-schema.js` 与 `ITM_SCHEMA.md`：四张相关表关键列/类型/单选只读验证；schema本身不宣称写权限。
- lib/feishu-api.js 拆分读/普通写/历史保护注册，操作表 JSON 双向和全量/增量读取；第九表普通写删在网络前拒绝。受控schema普通更新剥关键字段及 clearFields，新码和硬删禁用，旧未迁移八表兼容。
- 回应主会话可达性风险：补管理员 activateLocation/activateContainer 受控初始化计划与 LOC→CTN→ITM bootstrap 测试；后续 S3/S4接入页面与接口，未伪称已经可在UI操作。
- `npm test` 退出 **0**：**523/523**，0 fail/skip，75977ms，日志 `test-logs/S1-npm-test.log`。原测试未删改或跳过。
- 此轮全量启动后追加2个 localhost HTTP行为测试，单独执行 `node --test --test-name-pattern='ITM schema|ITM 第九表' test/feishu-api.test.js` 退出 **0**：**2/2**；日志 `test-logs/S1-http.log`。两者验证真实HTTP字段剥离/清空旁路/新码硬删拒绝与操作表全量增量读取；不把新增用例计入此前523。
- `git diff --check` 通过，无新增依赖。
- 阶段提交：`2a4a8f0ddc1a2b0509ab4efcb779e7ad89c283d8`，提交后更新本记录。

## S2 — 阶段实现与回归通过，提交中

- 已新增 `lib/item-persistence.js`：共享串行队列、生命周期 Web Lock 单写标签能力、state/outbox/draft 原子事务、未知结果保留、回执原子落盘、dirty LS 不覆盖 IDB 关系与命令、records镜像包含操作缓存。
- `node --test test/item-persistence.test.js` 退出0，6/6通过，使用 fake-indexeddb 实际事务与失败注入，日志 `test-logs/S2-persistence-initial.log`。
- 已接入网页普通保存串行队列与固定快照、IDB启动命令恢复、LS dirty关系保护，records清单补操作缓存；跨标签取得生命周期Web Lock，第二标签不写IDB/LS。仍需进一步页面行为验证与所有旧写入口只读屏障。
- 主会话复现的过期ACK回退缺陷已加回归修复：较新快照有匹配APPLIED日志时旧ACK只归档并清旧命令，不覆盖新版本；没有证明则保留命令；同版本异内容拒绝；递增ACK需匹配before。测试 `test-logs/S2-persistence-ack.log` 7/7通过，页面内联语法4/4通过。
- 已新增 `lib/item-sync.js` 并接 `fsMerge`/`fsThreeWayApply`：受控字段整组核验、APPLIED after证明、同版本异关系隔离、日志冻结载荷检查和append缓存；页面读注册补第九表并排除操作历史自动census删除。初测 `test-logs/S2-sync-initial.log` 12/12通过，尚需完善增量日志先后顺序及水位/原子提交验证。
- 主会话反馈悬空关系已修：APPLIED after也须存在唯一容器及唯一库位；full按LOC→CTN→ITM处理，增量按日志→LOC→CTN→ITM排序。`test-logs/S2-relations.log` 6/6通过，npm run check退出0。
- CLI开始复用ITM字段下行契约，读第九表，发现受控schema/载荷时拒绝CLI推送；尚待CLI行为回归及导入旁路完整收口。
- 工作中全量 `npm test` 退出0，538/538通过，84237ms，日志 `test-logs/S2-full-work-in-progress.log`；其后继续修改LOC歧义保护，因此不是S2最终门槛证据。
- 增量服务端补分页截断/循环游标/短页has_more判断，不完整不推进watermark；网页落盘成功后才保留新水位，失败回退水位。
- 无版本LOC v1限定管理员unknown→active单向核实，禁用/重新启用须未来带版本契约；历史disabled proof不能授权现状改变，不按数组顺序猜时序。普通队列显式拒绝自动重发itemOperation。
- 修复缺status旧schema把active LOC降为unknown；有效日志后到再次核验可解除暂时关联冲突，补行为测试。
- JSON备份包含IDB drafts/commands；导入命令只进入恢复审核，不自动重发；JSON/Excel关系作为待复核观察值，普通字段导入保留已确认关系。`test-logs/S2-import-sync.log` 33/33通过、内联语法4/4通过。
- 阶段全量 `npm test` 退出0：543/543通过、0失败/跳过，79868ms，`test-logs/S2-npm-test.log`；增加生命周期双标签锁模拟、确认/待提交投影分离、CLI真实fake进程禁写用例。
- 全量启动后追加网页实际函数VM+fake-indexeddb用例2/2通过：`test-logs/S2-page-persistence.log`。不是仅字符串断言：执行实际persistStateToIdb和fsThreeWayApply，检查队列快照、outbox/draft保留及关系隔离。
- git diff --check通过。S3将实际UI接入草稿/命令/投影和复核显示，S4接正式API；本阶段没有声称UI端到端或生产正式可写。
- S2提交号于提交后追加。

统一IDB保存队列、命令/state事务、LS恢复、受控字段组全量/增量和CLI封口。阶段门槛尚未完成。

## 后续

S2 持久化与全量/增量同步；S3 查询/严格扫码/真实一维fixture；S4 受控接口与持久协调适配协议；S5 页面完整链路及 LINE_REPORT。当前尚未声称这些阶段完成。
