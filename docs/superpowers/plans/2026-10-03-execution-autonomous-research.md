# 执行线与自主研究线：第一期 Implementation Plan

> **For agentic workers:** 本计划仅供设计评审，状态 **Proposed / 未执行**。书面设计与计划获准后，使用 superpowers:executing-plans 逐任务实施并独立复审；本 PR 不启动实现。

**Goal:** 用离线、确定性 fixture 证明自主研究循环与执行线的边界、恢复和采纳契约。

**Architecture:** 独立宿主 ResearchCoordinator 持有 research.db；worker 仅提交结构化步骤建议。预算、证据和采纳决定由宿主验证。第一期不接生产 service、真实模型或联网 provider。

**Tech Stack:** 既有 Node >=22.13、ESM、node:sqlite、node:test；不添加运行依赖。

**Spec:** [ADR-010 Proposed](../../adr/ADR-010-execution-autonomous-research.md)。以下模块、方法和测试路径均为**拟新增**，不是基线现有接口。

## Global Constraints

- ADR-010 D1–D7 全部适用；不改现有 Broker/HostTaskRunner 行为、执行 schema、工具目录、preset、批准策略或 Accepted ADR。
- 初期 scope：600000ms / 24 步 / 6 假设 / 12 实验尝试 / 20 资料 / 10485760 字节 / 并发 1 / 单实验 10000ms / 费用 0 / 网络请求 0。
- 禁止运行真实模型/目标、访问秘密、增加 shell/fs/HTTP 或发布/部署；只用合成或已批准非敏感语料。
- 全部接口为 host-only；scope / 决策的身份由可信调用边界提供，worker 参数不授予权限。
- 新 test 数字只在未来实测后更新；此设计 PR 不增加测试、不刷验收绿灯。

## Review Focus

1. 跨线/跨研究/task-command 别名：拒绝前不得产生另一条线副作用（Task 1/4）。
2. 领取后丢结果：保持 unknown 与预算预留，不能重启后再跑（Task 2）。
3. 资料伪装控制指令/完成证据：来源标签不成为权限，推理不升级事实（Task 3）。
4. 预算并发竞争与未知费用：预留原子化，耗尽无下一步骤（Task 2）。
5. 候选已过期/重复采纳/取消迟到：旧结论和成功回包不能覆盖新状态（Task 3/4）。

## Task 1: 独立 scope 与研究存储

**Files:** Create `packages/warroom-core/src/research-contract.js`、`research-store.js`；Test `test/research-store.test.js`。

**Interfaces（拟议）:** `validateResearchScope(scope) -> normalizedScope`；
`ResearchStore({home}).register(scope, trustedParent) -> researchRecord`；
`getOwned(identity) -> record`；`appendEvent(identity, event) -> {accepted, duplicate}`；`close()`。
identity 为 ADR-010 D2 全键；scope 包含 D1 全部字段及有限 limits。宿主分配 ID，传入模型 ID 拒绝。
`reviseScope(identity, trustedUserDecision) -> {oldVersion, newVersion, affectedAttempts}` 原子冻结旧版本，保留旧记录；
撤销决定绑定 user_message_id，affectedAttempts 交 Task 2 取消。scope 版本变化不释放未知预算预留。

- [ ] 写负例：缺范围/上限、无可信父身份、跨 owner/lane、task-command 别名、篡改摘要；断言拒绝且执行库摘要未变（R2/R9）。
- [ ] 跑 `node --test test/research-store.test.js`，记录缺模块/契约未满足的 RED。
- [ ] 实现独立 schema v1、宿主 writer 和 scope 完整性；新库初始化仅在 register 显式调用时发生；scope 版本更新不能覆盖旧记录。
- [ ] 同一命令登记、重复事件和乱序修订幂等；测试非 writer 拒写、高版本拒绝、重开库身份/记录相同。
- [ ] 重跑同文件，全部通过后提交；不引入 production service 连接。

## Task 2: 有界循环、计量与恢复

**Files:** Create `packages/warroom-core/src/research-coordinator.js`、`research-templates.js`；Test `test/research-coordinator.test.js`。

**Interfaces（拟议）:** `ResearchCoordinator({store, worker, clock, templates})`；
`tick(researchIdentity) -> Promise<stepSummary>`；`cancel(identity, reason) -> record`；
`reconcile(identity) -> record`；`applyScopeChange(change) -> cancellationSummary`；
`onLinkedAuthorizationChange(engagementId, authVersion) -> cancellationSummary`；`dispose() -> Promise<cleanupSummary>`。
`worker.next(frozenView, {signal, deadlineMs, maxBytes}) -> Promise<proposal>` 仅返回 question/hypothesis/preregister/experiment/analyze/finish 六类。
`templates.run(templateId, input, {signal, deadlineMs, maxBytes}) -> Promise<artifactReceipt>` 仅固定纯数据变换/事件回放；
输入和返回均按 D3/D4 校验；拒绝脚本、命令、任意 URL 和动态模块。
tick 启动一步或观察事件即返回，不等待 worker 结果；clock 提供 now/定时截止事件，宿主持有取消句柄。
dispose 有界返回收口摘要；未响应取消的 worker 为 unresolved，保留预留/槽位且不启动替代项。

- [ ] 写 R3/R5/R6/R7 RED：三假设带反证自主迭代；同研究并发领取恰一次；24 步后无第 25 步；时间/字节/尝试等各限值边界；unknown 不释放预留；连续两错停止；取消迟到不 completed。
- [ ] 用可控时钟、挂起 Promise、双 SQLite 连接和合成回执跑 `node --test test/research-coordinator.test.js`，保留失败证据。
- [ ] 实现预注册冻结、原子领取/预留、步骤事件和结算；每 tick 有界且不阻塞执行服务；无真实子进程、无网络、无模型调用。
- [ ] 在领取前/后、结果持久化前/后中断并重开；未领取可继续，已领取无可靠结果为 unknown；只查询研究产物对账；旧代/外来事件隔离。
- [ ] 用忽略 AbortSignal 的挂起 worker 验证 tick/dispose 不超单步骤截止时间，晚到回调隔离；预留和槽位保留，不能无限等或创建替代 worker。
- [ ] 可信 scope 撤销/更新与关联 auth_version 变化触发旧版新步骤拒绝、在飞取消和 needs_decision；worker 自报撤销/新批准无效，无关战役变化不影响独立研究。
- [ ] 验证资源声明、停止证明及满额截断；fixture 的空资源不能冒充未来有资源模板已停。
- [ ] 重跑同文件并提交；所有数字断言使用 Global Constraints 精确值或显式更小的冻结限额。

## Task 3: 来源证据与候选采纳

**Files:** Create `packages/warroom-core/src/research-evidence.js`、`research-candidates.js`；Test `test/research-evidence.test.js`、`test/research-candidates.test.js`。

**Interfaces（拟议）:** `admitEvidence(store, identity, sourceRecord) -> admission`；
`publishCandidate(store, identity, candidate) -> candidateRecord`；
`decideCandidate(store, candidateRef, trustedHumanDecision, currentExecutionSnapshot) -> decisionRecord`。
candidateRef 绑定 id/revision/digest；人工决策绑定 user_message_id / decider / decision / reason。
决定只记交接输入，不调用 Broker。读取执行快照的 adapter 是只读 fixture。
`readAuthorizedSnapshot(researchIdentity, engagementId, expectedAuthVersion, trustedReadDecision) -> snapshot`；
trustedReadDecision 绑定 research_id / parent / engagement_id / auth_version / 可读字段 / 有效期 / user_message_id。
导出与采纳分别核验，不把关联 ID 或模型请求当权限；第一期由固定人工 fixture 提供决定。

- [ ] 写 R4/R8 RED：资料要求扩大 scope/调用工具/伪完成/泄漏合成敏感串；无来源、自报 verified、冲突和不利结果都不能改控制记录。
- [ ] 写候选负例：无人工决策、错误 digest/owner、旧 scope 或快照、重复决定、取消后的迟到候选；实际派发计数始终 0。
- [ ] 写快照读负例：跨战役/父身份、缺读取决定、错误 auth_version、超字段或过期；不得返回资料或触发 Broker；有效决定仅返回白名单快照，采纳时权利失效仍拒绝。
- [ ] 运行 `node --test test/research-evidence.test.js test/research-candidates.test.js`，保存 RED。
- [ ] 实现来源、修订和摘要校验、出口脱敏、隔离原因与反证留存；patch 为候选文本，不写产品工作区或 addPoc。
- [ ] 实现候选版本绑定与采纳幂等，有效 accept 恰一次成为待计划输入；reject/defer 保留证据和原执行目标。
- [ ] 重跑同测试文件并提交；复核未知/推理不会被标成已验证观察。

## Task 4: 离线双线集成与文档证据

**Files:** Create `test/research-independence.test.js`、`docs/reviews/research-phase-one-validation.md`；Modify `docs/ACCEPTANCE.md` 的 Proposed 项及实测计数（仅未来执行后）。

**Interfaces（拟议）:** 消费 Tasks 1–3；模拟 execution scheduler 与 parent delivery，使用既有身份/notice 去重原则，独立 research outbox；不修改 `createWarroomService()` 或 `host-tasks.js`。

- [ ] 写 R1/R2/R8/R9 RED：研究 worker 挂起时执行事件和用户新回合继续；跨线取消无效；候选不自动派发；研究未启用无执行迁移。
- [ ] 运行 `node --test test/research-independence.test.js`，保留 RED 后完成 fixture；outbox 投递丢回包/重启去重，失效父身份留待处理，不能投给同名新会话。
- [ ] 研究库及产物清单备份往返保留预算、反证、游标和 unknown；禁用研究不删账本或停执行线。
- [ ] 对应 R1–R9 逐项录版本/证据/pass/fail/skip；独立 reviewer 审身份、控制边界和状态可测性，修复后复核。
- [ ] 只运行经逐项确认无害的范围测试、文档链接/静态门禁；更广 repo CI 必须先核当前测试安全性，未跑项显式记原因，不弱化守卫。
- [ ] 更新实测文档数字和验收证据并提交后续实现 PR；不能以离线绿灯声称生产/真实模型/长期自主运行已通过。

## 实施前审阅与后续接入

ADR-010 §7 的预算例外、provider、生产调度指标和保留策略需逐项决策。
第一期不需要 provider 或生产接入决定即可审阅离线设计，但实现本计划仍需书面设计/计划批准。
真实研究 worker、联网来源及 production service 接入另开方案和 PR，不能由此计划自动推进。
