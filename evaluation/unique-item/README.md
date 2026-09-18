# 主会话独立验收工具

这些文件位于主工作区，不是任何候选路线业务实现，也不替代候选自测。

- `fixture.json`：统一三码、状态、关系、前导零及MAT不变性夹具。均为合成数据，没有真实凭据。
- `inspect-candidate.cjs`：只读列出候选分支HEAD、阶段commit、改动与证据文件哈希。不会执行候选代码或测试，不访问网络，不修改worktree。
- `contract.cjs`：独立的只读查询预期计算器，明确未知/出库无当前位置、容器移库继承及重复码拒绝；不是候选应用实现。
- `contract.test.cjs`：验收工具自身的6条自检，已执行通过。候选适配完成前不能据此宣布任何候选功能通过。
- `gpt-domain.test.cjs`：对GPT路线早期未提交领域模块的7项独立探针，已执行7/7通过；只覆盖纯领域子集，不代表S1、UI或整条路线验收。候选文件变化后需重新执行。
- `gpt-schema.test.cjs`：对GPT早期schema验证器的8项独立测试，已执行8/8通过，覆盖缺关键列、错类型、缺单选项以及schema完整也不能单独开启写入。不代表真实飞书权限或生产协调已验证。
- `gpt-persistence.test.cjs`：S2迟到ACK首次复现失败后已复验修复：2/2通过，覆盖无证明不回退，以及存在新版APPLIED证明时保留新快照、记录旧回执并清原队列。仍需S2完整集成回归。
- `run-probes.cjs`：运行定向探针并采集前后HEAD/目标文件SHA256；若测试期间候选变化则标记不稳定，不将结果归属单一版本。
- `kimi-domain.test.cjs`：Kimi早期5项对抗检查首次全部失败（重复码、停用来源、缺失来源库位、换箱来源不符、旧节点自动active），已反馈修复，非最终评分。
- GPT S1提交 `2a4a8f0`：主会话重新执行npm test，后台任务bash-27，exit0，525/525通过、0失败/跳过；另独立领域+schema共15/15通过。此结果仅覆盖S1，后续同步/页面/API尚不构成通过。
- `glm-domain.test.cjs`：GLM早期领域查询对抗探针首次0/3通过，已复验为3/3通过（run-probes前后SHA256一致，f3c99339…）；重复码与出库残留位置问题已修复此子集，尚不代表完整S1。
- `gpt-sync.test.cjs`：S2早期同步探针发现APPLIED日志可让物品接受不存在的容器，首次失败已反馈；无序/无版本库位历史凭据存在歧义，测试要求不静默接受而非假定日志数组就是提交顺序。待修复复验。

用法：

```sh
node evaluation/unique-item/inspect-candidate.cjs glm
node evaluation/unique-item/inspect-candidate.cjs kimi
node evaluation/unique-item/inspect-candidate.cjs gpt
```

已在建立工具时执行语法检查和夹具唯一性/ITM无qty/MAT数量检查，通过；这不是功能验收通过。

具体行为规格见主工作区《三线统一独立验收矩阵.md》。

端到端证据必须分层标注：真实Chromium启动+真实IDB+拒写mock；linkedom+fake-indexeddb+localhost handler+内存repository；真实Repository适配器+fake飞书HTTP；真实隔离飞书/手机硬件。这些不能互相替代，组合覆盖也不应宣传成已执行同一条完整真实链路。

候选产生可运行实现后，主会话按各实现入口编写薄适配器，使用同一套场景对外部行为进行独立验证，避免只检查私有函数名或页面字符串。

所有后续HTTP测试使用隔离localhost fake服务。不得直接运行历史`.verify`目录中的生产核验/清理脚本，不得读取或加载真实飞书配置。
