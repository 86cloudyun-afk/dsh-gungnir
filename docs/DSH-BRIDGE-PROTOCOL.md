# DSH 桥协议（gungnir-bridge/1）

GUNGNIR（指挥层）与执行层（DSH 侧红队模式）通过 **spool 目录**交换文件，
双方各自崩溃都不丢任务；重启后 spool 即为恢复依据。

```
<home>/dsh-bridge/
├── outbox/    GUNGNIR → 执行层（指令）
│   ├── <external_id>.job.json    派单
│   └── <external_id>.stop.json   停止请求
└── inbox/     执行层 → GUNGNIR（回执）
    ├── <external_id>.status.json 状态
    ├── <external_id>.facts.json  事实（成员数组）
    └── <external_id>.probes.json 资源探针结果
```

## 写文件规则（双方都必须遵守）

1. **原子写**：先写 `<name>.tmp-<pid>-<ts>`，再 `rename` 到目标名——避免读到半截文件。
2. **幂等**：同一 `external_id` 重复写 `job.json` 视为同一次派单（执行层不得因此启动第二个任务）。
3. **只增不改**：主控不给已发出的指令追加修改，变更一律新指令（新 `external_id`）。

## 文件形态

`outbox/<id>.job.json`
```json
{ "protocol": "gungnir-bridge/1", "external_id": "wt_...", "role": "recon",
  "contract": { "targets": ["10.0.0.5"], "action_class": "readonly",
                "generation": "1:1:1", "task_id": "wt_..." },
  "issued_at": "2026-10-02T00:00:00.000Z" }
```

`inbox/<id>.status.json`
```json
{ "protocol": "gungnir-bridge/1", "external_id": "wt_...",
  "generation": "1:1:1", "event_seq": 3,
  "state": "running|done|partial|failed|cancelled|confirmed_stopped|unknown|unresolved",
  "updated_at": "..." }
```

`inbox/<id>.facts.json`（成员必须满足 ADR-002 D5 的来源键三元组 + 修订号）
```json
{ "external_id": "wt_...", "generation": "1:1:1", "event_seq": 2, "members": [ { "entity_type": "asset", "source_id": "10.0.0.5:443",
                 "revision_no": 1, "content_hash": "sha256:...", "payload": {...} } ] }
```

`inbox/<id>.probes.json`（停止证实：逐项资源）
> `stopped` 是**实测结论**：执行器按命令的进程组判定，组内仍有存活成员时必须报 `false` 并把子进程逐条列出
> （见 ADR-008）。`false` 不会让任务被判 `confirmed_stopped`——它会停在该资源的 `unresolved` 上等探针/人工收口。
```json
{ "external_id": "wt_...", "generation": "1:1:1", "event_seq": 3, "stop_request_id": "cancel-...", "resources": [ { "id": "wt_...-session", "kind": "session", "stopped": true },
                 { "id": "wt_...-container", "kind": "container", "stopped": false } ] }
```

`outbox/<id>.stop.json`
```json
{ "protocol": "gungnir-bridge/1", "external_id": "wt_...", "generation": "1:1:1",
  "request_id": "cancel-...", "after_event_seq": 2, "action": "stop", "at": "..." }
```

## 语义约束（与 ADR-003 对齐）

- 执行层**只上报事件，不改状态**；状态机由主控（host）独占推进。
- 超时未应答 → 主控记 `unknown`，绝不自动重试；`reconcile` 依 probes/回执定论。
- `confirmed_stopped` 必须 **probes 逐项 stopped=true**（会话/子任务/进程/端口/容器）；
  任一项 false 或缺项 → `unresolved`（人工队列），不得假称已停止。
- 后台停止证明还必须确认账本中持久取消标识（probes.stop_request_id），与当前 status 同序且超过
  stop.after_event_seq。缺状态／标识／源确认不能退化为旧证据；不允许重包旧执行器证明。
  已声明和已观察资源取持久并集，后来省略的资源仍须证明停止。
- 事实入库是**成员级幂等**：同一 `(adapter_instance, entity_type, source_id)` 只有最大
  `revision_no` 生效；晚到的旧修订保留为历史行、不覆盖、不重复记账。

## 参考应答器（已实现）

```sh
# 常驻：每 50ms 扫一次 outbox，按 contract 生成回执
node scripts/dsh-bridge-responder.mjs --root "$WARROOM_HOME/dsh-bridge"

# 彩排/测试：单次处理；fixture 模式从预置目录读回执（可编排异常：资源残留、空事实等）
node scripts/dsh-bridge-responder.mjs --root <root> --once --mode fixture --fixture <dir>
```

- **echo 模式**：按 `contract.fake_members` 生成事实、按 `contract.resources` 推导资源探针。
- **fixture 模式**：读 `<external_id>.facts.json` / `.probes.json`，用于编排「资源未停」「空回执」等场景。
- 幂等：`claims/<external_id>.json` 先 fsync 登记领取，再执行；重启后已有领取不再执行。
  领取未完成只写 unknown，不释放幂等键、不重试 executor。所有回执先 fsync 再原子 rename，随后 fsync 目录。
  活跃或存活未知的领取进程独占发布；其他应答器只观察，确认领取者退出后才重读恢复。
  owner_pid 只排除并发发布，不能当资源停止证据；无法确认存活时保持未定。
- DSH 宿主后台 job 带 `background:true`：工具不等回执，宿主服务观察 generation/event_seq。
  应答器先 facts/probes 后终态；后台完成事实须与 status 的 event_seq 一致。
  已完成领取保存原终态/序号；最终 status 丢失时，先核验同代同序回执，再重放原事件，绝不重执行。
  旧 CLI job 保留 running 回执与 wave 调用接口。
- stop 仅登记取消；executor/fixture 的资源证据原样保留，不能改 stopped=false 为 true。
  只有 echo 自己的模拟资源可以模拟停止；真实停止仍须执行层提供逐资源来源证据。
- 跨进程验证见 `test/dsh-responder.test.js`：GUNGNIR 与应答器分属不同进程，仅经 spool 通信。

## 执行器插件（真实接入点，ADR-004 项 4）

```sh
# 用执行器插件跑桥（DSH 侧进程）
GUNGNIR_EXECUTOR_CMD="/path/to/dsh-executor --json" \
  node scripts/dsh-bridge-responder.mjs --root "$WARROOM_HOME/dsh-bridge" \
  --executor executors/dsh-redteam-executor.mjs
```

- 插件契约：`export default { name, run(job) → { generation, external_id?, members, resources } }`（可为 async）。
  generation 必须由本次源执行器返回且与 job 匹配；缺失/旧代拒收，不得由当前 adapter 补写。
  支持真实停止证明的源还须明确返回 stop_request_id 确认对应取消；适配层仅透传，不能代填。
  本参考实现不新增真实停止动作；未提供这种证明的旧执行器取消结果保持 unresolved。
- 内置：`executors/echo-executor.mjs`（彩排）。
- 真实接入：`executors/dsh-redteam-executor.mjs` —— 把 job 经 stdin 交给 `GUNGNIR_EXECUTOR_CMD`，
  要求其输出 `{generation, members, resources}`；**未配置或输出非法即失败**，绝不写"看起来成功"的回执（fail-closed）。
- 已领取的失败不能自动重试（幂等键 `external_id` 保留），主控侧表现为任务 `unknown/unresolved`，
  而不是"完成"——这正是 ADR-003 想要的语义。

## 待办（v0.2 集成波次）

- 在 DSH 侧把 `GUNGNIR_EXECUTOR_CMD` 指向一个调用红队模式插件服务的脚本
  （输入 job JSON → 派单到五角色 → 收集事实/探针 → 输出回执 JSON）。
- 出口与授权仍由 GUNGNIR 门闸约束（执行层的网络流量必须经跳板池，见框架 §12）。
