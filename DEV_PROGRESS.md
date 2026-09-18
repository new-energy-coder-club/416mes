# GPT-6 独立路线开发进度

## S5.1 — 限定四项补齐（基线cfc6b44）

主会话明确授权，仅新增导入命令只读复核/查询、未解冲突面板与安全重拉、旧LOC/CTN五类批量生成封口、pending/out管理员retire UI。不扩LOC禁用协议，不新增后端产品。客户端inspect为纯GET只读，不acknowledge/markUnknown，不入队。查询结果仅显示原opId结果。safe refresh不调用fsBoot/flush/push，只GET拉取、字段组校验、本机保存。

`node --test test/item-s51.test.js test/item-client.test.js test/item-ui.test.js` 16/16通过，退出0，`test-logs/S51-focused.log`。包含四项实际DOM/生成handler执行及只读GET验证；内联语法4/4通过。完整初次回归581/581通过（S51-npm-test.log）。主会话指出旧schema误封停，已改真实门禁：保存全量remote.columns，schema含受控列/存在已确认版本身份/显式开启新模式才拦截；旧unknown/v0无标记不拦。safe refresh改stateSaveQueue任务执行时取最新快照，事务完成才发布，不在队列外预先修改state。修订后完整回归 **581/581通过，退出0**（S51-final-npm-test.log，94681ms）；浏览器 **1/1通过，退出0**（S51-browser.log，pageErrors空，外网阻断）。git diff --check通过，全部后台job已收集。四项限定补齐完成，提交后冻结。

same-session goal已改为S5.1，但平台拒绝resume（用户必须恢复paused goal）；不绕过，按本次直接人类授权实施，结束后冻结。

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

## S2 — 已完成（c501249）

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
- S2提交：`c501249479cf608ae5a2a6494446e6b2f623f058`。

## S3 — 已完成（1db6ca0）

阶段提交：`1db6ca0961bad21ca886ecf6bd616c06d9c7eefd`。后续S4接受控API，S5补浏览器全链路。

已新增 `lib/item-scan.js` 严格行会话状态机与 `lib/item-ui.js` 查询/草稿控制器，index导航和实际独立查询/作业区已挂载。支持三级下钻、固定数量1、LOC→CTN→ITM、入/出/换箱/容器定位移库、行代际和稳定opId、本机草稿/命令保存。当前S3继续：安装本worktree锁版ZXing0.21.3(MIT)与dev linkedom0.18.12(ISC)，未改父依赖；离线浏览器vendor 336008bytes。Code128合成RGBA fixture实际解码+扫码状态机5/5通过（首次fixture checksum错误已修77，非mock输出），`test-logs/S3-barcode-scan.log`。相机帧接jsQR/Code128并绑定行token，权限失败手输降级。

DOM实际点击查询前缀/裸码跨类型歧义候选/三级下钻2/2通过，`test-logs/S3-dom-retest.log`；初测linkedom select.value只读，改option.selected后通过。草稿恢复按钮已接scan.restore；IDB入队失败解锁但保留opId。

真实第九表已建的信息仅记为外部事实，tableId/schema未核验，不访问生产。真实第九表已建的信息仅记为外部事实，tableId/schema未核验，不访问生产。

S3增补：未持久化失败可同opId原载荷重试，reset改变意图清旧opId，已锁定不可重扫；ITM步骤可精确识别唯一已建档WP裸码，拒绝EAN猜测。DOM真实草稿保存/恢复、双击仅一命令、IDB失败不谎报通过；查询/扫码/Code128共11/11，`test-logs/S3-ui-scan.log`。离开页签/pagehide停止相机。全量回归退出0，556/556通过，111428ms，日志S3-npm-test.log。随后修复cameraGeneration/启动行绑定、切行停止、迟到授权释放流、旧tick不重设timer；新增可控mediaDevices Promise用例，DOM5/5通过（S3-camera-lifecycle-retest.log）。测试初次注入linkedom navigator未生效，改显式mediaDevices依赖注入后验证真实异步分支。S3已提交，真实硬件仍待验证。


## S4 — 已完成（227b962）

阶段提交：`227b962001c500e0ca920bb865253cc53d919851`。

新增lib/item-operation.js共享协调协议执行器与POST/GET handler、本地同路由；生产默认无认证/无协调拒绝，未提供内存生产适配器。PREPARED前持久意图、回读after、APPLIED，超时保留全局未决屏障，恢复不重做实体。独立实例共享测试fixture 7/7通过（test-logs/S4-protocol-initial.log），包含同opId异载荷、并发、日志创建未知、实体before不重试、实体成功终态失败恢复。fixture位于test/，只是协议模拟，不证明生产持久性。新增lib/item-repository.js真实飞书API仓储（映射read/prepare/apply/回读/finish、专用显式清空），lib/item-runtime.js部署组合工厂；默认handler使用真实仓储组合但无认证协调禁写。GET/重复POST可见范围为本人或admin/service，缺roles返回403；协议8/8通过（S4-auth-protocol.log）。新增item-client与页面每命令“提交原命令/查询原opId”按钮，回执经IDB成功才显示完成，未知保留命令。仓储localhost HTTP实际prepare/apply/readAfter/finish往返1/1通过，S4-http-repository-retest.log。首次PREPARED空finishedAt触发mock日期拒绝，已在专用prepare过滤未设置的可选字段；业务清空仍apply显式保留。exactRaw/operations改listRecordsEx完整性闸门，token每次走API缓存，2项仓储/默认handler通过。客户端15秒Abort+未知持久化，ACK/未知标记双失败不虚报成功，3/3通过S4-client-timeout.log。ITM_RUNTIME.md定义真实仓储部署工厂、授权范围与外部持久协调方法；S4全量回归退出0，572/572，120255ms（S4-npm-test.log）。随后补response.json挂起也在timeout竞赛内，客户端4/4通过S4-client-body-timeout.log；git diff --check通过。S4已提交，真实认证/协调未配置保持默认禁写。

## S5 — 冻结候选交付（已完成项与限制详见LINE_REPORT）

最终 `npm test` 无代码/测试修改复跑 **577/577通过，退出0，89747ms**：`test-logs/S5-final-npm-retest.log`。原MAT并发断言单独复跑1/1通过，保留先前失败日志，不隐瞒偶发。独立 `npm run test:browser` **1/1通过，退出0**：`test-logs/S5-browser-routes.log`；所有相关后台任务已收集，服务由测试清理。按主会话指示停止扩功能，已知功能缺口与外部门禁明确列入LINE_REPORT。S5代码提交：`231993e054d5b1f466c5b4aeb69ecd81cc974e47`；随后仅文档登记提交号，不再修改候选代码。

新增test/item-browser.test.js完整index.html Chromium启动（非仅组件mount），导航前拦截全部外网/全部API仅fixture；390px查询→扫码→真实IDB草稿→reload恢复→命令保存→禁写API→未知保留，MAT7不变，pageErrors为空。初次load等待超时，加原生dialog处理和domcontentloaded后完整通过，S5-browser-retest.log；被阻断旧默认远端origin仅记录，未放行外网。锁版playwright-core1.58.2为dev依赖，使用系统Chromium，不改全局环境。仍需完整fake仓储→另一客户端闭环及最终报告/回归。

S5补管理员LOC/CTN核实UI待提交入口（服务端权限仍强制），DOM7/7通过S5-admin-ui.log。服务端LOC active也要求激活凭据，真实仓储单链复验通过。新增LINE_REPORT.md验收中报告，明确不同E2E证据范围与未完成项，未宣称最终交付。

S5新增受控registerItem/registerLocation/registerContainer及管理员UI随机唯一码申请。LOC/CTN飞书状态留空normalize unknown，不增加单选unknown；ITM pending/v1。普通资源新增与物品生成器转受控入口，普通编辑剥关系。真实Repository→fake HTTP三实体建档→LOC/CTN核实→receive→issue→第二端pull完整行为通过S5-register-bootstrap-chain.log。尚需最终全量、浏览器与diff回归。

S5全量Node首次576/576通过（S5-npm-test.log），同时浏览器受120秒总时限取消（S5-browser-final.log），未计通过；后续独立路由调整后需重跑。查询/作业现拆为items与item-work独立section，查询相机只填检索，不写scan；多行表格显示三码/操作/状态、按opId显示APPLIED/REJECTED、点击切行；DOM8/8通过S5-query-rows.log。尚未最终提交。

## 后续

按主会话最新指示冻结候选，已知缺口在LINE_REPORT单列不掩盖。独立浏览器串行重跑通过1/1（S5-browser-routes.log），真实IDB/390px/refresh/默认拒写，pageErrors空，所有外网阻断。git diff --check通过；最终Node回归首次577项中576通过、1失败：原MAT四段预读并发断言maxConcurrent=3未达4，S5-final-npm-test.log完整保留；该MAT实现未改，本次不削弱测试，正在单独与全量无改动复跑，暂不声明最终通过。DOM→真实fake-IDB→localhost handler→模拟仓储→另一客户端字段组闭环已通过，MAT保持7；加扫码完成后突发ITM/CTN/LOC冲突均拒绝确认，S5-e2e-conflict.log 8/8。真实HTTP仓储额外验证手改同版本关系被server snapshot隔离。端到端模拟仓储与真实HTTP仓储分别验证，尚不混称单一完整浏览器真实飞书链路。
