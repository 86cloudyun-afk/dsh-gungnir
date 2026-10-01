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
  "state": "running|done|partial|failed|cancelled|confirmed_stopped|unknown",
  "updated_at": "..." }
```

`inbox/<id>.facts.json`（成员必须满足 ADR-002 D5 的来源键三元组 + 修订号）
```json
{ "members": [ { "entity_type": "asset", "source_id": "10.0.0.5:443",
                 "revision_no": 1, "content_hash": "sha256:...", "payload": {...} } ] }
```

`inbox/<id>.probes.json`（停止证实：逐项资源）
```json
{ "resources": [ { "id": "wt_...-session", "kind": "session", "stopped": true },
                 { "id": "wt_...-container", "kind": "container", "stopped": false } ] }
```

`outbox/<id>.stop.json`
```json
{ "protocol": "gungnir-bridge/1", "external_id": "wt_...", "action": "stop", "at": "..." }
```

## 语义约束（与 ADR-003 对齐）

- 执行层**只上报事件，不改状态**；状态机由主控（host）独占推进。
- 超时未应答 → 主控记 `unknown`，绝不自动重试；`reconcile` 依 probes/回执定论。
- `confirmed_stopped` 必须 **probes 逐项 stopped=true**（会话/子任务/进程/端口/容器）；
  任一项 false 或缺项 → `unresolved`（人工队列），不得假称已停止。
- 事实入库是**成员级幂等**：同一 `(adapter_instance, entity_type, source_id)` 只有最大
  `revision_no` 生效；晚到的旧修订保留为历史行、不覆盖、不重复记账。

## 待办（v0.2 集成波次）

- DSH 侧应答器实现：监听 `outbox/` → 调红队模式插件服务派单 → 写 `inbox/` 回执与事实。
- 出口与授权仍由 GUNGNIR 门闸约束（执行层的网络流量必须经跳板池，见框架 §12）。
