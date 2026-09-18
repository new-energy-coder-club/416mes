# GPT-6 独立路线冻结候选交付报告

## 状态

工作区 `/srv/416mes/.dev-lines/gpt6`，分支 `feature/unique-item-gpt6`，基线55d9297。S0 1430714、S1 2a4a8f0、S2 c501249、S3 1db6ca0、S4 227b962。按主会话指示冻结候选供统一独立验收；S5测试与报告收束，不代表全部功能矩阵无缺口或批准上线。最终HEAD见DEV_PROGRESS及Git日志。

## 实现架构

- `unique-items`领域纯函数与`item-schema`九表契约；旧记录unknown，一码一件、无qty，MAT/WIP不改账。
- `item-persistence`复用mes416-state v1七store，命令/state/draft事务、统一保存队列、单作业标签Web Lock、LS脏恢复保护，未知命令不删除。
- `item-sync`全量与增量受控字段组及操作缓存核验；显式清空、同版本异值、悬空关系、缺列和日志缺失隔离。
- `item-ui/item-scan/item-barcode`实际index导航页，三级只读查询、严格序列/行代际、草稿恢复和命令API入口，ZXing真实Code128，管理员LOC/CTN核实入口。
- `item-operation/item-repository/item-runtime`：服务端身份、幂等摘要、共享认领、PREPARED/回读/APPLIED、未知屏障、保守恢复；真实飞书仓储不只测试stub。

## 可启用范围与外部门禁

查询、扫码与本机草稿可用；正式多端写默认关闭。handler无认证/协调返回401/503，不因设置单一flag就绕开。生产共享协调实现及身份提供者尚未配置，协议fake适配器仅在test目录。用户已建第九表不代表表ID、schema/字段ACL已验证；没有访问它。

真实Android/iOS/飞书内置浏览器相机、现场标签/打印、隔离飞书真表权限/分页以及生产/Preview命名空间验证均为EXTERNAL_GATE。

LOC v1没有revision，限定unknown→active管理员核实；禁用/重新启用需要未来版本化契约，不能用无序历史proof猜现状。服务端active LOC须匹配activateLocation日志；CTN/ITM受控版本须匹配APPLIED after。旧schema普通八表兼容，但扩列后通用写不能覆盖关系或硬删。

## 测试证据范围（不得混称）

1. `npm test`：Node领域/IDB/DOM/localhost HTTP回归。S5最终577/577通过，退出0（test-logs/S5-final-npm-retest.log）；首次末轮原MAT并发断言偶发maxConcurrent=3失败，未修改测试或MAT实现，单项及全量复跑通过，失败日志保留。
2. `npm run test:browser`：系统Chromium整个index启动、真实IndexedDB、390px、reload恢复、API全503。所有非本地origin在导航前拦截，未访问生产。缺Chromium明确FAIL而非skip；最终串行复跑1/1通过（test-logs/S5-browser-routes.log），此前并行总时限取消日志也保留。
3. `item-e2e.test.js`：linkedom+fake-indexeddb+localhost handler+内存repositoryFixture→另一客户端；验证组件成功链，不是真实飞书仓储。
4. `feishu-api.test.js`的ITM real repository：fake-indexeddb适配器→客户端→localhost handler→真实Repository→localhost fake飞书→第二端pullState/字段组，成功APPLIED/清空/命令出队；另验证三实体register→LOC/CTN启用→receive→issue→第二端同步。不是整页Chromium成功链。
5. Code128 fixture为合成条宽光栅，真实ZXing像素解码，不是mock文本；不等于手机硬件通过。

## 依赖

见ITM_DEPENDENCIES.md。ZXing0.21.3 MIT（浏览器336008bytes），linkedom0.18.12 ISC dev，playwright-core1.58.2 Apache-2.0 dev。均锁版，本worktree独立node_modules，不改父目录依赖。

## 升级/回退

- IDB不改名不升级；先导出JSON（含draft/command）和旧表备份。
- 按ITM_SCHEMA.md加列/操作表，人工核实权限。缺schema关闭正式写。
- 旧LOC→CTN→ITM按管理员核实，不批量猜归属；MAT不自动拆件。
- 停用正式入口前导出并列出未决opId，未知请求保持协调屏障。不得清outbox或操作表假装完成。
- UI回滚不撤销已确认业务事实，不放开旧通用upsert覆盖关键字段。保留新列/历史，只读回退优先。
- 生产发布不在本授权；本路线没有push/deploy。

## 已知功能限制与未执行项

- 未提供真实持久协调服务/生产认证实现；必须完成ITM_RUNTIME.md外部适配验收后另行启用，不能上线即写。
- LOC v1仅unknown→active；停用/重新启用需要后续版本化契约。retire有领域/协议但尚无专用UI按钮。
- 原批量LOC/CTN布局生成器仍为旧档案路径，扩列后的服务端禁止通用建档；正式唯一实体应从新管理员注册入口申请，旧批量生成结果不可当正式云端确认标签。
- 独立查询相机与多行表格已接线；手机表格横向滚动，并非专用移动卡片；真机相机未验。
- JSON导出包含itemRecovery，但导入仅保存到state.__itmRecoveryReview，未提供专用复核UI；不能称跨设备命令恢复完整闭环。人工处理：保留原JSON，逐opId通过授权GET查询，核对原request/before/after；未确认不得enqueue或换ID重发。当前普通UI不自动展示该审核字段，此为功能缺口。
- 冲突/导入审核数据已保存并阻断作业，但专用人工修复向导未实现；需保守停写并由管理员核验，不能用普通字段裁决改受控关系。
- 全页Chromium目前验证API拒绝链；成功真实仓储链为fake-indexeddb适配器+Node HTTP，不是整个Chromium对fake飞书成功链。
- 查询/本地草稿可用，不据此承诺所有统一矩阵项目均PASS；主会话独立验收拥有最终结论。

## 候选冻结

按主会话指示冻结当前功能范围，保留上述缺口，不再把功能限制包装成外部全部已完成。最终Node/浏览器结果及S5本地commit由DEV_PROGRESS记录。独立验收结论归主会话，本报告不替代其验收矩阵。
