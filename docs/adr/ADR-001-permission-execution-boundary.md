# ADR-001 权限与执行边界

- 状态：Accepted · **rev1**（2026-10-02 复核收敛，含操作员裁定）
- 修订记录：rev1 = 执行隔离改允许清单闭合；授权模型改为「开工指令即授权事件 + 宿主冻结结构化对象」；
  秘密残余风险显式化。
- 关联：[WARROOM-FRAMEWORK.md](../WARROOM-FRAMEWORK.md) §3.2 / §6；ADR-002（授权版本与数据契约）、ADR-003（取消与停止证实）

## Context

环境里同时存在多个执行入口：`warroom_*`、已挂载的 `redteam_*`（19 插件）、`ops_*`、host 子进程
（隧道/容器/handler）。rev0 的两个缺口：其一，deny 只摘除部分工具，若保留通用 bash / 文件读 /
进程操作，「broker 是唯一副作用通道」不成立；其二，只校验「用户消息可解析」不等于该消息授权了
本次请求的资产、时间窗、手段与动作类别。另外 DSH 沙箱对宿主文件为 danger-full-access，仅靠
secret_ref 引用不构成隔离。OWASP 最小权限原则要求显式允许清单与秘密边界。

## Decision

**D1 执行隔离 = 允许清单闭合（deny-list 废止）。**
- 闭环战役预设的工具目录为**显式允许清单**：`warroom_*`（事实读、gate、execute 经 broker、jump 查询）、
  `skill`（岗位技能加载）、指挥角色另含 `send_message`/`team_*`（委派只指向 adapter）。
  **不含 bash、文件写、进程操作、通用网络访问。**
- 三个执行现场各归各的 preset：warroom 角色无 bash，只计划、派发、核对、汇报；实际动手发生在
  adapter 会话（红队模式 preset），其 fs 边界由该 preset 声明，且不包含宿主秘密路径。
- 残余风险显式化：同用户进程理论上可读秘密文件。v0.1 缓解 = 秘密目录 700/600 + 随机不可枚举
  文件名 + 明文永不入 agent 上下文 + 全出口 redactor；v0.2 = 秘密服务迁独立 OS 用户 / IPC
  （launchd），把「读不到」从策略变成物理。

**D2 四元组绑定。** 每个有副作用的执行请求携带 `(engagement_id, auth_version, task_id,
action_class)`，host 侧 broker 校验；缺任一项直接拒绝。

**D3 授权模型（操作员裁定 2026-10-02：开工一次目标即为授权）。**
- **授权事件 = 用户开工指令**。可信宿主（host 平面，非 agent）从会话消息流截获开工指令，
  冻结为**结构化授权对象**：engagement_id（稳定 ULID）、targets/scope、时间窗、允许手段、
  action_class 上限、节奏档、auth_version=1、user_message_id 溯源。对象持久化且带完整性哈希，
  agent 无写工具（D1），不可改写。
- Agent 不产生授权，只引用 engagement_id；`advisory/` 补记 = 对冻结对象的**镜像登记**，
  登记行为不产生也不修改授权。
- broker 校验 = **请求 ⊆ 冻结对象**：资产 ∈ scope、当前时间 ∈ 时间窗、手段 ∈ 允许手段、
  action_class ≤ 上限、auth_version == 当前值。任一维度不匹配即拒绝。
- 默认值模板（指令未指定维度按冻结模板取默认，模板归 `doctrine/`，改动走 RFC）：
  时间窗默认 72h（可续期）；手段默认允许 active 以下；destructive 默认禁（人工裁决）；
  节奏档默认 restricted。开工指令可显式覆盖（如「窗口 30 天」「允许 webshell」），覆盖字段入对象。

**D4 auth_version 单调递增。** 撤销/范围变更 → auth_version += 1：新请求拒绝；运行任务进取消级联
（ADR-003 D5）；级联与终态（含 unresolved）落 gate_log。

**D5 action_class 分档。** readonly / active / destructive；destructive 一律人工裁决；
时间窗到期后 active/destructive 禁手。

**D6 host 子进程同门闸。** 隧道、容器、handler 由 host 服务 spawn，spawn 前过同一 broker 校验并
登记（route + gate_log）；绕过 broker 的 spawn 路径视为 bug。

**D7 秘密边界（v0.1 最低集）。**
- `resolve(secret_ref, task_id, purpose)` 仅 host 服务可调，绑定授权 × 任务 × 用途，带 TTL；
  agent 侧任何工具只返回 `secret_ref`。
- 存储保护：加密 at rest（密钥 `$DSH_HOME/secrets/`，700/600，不进仓库/备份）。
- 出口脱敏：agent 回显、结构化日志、报告、**错误输出**统一过 redactor（secret_values 注册表 +
  常见密钥格式正则）。
- 高级密钥管理（轮换、独立用户 IPC）v0.2+。

## Consequences

正面：越权执行、自我批准、授权与请求不匹配、撤销不生效、秘密经日志/错误泄露五类风险被服务端
关闭；gate_log 可回放每个执行决定。代价：闭环战役内红队/ops 工具直调不可用（经 adapter）；
调试需非战役会话的显式 `--unsafe-direct`；秘密残余风险（同用户可读）记录在案、v0.2 关闭。

## 验收（并入 v0.1 验收清单）

1. 允许清单负样本：战役会话工具目录中不存在 bash / 文件写 / 进程工具（挂载层缺失，非提示词拒绝）。
2. broker 负样本三类：缺四元组；请求 ⊄ 授权对象（资产超 scope 或手段越界）；auth_version 过期。
3. 授权对象：host 重启后从持久层恢复且完整性哈希一致；agent 无任何写路径。
4. 撤销级联生效；日志/报告/错误输出抽测无 secret_value 明文。
5. 桶 A 隔离实测：无 sidecar 出网失败；容器 DNS 不落宿主配置。

## Alternatives considered

- deny-list 隔离（rev0 方案）：否——通用工具残留使隔离不闭合。
- 运行时钩住全部第三方工具：v0.1 不可行，若 DSH 未来提供全局工具拦截层再收敛。
- agent 解析用户消息自证授权：否——引用 ≠ 匹配，比对只信宿主冻结的结构化对象。
