# ADR-009 终态与资源收口：取消不许无副作用地回"已结束"

- 状态：Accepted（操作员裁定 2026-10-03）
- 关联：ADR-003（D4 取消与证实 / D5 级联）、ADR-002（数据与证据契约）、ADR-008（证据来源与资源清单真实性）、
  `packages/warroom-core/src/broker.js`、`packages/warroom-plugin/src/host-tasks.js`、
  `packages/warroom-core/src/adapters/dsh-bridge.js`

## Context

ADR-008 让执行层如实上报"命令留下的后台子进程"（`stopped: false` 且逐条进资源清单）之后，账本这一层
露出一个缺口（操作员 2026-10-03 指出）：

1. **完成结论可以盖住仍在跑的资源**：任务是 `done`（活干完了），清单里却还有未证实停止的资源——
   这在 ADR-003 D4 里是**允许**的（`done` 从不表示资源已停，会话/容器本来就在取消时才收）。
   问题是这层意思只写在门闸日志之外：`warroom status` 能看清单，但**没有任何一条信号**说明
   "这个完成结论背后还有活资源"。
2. **终态取消是空操作**：ADR-003 D4 写"cancel 幂等；对已终态任务返回当前终态"，实现就是
   `if (isTerminal(state)) return { terminal: true }`。于是 `command: 'nohup ./x &'` 这类
   "干完就退出、留下后台进程"的命令，资源永远收不了口：取消回来一句"已结束"，谁也没去停它。
   实测：`sleep 300 & echo started` → 执行器报 done + `child` 仍在跑 → `cancel` 直接 `terminal: true`，
   `pgrep` 里那个子进程活得好好的。
3. **同步路径即使去停也证实不了**：`adapter.cancel(task, reason)` 不带停止身份（request_id），
   应答器因此无法把停止判成 `fresh` → 只能落 `unresolved`；而且 `stopRole` 用 `_awaitFile` 读状态文件，
   文件**早就在**（上一次发布），于是立刻返回**取消前**的状态。

## Decision

**D1 `done` 的语义不动。** `done` 仍然只表示"派下去的活干完了"，**不**表示资源已停（ADR-003 D4 原语义）。
本 ADR 不把"清单未收口"当成不许记 `done` 的理由——那会与既有模型（会话/容器随取消收口）冲突。

**D2 但完成结论不许沉默。** 任务以 `done` 落定时，若清单里仍有未证实停止的资源，除原有的 `settle`
门闸记录外**另记一条 `resources_outstanding`**（含 live 资源 id），`settle()` 的返回也带 `live`。
宿主观测路径（`host-tasks._observe`）同一规则。

**D3 终态取消必须真的去停 + 逐项证实。** `cancel()` 不再对终态任务无条件短路：先看清单——
清单已收口（或观测不到）→ 保持原语义（幂等，返回当前终态）；清单里**还有活资源** → 记
`cancel_after_terminal` 门闸、把状态重新打开为 `cancel_requested` 并落到既有取消流程：
host 任务交宿主 tick、非 host 任务就地探针；**全项证实 → `confirmed_stopped`，任一未证实 → `unresolved`**
（ADR-003 D4 的落点不变）。

**D4 停止身份与"等新发布"。** 同步取消路径生成 `request_id` 传给 `adapter.cancel(..., { request_id })`
（应答器据此判定停止证据是否 fresh）；`FileBridgeDriver.stopRole` 的同步分支改为等**新**发布
（`event_seq` 前进，`_awaitFileAfter`），不再把取消前的旧状态当成停止结果。

**D5 观测口径不变。** `status.manifest[].confirmed_stopped` 仍是逐项探针的实测结论；
`done` + `confirmed_stopped` 不是互斥的事实——任务可以"干完了"且"资源后来被证实停掉"。

## Consequences

- "干完就退出、留下后台进程"的任务不再是死局：`cancel` 会发停止请求、逐项探针，落
  `confirmed_stopped` 或挂进 `unresolved` 人工队列（gate_log 有 `cancel_after_terminal` 可查）。
- 完成但资源仍在跑的任务在审计里可见（`resources_outstanding`），不再是"看着很干净"的完成记录。
- 同步取消从"立刻回旧状态"变成"等到新发布"：桥接 fixture 若从不发布新状态，等待会走到
  driver 的 `timeoutMs`（默认 2s，桥一致性套件设为 6s），随后仍按探针结论落账——**慢但不会编**。
- 终态任务被重新打开为 `cancel_requested` 时，`auth_version`/代际不变；重派语义不受影响。
- 回滚：`cancel` 的短路分支是唯一开关点；但回滚会重新打开"取消空操作"的缺口，属安全回退。

## 相关证据

- `test/resource-settlement.test.js`：完成 + 活资源 → `resources_outstanding`；终态取消 → 真的停 +
  逐项证实（`confirmed_stopped`）；已收口的终态取消 → 无副作用；宿主观测路径同规则。
- `test/dsh-responder.test.js`：真实应答器 + 桥驱动端到端 —— daemon 报 done 的任务，取消后
  `stop.json` 落地、探针逐项为已停止、账本落 `confirmed_stopped`。
