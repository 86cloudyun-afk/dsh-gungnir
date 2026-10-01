# ADR-002 数据与证据契约

- 状态：Accepted · **rev2**（2026-10-02 复核收敛）
- 修订记录：rev2 = 来源键三元化 + 修订版本号（revision_no）与内容哈希分离；补偿改 op_log 先行、
  支持事实库故障恢复；TTL 到期必须实测证实，未证实资源进隔离；rate_ledger 双计数器与效率遥测语义。
  rev1 = engagement_id/auth_version 解耦、成员级幂等、水位快照、租约补偿、SQLite 写所有权。
- 关联：[WARROOM-FRAMEWORK.md](../WARROOM-FRAMEWORK.md) §3.1 / §5 / §11；ADR-001（授权对象）、ADR-003（代际、回执）

## Context

三类存储并存：warroom fact.db（新）、redteam 事实库（adapter 私有）、pentest-sessions.db（在役聚合层）。
rev1 遗留：source_id 的唯一范围未定义（跨会话冲突？）；content_hash 无法表达修订先后；
generation 的比较范围未限定；补偿规则要求写 gate_log 但 gate_log 就在故障中的 fact.db 里；
lease TTL 到期时实际资源未必已释放，直接回收再分配有双重占用风险。另经独立验证：SQLite WAL 下
第二连接仍可顺序写入——「只允许一个写连接」必须由服务所有权与访问控制实现，不能归因于 WAL。

## Decision

**D1 engagement 标识解耦。** engagement_id = 稳定 ULID，**不随 auth_version 变化**；auth_version 是
engagement 行上的独立列。库路径、任务归属、共享租约全部以 engagement_id 关联，跨版本稳定。

**D2 真源声明（写路径唯一）。**
- fact.db：闭环战役战术事实的唯一写入入口（唯一 host 服务独占读写连接）。
- pentest-sessions.db：战役聚合层（`ops_*` 域），不接收战术事实写入。
- redteam 事实库：adapter 私有；其记录经 `collect()` 进入 fact.db 才算框架事实。
- 外部记录只进不回写。

**D3 冲突裁决。** 多源冲突：双记录保留 + `needs_review`，人工裁决以证据文件为准。禁止自动合并。

**D4 版本水位。** 水位 = `(seq, snapshot_id, exported_at)`：seq 事务级单调号；导出在单只读事务快照
内完成；报告引用的证据文件附 sha256。复现 = 水位 + 摘要双校验。导出单向，不反写。

**D5 幂等（rev2：来源键三元化 + 修订版本号）。**
- **来源键** `source_key = (adapter_instance | source_session, entity_type, source_id)`：
  source_id 只要求在「同一 adapter 实例（或源会话）× 同一实体类型」内唯一；
  entity_type 枚举于共享类型包（asset/domain/vuln/credential/session/chain/…）。
- **修订先后由 revision_no 表达**（来源侧单调，缺失时由 host 按 ingest 顺序分配），content_hash
  仅作完整性校验，不表达顺序。有效修订 = 每 source_key 的最大 revision_no 行；
  **晚到的旧 revision_no 不覆盖新 revision_no**（旧内容保留为历史行）。
- 记账与判定引擎只按每 source_key 的有效修订行计**一次**；事实修订不重复累计。
- ingest、记账、seq 递增在同一 `BEGIN IMMEDIATE` 事务内完成。
- 回执层 receipt_id 去重保留，仅作传输层幂等；**记账真源是成员唯一键**。

**D6 共享资源租约（rev2：op_log 先行 + 隔离态）。** global.db 租约与 fact.db 写入无跨库事务 → saga：
- **操作意图日志先行**：资源激活前，意图与补偿状态持久化到 `global.db.op_log`
  （状态机：`intent → activated → released | compensation_pending | quarantined`）。
  **补偿期间 op_log 是唯一真源**——fact.db 故障时 gate_log 不可写，补偿动作照常执行，
  审计记录在 fact.db 恢复后补齐（带 `recovered_at` 标记）。
- **TTL 到期 ≠ 已释放**：lease 到期先对运行资源实测（监听端口/容器/子进程探针）；
  已证实释放才回收；**未证实释放的资源进 `quarantined`，禁止再分配**，转人工清单。
- 恢复：lease 带 TTL 与心跳；host 重启后过期且经实测证实已释放的租约自动释放。
- 对账：周期比对 global.db 租约与运行时实测，以实测为准修正。

**D7 事实/推理/结论三段。** observation（evidence_ref、observed_at）必填先入库；inference 可后补，
允许 `unknown` + 原因；verification 齐备才驱动状态转移与判定引擎。

**D8 shell_state 三字段。** `highest_proof` / `current_validity` / `last_verified_at`。

**D9 SQLite 写所有权。** 单并发写事务是引擎行为；写互斥由服务所有权与访问控制实现：唯一 host 服务
读写连接，其余组件 `mode=ro` + 库文件只读权限；显式 `BEGIN IMMEDIATE` + busy_timeout；
WAL + 周期 checkpoint。验收负样本 = 非所有者写被只读模式拒绝。

**D10 计量语义（rev2 新增）。** rate_ledger 双计数器：
- `wire_requests`（真实网络请求，按目标计）——**节奏档限流只作用于它**；
- `tool_calls`（工具调用次数）——仅遥测，与限流无关（一次工具调用可能产生大量请求，二者不得混用）。
- 任务级效率遥测：tokens_in/out、wall_time、verified_fact_count（有效产出）。
  用途 = 角色编制与模型档位的效率决策（**操作员裁定 2026-10-02：预算不是门闸，效率才是目标**）；
  不设成本熔断。

## Consequences

正面：跨会话/跨实例的来源不冲突不混淆；修订先后可判定、晚到不覆盖、不重复计账；事实库故障时
补偿照常、审计可补齐；TTL 不会造成双重占用；限流与遥测职责分离，效率可度量。代价：adapter 必须上报
稳定 source_key 三元组（映射表约束）；op_log 成为第二个必持久化点；needs_review 与 quarantined
两个队列需要人处理。

## 验收（并入 v0.1 验收清单）

1. 成员幂等三例：{A}→{A,B} 不重复记账；同 source_key 高/低 revision_no 乱序到达时有效修订不被
   旧修订覆盖、不重复累计；重复回执无效。
2. 并发逆序：两个并发任务逆序 collect，成员按 source_key 独立入账，均有效。
3. 水位双校验：seq + snapshot + 证据 sha256 对账一致；导出后新写入不出现在旧报告。
4. 非所有者写连接被只读模式拒绝（负样本）。
5. fact.db 停写注入：补偿经 op_log 完成，资源实际拆除；恢复后审计补齐带 recovered_at。
6. TTL 到期未证实释放：资源进 quarantined、禁止再分配（负样本）。
7. auth_version 递增前后 engagement_id、库路径、既有租约不变。
