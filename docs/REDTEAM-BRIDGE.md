# redteam-mode 桥接说明（v0.1）

GUNGNIR 是**指挥层**；实际动手由执行层 adapter 完成。v0.1 的唯一执行层是已安装在
本机 DSH 中的 **红队模式**（`dsh-redteam-mode`，19 个插件、五角色流水线、22 表事实库）。

## 分工

| 层 | 负责 |
|---|---|
| GUNGNIR（本仓） | 授权冻结与门闸、命令队列与派发幂等、资源清单与停止证实、事实库（成员级幂等 + 水位）、报告与 IOC |
| 红队模式（adapter 背后） | 五角色派单（recon/assess/vuln/exploit/internal）、战术工具执行、其私有的战术事实库 |
| 两者的数据关系 | 红队模式事实经 `collect()` 进入 GUNGNIR fact.db，必带 `source=redteam-mode` + `source_id`；**只进不回写**（ADR-002 D2） |

## SPI → 红队模式映射（ADR-003 D7）

| SPI | 映射 |
|---|---|
| `dispatch(command_id, contract)` | 按 `contract.intent` 选角色 → 经 DSH 工具调用派单；`contract.task_id` 与 `generation` 由 GUNGNIR 预分配 |
| `lookup(command_id)` | 查询 GUNGNIR 侧命令表 + 红队模式会话表 |
| `status(task_id)` | 红队模式会话/资产 `test_status` + 子代理运行数 |
| `cancel(task_id)` | `/stop` 语义 + 子会话回收；随后由 GUNGNIR 用清单探针证实停止 |
| `collect(task_id)` | 拉取红队模式 fact 落库记录 → 组织为成员（`entity_type`/`source_id`/`revision_no`/`content_hash`） |
| `reconcile(task_id)` | 资产 `test_status` 回查 + 隧道连通性实测（host 层探针） |
| `manifestOf(task_id)` | 会话 / 子任务 / 隧道端口 / 容器 → 逐项探针（PID、端口关闭、容器 inspect、会话回执） |

## 当前状态

- **本仓已落地**：`RedteamModeAdapter` + `LocalRedteamDriver`（纯内存），并通过一致性套件
  （`test/adapter-conformance.test.js`），保证换真实驱动时 SPI 语义不变。
- **待真实驱动**（v0.2 集成波次）：在 DSH host 平面实现 `DshRedteamDriver`（调用红队模式的插件服务），
  完成「真实 SQLite + 真实宿主调用 + 真实派单一次」的最小真实链路；届时只需替换 driver，
  GUNGNIR 侧代码与事实库零改动（框架 §11 关键交叉）。

## 出口与授权（不可绕过）

- 一切对目标的流量仍受 GUNGNIR 门闸与跳板池约束（ADR-001），红队模式自身的网络出口
  必须经同一门闸（桶 A 容器 sidecar / 跳板 route），不得直连。
- 授权由 GUNGNIR 冻结（开工指令即授权事件），红队模式侧不得自行扩张范围。
