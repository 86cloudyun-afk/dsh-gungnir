# ADR-007 批准与动作绑定（含授权手段校验）

- 状态：Accepted（操作员裁定 2026-10-03）
- 关联：ADR-001（权限与执行边界 D3/D5）、ADR-002（数据与证据契约）、ADR-006（执行层能力面）、
  [DSH-EXECUTOR-IMPL.md](../DSH-EXECUTOR-IMPL.md)、`packages/warroom-core/src/gates.js` / `broker.js`

## Context

ADR-001 D3 把「请求 ⊆ 冻结对象」写成五个维度：**资产 ∈ scope、时间 ∈ 时间窗、手段 ∈ 允许手段、
action_class ≤ 上限、auth_version == 当前值**；D5 要求 destructive 一律人工裁决。代码侧实测（2026-10-03）
发现两类"要求写下来了、动作却不受它约束"的缺口：

**A. 批准不绑定动作。** `approvals` 表只有 `engagement_id` / `action_class`（硬编码 `destructive`）；
`reason` 是自由文本、不参与校验。于是**一张令牌可以授权该战役内任何 destructive 动作**——换动作、换靶标、
换手段都不影响（实测：同一张 `single_use:false` 令牌连续放行 `exploit@10.0.0.5`、`exec@10.0.0.6`、
`internal@10.0.0.7`）。签发面也不存在：只有进程内 `broker.createApproval()`，没有 CLI、没有工具。

**B. 消费与审计不绑定命令。** `used_by_command` 写的是 `used_at:<时间戳>` 而非 command_id；`gate_log` 的
allow 记录只有 `class=destructive`，没有批准 id。事后无法证明"哪张批准放行了哪条命令"。消费是
`SELECT` + **无条件** `UPDATE`，两步都在 `BEGIN IMMEDIATE` 之外——跨进程（宿主 + CLI）存在 SELECT/UPDATE
竞态窗口，没有 compare-and-set。

**C. `allowed_means` 从不校验。** D3 的第四维（手段）在 `auth_object` 里冻结、在报告里展示，但
`checkAgainstAuth` 从不读它：`allowed_means:['passive']` 的战役照样可以派 `exec`（任意命令）。

**D. 声明的档位不受动作约束。** `action_class` 是请求方自己填的标签；执行层的动作档位（`exploit` =
destructive）与标签之间没有任何约束，`{"action":"exploit","action_class":"active"}` 无需批准即可派发。

## Decision

**D1 批准必须绑定「动作 + 可寻址集合」，粒度到端口/路径/scheme。**
`approvals.contract_hash = sha256(v2|归一化动作|action_class|排序后的可寻址键)`，其中可寻址键
（`addressKey`）= URL 的 `scheme://host:port + path + query`、裸主机/IP 的 `host[:port]`（小写）。
签发时由 `bound:{action,targets,url}` 计算，派发时对**本条契约**（`targets` + `url` + chain 步内目标）重算比对。
指纹不含命令内容：批的是"在这个靶标（这个服务、这个路径）上做这个动作"，不是某条具体命令。
**动作归一化**（trim + lowercase）：`EXEC` 与 `exec` 在执行层与手段闸处等价，绑定也必须等价。
**无绑定的批准（含旧库裸批准）一律拒收**，须用 `warroom approve --action <动作> --targets <靶标>` 重新签发。

**D2 一次性消费原子化并记真实命令。** 消费移入与 `command_queue` 写入同一个 `BEGIN IMMEDIATE` 事务，
用 `UPDATE … WHERE used_by_command IS NULL` 的 compare-and-set 落定（`changes ≠ 1` 即 `E_APPROVAL_USED`），
`used_by_command` 写**真实 command_id**；`gate_log` 的 allow 记录带 `approval=<id>` 与绑定指纹前缀。

**D3 宿主派发前复核绑定。** `assertHostAuthorization` 对 destructive 队列项复核三件事：批准未过期、
指纹与队列里的契约一致、一次性批准的消费方**就是这条命令**——防"批条被换给别的命令"。

**D4 手段校验落地（ADR-001 D3 第四维）。** 新增 `ACTION_MEANS` 词表（动作 → `passive|active`），
按**动作本身**判定（不看 `action_class` 标签），并取 `action` / `role` / `intent` 三者中**最强**的一方
（只看 `action` 会留下"被动标签 + 主动 intent 交给适配层做角色映射"的旁路）；`means ∉ allowed_means` →
`E_GATE_MEANS_NOT_ALLOWED`。未知/未声明按最保守的 `active` 处理；`allowed_means` 在冻结授权时校验并规范化。
词表与执行层 `CAPABILITIES` 的双向一致性由测试断言（防漂移）。

**D5 destructive 契约必须声明 `action`。** 批准按「动作 + 靶标」绑定，没有动作就无从绑定与审计；
缺令牌时仍先报 `E_GATE_DESTRUCTIVE_NEEDS_APPROVAL`（保持既有负样本语义），带令牌但缺动作报 `E_GATE_ACTION_REQUIRED`。

**D6 执行层拒绝自相矛盾的契约。** 执行层不做授权裁决（ADR-006 D3 不变），但拒绝"声明档位弱于动作档位"
的契约：`exploit`（tier=destructive）必须声明 `action_class=destructive`，`exec` 等 active 动作不得声明
`readonly`；destructive 动作未声明档位同样拒绝。

**D7 签发面在操作员侧。** 新增 CLI `warroom approve`（绑定签发）与 `warroom approvals`（只读台账）。
**不**提供 `warroom_*` 工具：批准必须由人（host 平面）签发，agent 只能请求、不能自批（ADR-001 D5 不变）。
签发时校验：`bound.action` 必填、至少一个可解析的靶标/URL（否则是永远消费不掉的死令牌）、战役必须存在。

**D8 批准一律一次性。** 不接受多用令牌（`single_use:false` 等于可复制的不记名批条，且"这张令牌放行了
哪几条命令"会失去归属）；需要多次就签多张，或把 TTL 缩短。表里的 `single_use` 列保留 1，
历史 `single_use=0` 行因没有绑定指纹在消费时已被拒。

## Consequences

- 一张批准只对它绑定的动作 + 靶标生效；换靶标/换动作在门闸处就被拒（`E_APPROVAL_MISMATCH`），
  且错误信息里给出批准绑定的动作与靶标，指挥层知道该重新申请什么。
- 批准 → 命令的链路可审计：`approvals.used_by_command` 是真实 command_id，`gate_log` 带批准 id。
- 跨进程双花被 CAS 挡住（第二次更新 0 行）；宿主派发前再做一次绑定复核。
- `allowed_means` 从此有牙齿：`['passive']` 的战役只能做被动侦察（`http_get`/`recon`），主动手段一律拒。
- 破坏性兼容：**旧库里的裸批准全部失效**（消费时拒收，须重新签发）；`destructive` 契约必须补 `action` 字段。
  这两条都是有意的 fail-closed 收紧，已在 CHANGELOG 与 ACCEPTANCE 标注。
- schema：global 库目标版本 v9 → **v10**（`approvals` 增 `contract_hash` / `bound_action` / `bound_scope`，
  迁移幂等、老库补列、旧行保留但不伪造绑定）。
- 已知残余（部署面，本 ADR 不解决）：`warroom approve` 与 agent 工具共用同一个 `--home`/`global.db`，
  两者的边界是"人跑 CLI / agent 没有 shell"这一部署约束，代码层不区分调用者；建议 approvals 库置于
  agent 写权限之外，并在 doctor/AGENT 约定里写明"approve 只允许人执行"。
- 回滚：删除指纹校验分支并把 `_consumeApproval` 移出事务即可回到旧行为；但那样会重新打开 A/B/C/D 四个缺口，
  属于安全回退，需操作员显式裁定。
