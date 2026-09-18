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

## S1 — 已通过，提交中

- 新增 `lib/unique-items.js`：状态/关系/版本/权限校验，纯操作计划、显式出库清空、唯一代码、普通字段白名单，保持MAT隔离；index.html 启动迁移已接入。
- 新增 `lib/item-schema.js` 与 `ITM_SCHEMA.md`：四张相关表关键列/类型/单选只读验证；schema本身不宣称写权限。
- lib/feishu-api.js 拆分读/普通写/历史保护注册，操作表 JSON 双向和全量/增量读取；第九表普通写删在网络前拒绝。受控schema普通更新剥关键字段及 clearFields，新码和硬删禁用，旧未迁移八表兼容。
- 回应主会话可达性风险：补管理员 activateLocation/activateContainer 受控初始化计划与 LOC→CTN→ITM bootstrap 测试；后续 S3/S4接入页面与接口，未伪称已经可在UI操作。
- `npm test` 退出 **0**：**523/523**，0 fail/skip，75977ms，日志 `test-logs/S1-npm-test.log`。原测试未删改或跳过。
- 此轮全量启动后追加2个 localhost HTTP行为测试，单独执行 `node --test --test-name-pattern='ITM schema|ITM 第九表' test/feishu-api.test.js` 退出 **0**：**2/2**；日志 `test-logs/S1-http.log`。两者验证真实HTTP字段剥离/清空旁路/新码硬删拒绝与操作表全量增量读取；不把新增用例计入此前523。
- `git diff --check` 通过，无新增依赖。
- 阶段提交 hash 在提交后追加。

## S2 — 下一阶段

统一IDB保存队列、命令/state事务、LS恢复、受控字段组全量/增量和CLI封口。阶段门槛尚未完成。

## 后续

S2 持久化与全量/增量同步；S3 查询/严格扫码/真实一维fixture；S4 受控接口与持久协调适配协议；S5 页面完整链路及 LINE_REPORT。当前尚未声称这些阶段完成。
