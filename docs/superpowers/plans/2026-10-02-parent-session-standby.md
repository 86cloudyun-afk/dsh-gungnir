# Parent Session Standby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Native execution was authorized by the delegated request; independent review follows implementation.

**Goal:** DSH 派单登记立即返回，宿主可靠观察并通知正确父会话。

**Architecture:** broker 保留 CLI 路径并新增宿主登记路径。宿主服务持有调度器与通知日志，filebridge 支持非阻塞写入和只附着恢复；通知通过已核实的 DSH followup/持久会话 API 去重。

**Tech Stack:** Node >=22.13、内置 SQLite、node:test、现有 JSON filebridge；无新增依赖。

**Spec:** [ADR-005](../../adr/ADR-005-host-owned-task-notifications.md)

## Global Constraints

- 保持 36 个 warroom 工具、allow/deny、角色、权限、预算与幂等约束。
- Accepted ADR-001–004 不变；仅本机隔离分支，离线无真实模型/目标/部署。
- 禁止 push/PR/merge；不访问秘密，不修改持久安全设置。

## Review Focus

- 崩溃在 attempted 标记和 spool 写入之间：unknown，不能自动重派。
- 通知接受但 delivered 尚未登记：父会话持久日志去重。
- 异步 flush 期间父 agent 被替换或销毁：重新验证身份与活动状态。
- facts/probes 与 status 代际不一致：拒收，停止证明保持 unresolved。
- 工具或插件卸载：后台宿主收敛后关闭 DB，不遗留工具拥有的 Promise。

### Task 1: 持久登记与非阻塞桥

**Files:** broker.js、db.js、migrate.js、version.js、adapters/dsh-bridge.js、adapters/redteam-mode.js；test/host-tasks.test.js。

**Interfaces:** `broker.execute(req, {deferDispatch, parent}) -> queued`；`broker.dispatchQueued(command_id)`；`adapter.hydrate()` 只附着；桥 source observation 保留 generation/event_seq。

- [x] 写失败测试：派单返回 queued 且 worker 未完成；无 Atomics.wait；相同父幂等与异父拒绝；恢复不 spawn；缺/旧 source generation 不伪造。
- [x] `node --test test/host-tasks.test.js` 必须出现预期断言失败。
- [x] 实现最小持久登记、重新授权检查、宿主桥 enqueue/attach 与源回执。
- [x] 跑目标测试和既有 bridge/wave 回归；登记证据后提交。

### Task 2: 宿主观察与父通知

**Files:** 新 host-tasks.js、host-delivery.js；service.js、tools.js、dsh-entry.mjs；test/host-tasks.test.js、test/host-delivery.test.js。

**Interfaces:** `HostTaskRunner.tick()/start()/dispose()` 由服务持有；`createHostDelivery(ctx).deliver(owner, notice)` 检查身份、用户优先与持久去重。

- [x] 写失败测试：忙闲完成通知、丢通知/重复乱序/重启、取消完成竞态、旧 attempt/撤销、父销毁/替换、逐项资源缺证据、flush 期间替换、卸载收敛。
- [x] 分组运行，确认每项预期失败。
- [x] 实现源事件游标与通知事务、取消登记/证实、宿主生命周期、原父投递、DSH context 接线。
- [x] 目标套件与 CLI wave/policy 回归通过后提交。

### Task 3: 应答器协议与交付验证

**Files:** scripts/dsh-bridge-responder.mjs、相关 fixture 测试、commander.md、DSH-BRIDGE-PROTOCOL.md、ACCEPTANCE.md。

**Interfaces:** generation/event_seq 输出；持久领取标记；完成写序；重启不再执行 executor；取消不伪造停止证据。

- [x] 写失败测试：惰性 executor 跨进程重启不重执行、完成 source provenance、stop 不伪造资源证据。
- [x] 确认失败后实现最小协议增量；更新 commander 待命约定与验收证据。
- [x] 运行完整 `node --test` 和六闸；环境失败明确记录，不能静默跳过。
- [x] 发给独立 reviewer；修复重要问题须 RED→GREEN；输出本地提交、format-patch、验证记录与未运行项。

## Execution Outcome

Three implementation tasks completed as one dependency-coherent local patch; commits deferred until all six gates passed.
Final: 503 tests, 497 pass, 0 fail, 6 native-environment skips; five static gates passed.
Independent review reproduced eight Important findings; all fixed with RED→GREEN regressions and independently closed.
See [validation](../../VALIDATION-PARENT-STANDBY-2026-10-02.md) and [review](../../reviews/2026-10-02-parent-session-standby.md).
No publication or real runtime acceptance was performed.
