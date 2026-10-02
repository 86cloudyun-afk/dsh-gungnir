# 工具清单（自动生成，勿手改）

> 由 `node scripts/gen-docs.mjs --write` 生成；CI 用 `--check` 校验同步（防文档漂移）。
> 工具数：**31**；全部在预设允许清单中：**是**；角色：commander / recon / chain

| 工具 | 说明 | 参数（* = 必填） | 在允许清单 |
|---|---|---|---|
| `warroom_execute` | 唯一副作用入口：四元组 + 契约经服务端 broker 校验后派发 | `{ command_id*:string, engagement_id*:string, auth_version*:integer, action_class*:readonly|active|destructive, contract*:object, manual_approval_token:string }` | ✅ |
| `warroom_collect` | 回执入库（成员级幂等 + 代际隔离） | `{ engagement_id*:string, task_id*:string, receipt*:object }` | ✅ |
| `warroom_cancel` | 请求取消（幂等）；停止由资源清单逐项探针证实 | `{ engagement_id*:string, task_id*:string, reason:string }` | ✅ |
| `warroom_fact_query` | 事实查询（只读） | `{ engagement_id*:string, entity_type:string, source_id:string, since:string, include_history:boolean, adapter_instance:string, limit:integer }` | ✅ |
| `warroom_secret_put` | 登记秘密（host 加密 at-rest 存储）；返回 secret_ref，agent 永不见明文 | `{ plaintext*:string, label:string }` | ✅ |
| `warroom_secret_grant` | 为（secret × 任务 × 用途）签发限时解析授权；解析本身只能由 host 执行 | `{ secret_ref*:string, engagement_id:string, task_id*:string, purpose*:string, ttl_seconds:integer }` | ✅ |
| `warroom_secret_status` | 秘密与授权的元数据视图（仅 ref/label/TTL，绝不含明文） | `{ engagement_id*:string }` | ✅ |
| `warroom_report_export` | 导出战役报告（水位绑定 + IOC/清理附录初稿，全出口脱敏） | `{ engagement_id*:string, out_dir:string, format:md|json|html|both|all, max_facts_per_type:integer, audience:client|blue|full }` | ✅ |
| `warroom_status` | 任务全景：账本态 / 运行态 / 资源清单探针 / 尝试次数 | `{ engagement_id*:string, task_id*:string }` | ✅ |
| `warroom_reconcile` | 对账 unknown/unresolved 任务（探针定论，绝不默认失败重做） | `{ engagement_id*:string, task_id*:string }` | ✅ |
| `warroom_redispatch` | 重派 failed/unresolved 任务（attempt+1、换 generation，旧代回执隔离） | `{ engagement_id*:string, task_id*:string, reason:string }` | ✅ |
| `warroom_shell_status` | shell 状态三字段：历史最高证明 / 当前有效性 / 最后验证时间 | `{ engagement_id*:string }` | ✅ |
| `warroom_shell_verify` | 记录 shell 历史最高证明或再验证当前有效性（当前可控性不得由历史默认继承） | `{ engagement_id*:string, proof:string, validity:unknown|likely|confirmed_lost, evidence_ref:string }` | ✅ |
| `warroom_spray_check` | 喷洒前查断点：该(凭据×服务×账号)是否已试过、账号是否已锁定 | `{ engagement_id*:string, credential_ref*:string, service*:string, account*:string }` | ✅ |
| `warroom_spray_record` | 登记一次喷洒结果（success/fail/locked/skipped）；锁定后拒绝继续（防锁死） | `{ engagement_id*:string, credential_ref*:string, service*:string, account*:string, result*:success|fail|locked|skipped }` | ✅ |
| `warroom_metrics` | 效率遥测：记录任务级 tokens/耗时/有效产出，或查询战役聚合（无成本门闸） | `{ engagement_id*:string, command_id:string, tokens_in:integer, tokens_out:integer, wall_time_ms:integer, verified_facts:integer, role:string, model_tier:string }` | ✅ |
| `warroom_poc_search` | 知识库检索（跨战役复用）：按关键词/归类查 POC，打 Nday 前先查库 | `{ q:string, category:string, limit:integer, sort:relevance|recent|hits }` | ✅ |
| `warroom_poc_add` | 回填 POC 到知识库（默认强制脱敏：内网地址/自有痕迹一律拒绝） | `{ code*:string, title*:string, category*:string, source:string, affected_versions:string, evidence_ref:string, body:string }` | ✅ |
| `warroom_poc_use` | 登记 POC 在某战役某资产上的使用（跨战役复用留痕） | `{ code*:string, engagement_id*:string, asset:string, result:string }` | ✅ |
| `warroom_sweep_timeouts` | 超时治理：运行超阈值的任务转 unknown（绝不自动重试，交由 reconcile 定论） | `{ engagement_id*:string, timeout_min:integer }` | ✅ |
| `warroom_evidence_export` | 证据落盘：报告 + 水位 + 三段式 EVIDENCE_INDEX（凭据仅引用，无明文） | `{ engagement_id*:string, out_dir:string, target:string, audiences:array }` | ✅ |
| `warroom_spray_matrix` | 凭据喷洒矩阵：展开 凭据×服务×账号，标注断点/锁定并给出可执行格子 | `{ engagement_id*:string, credentials*:array, services*:array, accounts:array }` | ✅ |
| `warroom_audit` | 审计查询/导出：门闸每次判定（allow/deny/meeting/settle/timeout…）可查可交 | `{ engagement_id*:string, decision:string, since:string, limit:integer, offset:integer, order:asc|desc, export_dir:string, export_format:jsonl|csv }` | ✅ |
| `warroom_jumps` | 跳板台账：主机/租约/路由总览；动作 release / sweep（到期租约）/ sweep_routes（活跃路由巡检）/ heartbeat（路由续期） | `{ engagement_id*:string, action:status|release|sweep|sweep_routes|heartbeat, route_id:string }` | ✅ |
| `warroom_secret_rotate` | 轮换秘密库密钥：旧密钥归档（600）并重加密全部秘密；旧秘密仍可解 | `{ confirm*:boolean }` | ✅ |
| `warroom_egress_check` | 出口验证：记录一次出口 IP 结果（pass/fail）或查询状态（框架 §11 门闸） | `{ engagement_id*:string, action:status|record, jumphost_id:string, exit_ip:string, route_id:string, verdict:pass|fail }` | ✅ |
| `warroom_heartbeat` | 长时任务心跳：上报进度，超时巡检改以最近心跳为基准（避免长任务被误判） | `{ engagement_id*:string, task_id*:string, note:string }` | ✅ |
| `warroom_preflight` | 开工前预检：环境/配置/战役/出口/备份/秘密 → ready|degraded|blocked | `{ engagement_id*:string, meeting_tasks:array, record:boolean }` | ✅ |
| `warroom_aggregate` | 跨会话聚合视图（只读）：本框架各战役事实 + DSH 聚合库战果，永不写入对方库 | `{ sessions_db*:string }` | ✅ |
| `warroom_timeline` | 战役时序（只读）：立项→派发→回执→结项→控制面→交付 的事件时间线 | `{ engagement_id*:string }` | ✅ |
| `warroom_watch` | 巡检统一视图（只读）：路由/在飞任务/出口验证/壳状态 + 需要注意的事项 | `{ engagement_id*:string, timeout_min:integer }` | ✅ |

## 约定

- 副作用只能经 `warroom_execute`（服务端 broker 校验四元组）；其余工具为查询/登记。
- 新增工具必须：进 `presets/warroom.preset.json` 的 allow（否则预设闸失败），并重跑本生成器。
- 秘密相关工具只到 `secret_ref` 粒度，解析（resolve）只存在于 host 侧，无对应工具。
