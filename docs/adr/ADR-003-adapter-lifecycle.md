# ADR-003 Adapter 生命周期

- 状态：Accepted · **rev2**（2026-10-02 复核收敛）
- 修订记录：rev3 = 「取消幂等」补一条例外——清单里仍有未证实停止的资源时，取消请求必须发出停止动作并逐项证实（见 [ADR-009](ADR-009-terminal-state-and-resource-settlement.md)）；rev2 = 派发幂等（command_id 先持久化后派发、可按 ID 找回）；停止证明改为**资源清单
  逐项证实**；generation 比较范围限定为同任务执行尝试。rev1 = 状态机增补、取消与证实分离、探针证明。
- 关联：[WARROOM-FRAMEWORK.md](../WARROOM-FRAMEWORK.md) §3.6；ADR-001（撤销、时间窗）、
  ADR-002（op_log、代际、回执幂等）

## Context

v1.1 SPI 仍有两个缺口：dispatch 只有成功返回才拿到 task_id，若执行器已接收任务而响应丢失，
控制端无法查询、取消或恢复它（重启后更无从下手）；停止证明允许「至少一项匹配证据」，但任务可能
同时持有会话、子进程与容器——主会话停了容器还在，不等于任务停止。此外 generation 的比较范围
未限定。超时默认失败会诱导重做，渗透动作重做的代价是重复告警、账号锁死甚至破坏性副作用。

## Decision

**D1 方法集与派发幂等（rev2）。**

```
dispatch(command_id, contract) -> task_id   # 幂等：同 command_id 永远映射同一任务
lookup(command_id)             -> task_id | not_found
status(task_id|command_id)     -> {state, generation, progress?}
cancel(task_id|command_id, reason)          # 请求取消：幂等
collect(task_id)               -> receipt   # 成员级幂等（ADR-002 D5）
reconcile(task_id)             -> final_state
```

- **派发前**，broker 将 `command_id`（ULID）+ 契约持久化到本地队列（global.db op_log 同源），
  然后才调用 adapter。adapter 契约：已接收的 command_id 重复派发必须返回原 task_id。
- 「任务已启动、回包丢失」场景：控制端重启后凭 command_id `lookup` 找回并接管，全局恰有一个任务。
- command_id 与 task_id 在 status/cancel/collect 中可互换使用。

**D2 状态机（rev1 承继）。**

```
非终态：queued → running；running → cancel_requested；running → unknown
挂起：  unresolved（取消或未知未能证实/定论 → 人工队列）
终态：  done | partial | failed | cancelled | confirmed_stopped
```

`unknown` 显式非终态；`partial` 附已完成/未完成清单。

**D3 未知语义。** 超时、断联、崩溃 → `unknown`，绝不自动判 failed、绝不自动重做。
reconcile 定论依据（优先级序）：执行器回执 > 目标侧只读再探测 > 本地产物比对 > 人工确认；
带 `reconciled_by` + 证据引用。

**D4 取消与证实（rev2：资源清单逐项证实）。**
- dispatch 时登记**任务资源清单**（resource manifest）：adapter 会话、内部子任务、host 子进程、
  隧道端口、容器 id——已知形态全列；运行中新发现资源增量登记。
- `cancel` 只是请求 → `cancel_requested`，向下传播到清单各项。
- **`confirmed_stopped` 要求清单逐项证实**：每个条目探针通过（进程 PID 无、端口实测关闭、
  容器 inspect 终态、会话结束回执）方可确认；**任一条目未证实 → `unresolved`**——
  「主会话已停但容器仍在」不得记为已停止。
- 不可取消组件必须在派发时登记进清单并标 `must_clean_manually`，报告附录可见。
- cancel 幂等；对已终态任务返回当前终态。

**D5 撤销/时间窗级联。** auth_version bump 或窗口到期 → broker 对全部非终态任务发 cancel →
逐项证实至 `confirmed_stopped`；证实失败 `unresolved` 入人工队列——级联即告完成（撤销立即生效），
终态汇总落 gate_log（含 unresolved 计数）。

**D6 结果代际（rev2：比较范围）。** generation = (auth_version, dispatch 序号, attempt 序号)，
**只在同一 task_id 的执行尝试之间比较**；跨任务的顺序语义由 ADR-002 的 revision_no 与 seq 承担。
collect 只接受当代回执入状态，旧代进隔离区。

**D7 redteam-mode adapter 映射（v0.1 唯一实现）。**

| SPI | redteam-mode 映射 |
|---|---|
| dispatch(command_id) | command_id 入 broker 队列 → 指挥角色派单（scope_contract + 三因子） |
| lookup | broker 队列表按 command_id 反查 task_id |
| status | 会话/资产 test_status 查询 + 子代理运行数 + 资源清单状态 |
| cancel | `/stop` → cancel_requested；资源清单逐项探针 → confirmed_stopped |
| collect | fact 落库查询 → receipt（source_key 见 ADR-002 D5） |
| reconcile | 资产 test_status 回查 + 隧道连通性实测（host 层探针）+ 清单残项核对 |

## Consequences

正面：「启动了但没收到回执」「重启后接管」「部分资源残留」三类真实故障有确定语义与恢复路径；
停止证明可验收、可审计；代际与修订语义无歧义。代价：adapter 与 broker 多一份持久化责任
（command_id 队列、资源清单）；redteam-mode `/stop` 粒度粗，v0.1 取消是清单级尽力而为 + 逐项证实，
进程级精确证实 v0.2 收敛。

## 验收（并入 v0.1 验收清单）

1. 丢回包恢复演练：adapter 接收成功 → 断回包 → 控制端重启 → `lookup(command_id)` 找回同一任务，
   全局恰一个任务（负样本：二次 dispatch 不得产生第二任务）。
2. 资源残留负样本：主会话已停、容器仍在 → 状态不得为 confirmed_stopped，必须 unresolved
   且清单标明未证实项。
3. 撤销级联：全部任务 cancel_requested → 逐项证实 confirmed_stopped（探针证据入账）；
   证实失败走 unresolved 人工队列；gate_log 有级联终态与 unresolved 计数。
4. 时间窗到期触发同一级联路径。
5. 执行器断联：任务进 unknown；reconcile 依探针定论；不产生自动重做。
6. cancel 幂等：重复调用返回相同状态。
7. 旧代回执晚到：进隔离区（ADR-002 D5），状态机与判定引擎不受影响。
