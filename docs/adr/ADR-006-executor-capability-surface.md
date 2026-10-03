# ADR-006 执行层能力面（capability surface）

- 状态：Accepted（操作员裁定 2026-10-03）
- 修订记录：D4（证据协议）由 [ADR-008](ADR-008-evidence-provenance-and-resource-manifest.md) 收紧——证据行须带本单 nonce、内置抓取模板不再解析证据行；本 ADR 其余决策不变。
- 关联：ADR-001（权限与执行边界 D1/D2/D3/D5）、ADR-002（数据与证据契约）、
  [DSH-EXECUTOR-IMPL.md](../DSH-EXECUTOR-IMPL.md)、`executors/tool-runner.mjs`

## Context

`executors/tool-runner.mjs` 是 GUNGNIR 的最后一段执行通道（桥 → 执行器 → 真工具）。它最初只实装了
`http_get` / `recon` / `nuclei_scan` 三个动作，其余动作（`exec` / `vuln` / `exploit` / `internal` / `chain`）
一律以「未实装且不属于本通道」拒绝。

真机后果（2026-10-03）：指挥层派 `action: exec` 做一件很普通的动作（看一眼目标、跑一条既有工具命令），
收到的是一段**无从下手**的拒绝文本——它既没说缺哪个契约字段，也没说这条通道到底能干什么；
指挥层只能反复重派同一单，任务在 `failed`/`unknown` 之间打转。桥梁日志（`bridge.stderr.log`）里
连续两次同一 exit=4 即为此。

同时 ADR-001 D1 的边界并未被违反：指挥官预设**没有** bash/文件写/进程工具，"一切副作用经 broker"
仍然成立。缺的不是权限模型，而是**执行层把已授权的动作落地**的能力面。

## Decision

**D1 能力面 = 显式注册表，八项全部实装。** `CAPABILITIES` 声明 action → tier / 所需契约字段 / 工具 /
产出事实类型；`planCommands` 只按注册表出计划。没有"未实装"这种状态：要么有真实命令计划，
要么精确报出**缺哪个字段**（`contract.command` / `contract.argv` / `contract.steps` / `targets`）。

**D2 通用能力只走操作员显式命令。** `exec` / `exploit` / `internal` / `chain` 的命令必须由操作员在契约里
写出（`command` 字符串或 `argv` 数组，argv 按参数边界拼壳）；执行器**不替指挥层发明命令**，也不做任何推断。

**D3 授权裁决仍在 broker。** 执行层不重复做 scope/时间窗/action_class 裁决；`exploit` 的 destructive
仍需人工批准令牌（ADR-001 D5 不变）。执行层只保证"派下来的动作有真实计划"。

**D4 证据回传用显式协议，不用推断。** 命令 stdout 里的
`GUNGNIR_MEMBER: {"entity_type":…,"source_id":…,"payload":…}` 逐行原样入库（缺 `content_hash` 时按内容补）；
可用的实体类型为 `asset/domain/vuln/credential/session/shell/chain/artifact`，字段不全或类型不在表内的行直接忽略。
已知工具格式（nuclei/httpx/curl）继续按各自解析器入库。

**D5 操作员命令的失败语义与被派动作一致，不伪造。** 操作员命令无论退出码都会留一条 `artifact` 事实
（命令哈希 + 退出码 + 输出哈希 + 落盘路径）：非零退出是**被派命令的真实结果**，不是执行层故障；
**超时（被 kill）** 才抛错并让主控记 `unknown`（证据不完整）。内置工具模板保持旧语义：非零退出即失败。

**D6 能力面可现查、可断言。** `node executors/tool-runner.mjs --capabilities` 输出机器可读清单；
`presets/roles/commander.md` 的「可派动作」表与注册表由测试**双向断言**（多一个少一个都红），
防止"文档承诺的能力"和"执行层真有的能力"再次漂移。

**D7 有界。** 单次派单步骤数 ≤ 12（`MAX_STEPS`，按**展开后的命令数**算，不是数组长度）；操作员命令超时
默认 300s、上限 `GUNGNIR_MAX_TIMEOUT_MS`（1h）；出口纪律不变（外部目标必须有 `GUNGNIR_EXIT_SOCKS`）；
原始输出一律落盘 `GUNGNIR_ARTIFACT_DIR`。

**D8 可寻址对象全体受两层校验。** 出口判定与 broker 的 scope 校验都覆盖
`targets` + `url` + `chain` 步内 `targets`/`url`（`contractAddressables`）——
`url` 不是绕过出口铁律与授权范围的旁路（真机实测过：`targets` 在范围内 + `url` 指向外网可直连出去）。

**D9 证据不完整就不算成功。** 超时与被信号杀（SIGKILL/OOM）一律抛错（主控记 `unknown`），绝不落
"跑过且无异常"的假事实；证据行的 `content_hash` 由执行器按规范化内容重算，不采信自报值
（否则同一条证据会因键序/自报差异变成两条互相隔离的冲突事实）。

## Consequences

- 指挥层不再被"未实装"卡死：报错文本从"通道缺少能力"变成"你缺哪个契约字段"，一次补齐即可重派。
- 新增动作只改一处（`CAPABILITIES` + 测试表），文档漂移由双向断言拦住。
- 风险显式化：`exec` 类动作把命令编写权交给操作员，命令内容与产物同权落档——因此**秘密不得写进 argv**
  （用环境变量引用），此约束写进角色提示词与实装指引。
- 执行层不因本 ADR 获得任何新授权：broker 门闸、授权四元组、跳板出口纪律原样生效。
- 回滚：把 `CAPABILITIES` 中相应动作降级为"需显式开启"即可（注册表是唯一开关点），测试会同步拦住文档漂移。
