# WARROOM 框架 v1.4（架构纲领；v0.1 规格以三份 ADR 为准）

> 基于 DSH 的红队战役指挥框架。
> **v0.1 开发与验收规格**：[ADR-001](adr/ADR-001-permission-execution-boundary.md)（权限与执行边界 rev1）、
> [ADR-002](adr/ADR-002-data-evidence-contract.md)（数据与证据契约 rev2）、
> [ADR-003](adr/ADR-003-adapter-lifecycle.md)（Adapter 生命周期 rev2）。
> 保留主干：①事实库与执行器分离 ②门闸由服务端执行 ③客户报告与蓝队排查清单同源。

## 修订记录

- **v1.4（2026-10-02）**：效率主指标改为**端到端可验收完成时间**（含排队/交接/失败/返工）；
  实现顺序改依赖关系并行推进（唯一串行步 = 接口 alpha 冻结）；真实宿主最小链路提前、与 fake 同步；
  运行时按依赖立即交接（波内无屏障、确定性状态推进归 host、常驻角色复用上下文）。
- v1.3：派发幂等（command_id）；资源清单逐项证实；来源键三元化 + revision_no；op_log 先行补偿；
  TTL 隔离态；双计数器计量；实现顺序与共享类型包；故障注入进 CI。
- v1.2：允许清单闭合、开工指令即授权、取消/停止分离、成员级幂等、身份解耦、SQLite 写所有权。
- v1.1：事实/推理/结论分离、多库职责、shell 三字段、MVP 收缩。
- [v1.0 冻结母本](adr/frozen/WARROOM-FRAMEWORK-v1.0.md)。

## 1. 定位与目标函数

造三层——**store / jumphosts / gates**，其余全适配。
真实环境实测（2026-10-02）：dsh 0.20rc2（pnpm workspace）、node 22.23.2、Docker 29.2.1、
红队模式已注册未使用、pentest-sessions.db 在役。

**shell 状态机**：`highest_proof`（历史证明，权限取高只作用于它）/ `current_validity`
（unknown | likely | confirmed_lost）/ `last_verified_at`；升级树 user → local admin → domain。
漏洞只是边。

**事实/推理/结论三段**：observation 必填先入库；inference 允许 `unknown`+原因；仅 verification
驱动状态转移。

## 2. 设计原则

1. 目标函数优先。
2. 门闸由服务端执行，覆盖全部执行入口——允许清单闭合（ADR-001 D1）。
3. 执行层可插拔，SPI 含完整生命周期：派发幂等、取消与证实分离（ADR-003 rev2）。
4. agent 见引用，host 见明文；引用配解析权限与脱敏出口（ADR-001 D7）。
5. 框架自身是最想被打穿的目标。
6. 事实唯一写入入口 + 外部源只进不回写（ADR-002 D2）。
7. **开工指令即授权**：宿主截获冻结结构化对象，agent 只引用不产生（ADR-001 D3）。
8. **预算不是门闸；效率主指标 = 端到端可验收完成时间**——从需求提交到验收通过的总时长，
   分解为排队 / 交接 / 执行 / 失败与返工四段观测；模型与编制按该指标与返工率选择，
   不按产出成本比（操作员裁定 2026-10-02）。

## 3. 六大件

### 3.1 core-store（host 平面）

- 按战役分库：`$DSH_HOME/warroom/engagements/<engagement_id>/fact.db`；engagement_id 稳定 ULID，
  与 auth_version 解耦。
- 共享资源单份记账：`$DSH_HOME/warroom/global.db`——租约（TTL+心跳）、**op_log 操作意图日志**
  （补偿唯一真源）、broker 命令队列（command_id）。
- v0.1 表（14 张）：engagements、assets、domains、vulns、credentials（validity/acquisition/exposure
  三正交维度）、chains、shell_state、gate_log、jumphosts、jump_routes、egress_checks、cooldowns、
  spray_log、rate_ledger（双计数器：wire_requests 限流 / tool_calls 遥测）。
- 事实成员键：`(adapter_instance|source_session, entity_type, source_id)` 唯一 + `revision_no`
  定修订先后；晚到旧修订不覆盖、不重复计账。
- 外部源只进不回写；冲突双记录 + needs_review。
- v0.2 表：persistence、cleanup、ioc、deception_signal。

### 3.2 gates（统一裁决，允许清单闭合）

四元组 `(engagement_id, auth_version, task_id, action_class)`，服务端 broker 校验：

1. **授权**：开工指令即授权事件——宿主冻结结构化对象（默认模板：72h / active 以下 / destructive 禁 /
   restricted 档，指令可覆盖）；agent 只引用；broker 校验请求 ⊆ 对象：资产 ∈ scope（**含 `url` 与 chain
   步内目标**）、时间 ∈ 窗口、**手段 ∈ allowed_means**（按动作判定）、action_class ≤ 上限、auth_version 一致。
   destructive 另需**绑定到「动作 + 靶标（含端口/路径）」的一次性人工批准**（ADR-007）。
2. **执行通道**：显式允许清单，无 bash/文件写/进程/通用网络。
3. **出口**：egress_verify 只认当次现测。
4. **节奏**：限流只作用于 wire_requests。
5. **指纹审计**：默认 UA / 默认路径 / 公共 OAST / 教科书序列，命中即拒。
6. **动作分级**：readonly/active/destructive；destructive 一律人工裁决。

### 3.3 jumphosts（一级模块，全 host 平面）

acquire（出口实测、失败换板）/ release / rotate / retire（战果丢失 + blast-radius）/ health / import。
租约经 op_log 先行 + TTL 实测证实 + quarantined 隔离态；多跳自动轮换 v0.2。

### 3.4 core-tools

`warroom_*`；`fact_*` / `gate_*`（含 broker 执行入口）/ `jump_*`；schema 进 CI。

### 3.5 presets + skills

七角色（指挥 1 + 执行 6），v0.1 启用 3；叶子化硬约束；公共段落代码注入；链前会议（纪要落库，
会不开波不发）；派活三因子；skills 引用本机 `/Users/appleshu/dsh/tools/`；兜底换人 = 换 adapter；
彩排 `--fake` 走 adapter（v0.1 扩展为故障注入模式，见 §10）。

**运行时交接语义**：
- **波内任务按依赖图立即交接**——独立任务立即并行，依赖满足的结果即刻交给下游，不做批次屏障；
  波与波之间仍由裁决点/链前会议控制。
- **确定性状态推进归 host**：回执去重、状态机迁移、清单逐项核对等机械步骤由 host 服务自动执行；
  指挥（主控）只处理关键判断——链前会议拍板、destructive 裁决、方向切换。
- **常驻角色复用上下文**，避免重复调查与重建（宪法第 13 节：人是常驻的，任务是一次性的）。

### 3.6 adapters（SPI rev2）

```
dispatch(command_id, contract) -> task_id   # 幂等：先持久化后派发，同 ID 同任务
lookup(command_id)             -> task_id | not_found
status(task_id|command_id)     -> {state, generation, progress?}
cancel(task_id|command_id, reason)          # 请求取消（幂等）
collect(task_id)               -> receipt   # 成员级幂等
reconcile(task_id)             -> final_state
```

状态枚举：非终态 `queued / running / cancel_requested / unknown`；挂起 `unresolved`；
终态 `done / partial / failed / cancelled / confirmed_stopped`。
`done` 只表示「活干完了」，**不**表示资源已停：完成时清单里仍有活资源会另记 `resources_outstanding`；
取消请求对终态任务同样有效——清单里还有活资源时，它会发出停止动作并逐项证实（ADR-009）。
**资源清单逐项证实**：dispatch 登记任务持有的全部资源，运行中增量登记；confirmed_stopped
要求清单逐项探针通过，任一未证实 → unresolved。generation 只在同任务执行尝试间比较。
v0.1 唯一 adapter：redteam-mode。

## 4. 执行三桶 + 节奏档

A 容器+sidecar（TCP+DNS 全接管）/ B 本机 / C 跳板侧。隔离验收：无 sidecar 出网失败、DNS 不落宿主。
节奏档限流对象 = wire_requests。

## 5. 数据流与报告

门闸①授权（宿主冻结对象）→ broker 队列（command_id 持久化）→ acquire（门闸②内置）→ 立项 →
W1/W2 → 链前会议 → W4 → shell 证明 → 报告 → 导出。水位 = `(seq, snapshot_id, exported_at)` +
证据 sha256。IOC/清理附录 v0.1 = 半自动初稿 + 人工确认。

## 6. 蓝队对抗原则

八条：指纹卫生 / DNS 接管 / 库加密 / 暴露半径 / 蜜罐告警 / 注入防御 / 开源边界 / 授权证据链。
秘密残余风险（同用户可读）显式记录，v0.2 独立用户/IPC 关闭。

## 7. 真实环境落位

pnpm workspace；patch 层 deploy 脚本化；`warroom_*` 避开 `redteam_*`/`ops_*`；
pentest-sessions.db 只做聚合；重启走用户终端。SQLite：写互斥由服务所有权实现（唯一读写连接 +
其余 mode=ro），BEGIN IMMEDIATE + WAL + checkpoint。

## 8. v0.1 冻结范围与验收

单一可验证闭环：单战役、单 adapter（redteam-mode）、服务端门闸、可取消任务、证据入库、报告导出。
三角色保留。后移：多 adapter、多跳轮换、全局知识库、marketplace、UI。

验收最低集（细则在 ADR 验收节）：

1. 允许清单负样本：bash/文件写/进程工具不在战役会话工具目录。
2. broker 负样本：缺四元组 / 请求 ⊄ 授权对象 / auth_version 过期。
3. 授权撤销 + 时间窗到期：级联取消 + 探针证实的停止（unresolved 入人工队列）。
4. 丢回包恢复：adapter 接收成功 → 断回包 → 控制端重启 → lookup 找回同一任务，无重复任务。
5. 资源残留负样本：主会话停、容器在 → unresolved，不得 confirmed_stopped。
6. 成员幂等：{A}→{A,B} 不重复记账；乱序修订不覆盖；重复回执无效。
7. 旧代结果不覆盖新版本。
8. 日志/报告/错误输出无秘密明文。
9. 桶 A 隔离实测：无 sidecar 出网失败；DNS 不落宿主。
10. 报告水位双校验。
11. 非所有者写连接被只读模式拒绝。
12. fact.db 停写注入：op_log 驱动补偿，恢复后审计补齐；TTL 未证实释放进 quarantined。

## 9. 冻结纪律

ADR Accepted 即不可变，修正以新 rev 重写并留修订记录；框架每轮收敛后 `adr/frozen/` 留快照；
上 GitHub 后以 tag 冻结。宪法/doctrine 改动走 RFC。

## 10. CI 与故障注入

- CI 三闸：零依赖回归 + tool-schema 校验 + 故障注入矩阵。
- 故障注入矩阵（`--fake` 扩展）：丢回包、乱序回执、事实库写失败、进程残留、宿主/控制端重启恢复；
  fake 之外用真实 SQLite 与真实宿主调用验证契约。
- 数据治理：schema_version + 迁移脚本 + 备份恢复流程；加密数据密钥的恢复方式必须写明。

## 11. 依赖关系、并行推进与效率指标

**依赖图（不是串行流水线）**：

```
批次 0（唯一串行步）：共享接口类型 alpha 冻结
  （contract / receipt / resource manifest / 状态迁移表 / 错误码）
        │
        ├─ store（含 fake adapter）     ─┐
        ├─ tools（broker + gates）       ├─ 四线并行，小批次持续集成，互不等待
        ├─ adapter（redteam-mode 桥）    ─┤
        └─ CI（故障注入矩阵）            ─┘
关键交叉：接口 alpha 冻结后【立即】跑通最小真实链路
（真实 SQLite + 真实宿主调用 + 红队模式真实派单一次），与 fake 同步推进——
接口不匹配第一周暴露，不留到后期返工。
```

- 接口变更走 shared-types 语义化版本；破坏性变更显式升版并广播。
- 小批次：每线按可独立验收的小块合并（DORA：小批次缩短反馈时间）。

**共享类型包**（`packages/shared-types`，`arch` 第一交付，五角色共同输入）：
contract、receipt、resource manifest、状态机与合法迁移表、错误码枚举、
source_key/generation/receipt_id 类型定义。各包禁止自行解释 ADR——一切以类型为准。

**效率指标（操作员裁定：预算不是门闸）**：
- 主指标 = **端到端可验收完成时间**：需求提交 → 验收通过的总时长，四段观测
  （排队 / 交接 / 执行 / 失败与返工），瓶颈按段定位。
- 模型与编制按主指标与返工率选择。
- 次级诊断字段保留：tokens / wall_time / verified_fact_count 入库，服务瓶颈归因。
- 该指标同样适用于本框架的 dogfood 开发过程。

## 12. 路线图 + 治理 + 编制

- **v0.1**：冻结闭环（§8），三份 ADR 验收全绿，推进方式按 §11。
- **v0.2**：UI、persistence/cleanup/IOC 自动聚合、deception_signal、秘密服务独立用户/IPC、
  指纹审计自动化、多跳轮换、dsh-native adapter、进程级取消证实。
- **v0.3**：knowledge、pentagi 评估（大概率不接）、marketplace。

治理：MIT；仓库只编排层，工具箱 Release 附件；CODEOWNERS 按包；CI 三闸；发版三件套；
默认项可配置。编制 5 常驻（arch / store / tools / adapter / release），一包一 scope，dogfood 开发。
