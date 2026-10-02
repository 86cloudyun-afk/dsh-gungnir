# 工具清单（自动生成，勿手改）

> 由 `node scripts/gen-docs.mjs --write` 生成；CI 用 `--check` 校验同步（防文档漂移）。
> 工具数：**20**；全部在预设允许清单中：**是**；角色：commander / recon / chain

| 工具 | 说明 | 参数（* = 必填） | 在允许清单 |
|---|---|---|---|
| `warroom_execute` | 唯一副作用入口：四元组 + 契约经服务端 broker 校验后派发 | `{ command_id*:string, engagement_id*:string, auth_version*:integer, action_class*:readonly|active|destructive, contract*:object, manual_approval_token:string }` | ✅ |
| `warroom_collect` | 回执入库（成员级幂等 + 代际隔离） | `{ engagement_id*:string, task_id*:string, receipt*:object }` | ✅ |
| `warroom_cancel` | 请求取消（幂等）；停止由资源清单逐项探针证实 | `{ engagement_id*:string, task_id*:string, reason:string }` | ✅ |
| `warroom_fact_query` | 事实查询（只读） | `{ engagement_id*:string, entity_type:string }` | ✅ |
| `warroom_secret_put` | 登记秘密（host 加密 at-rest 存储）；返回 secret_ref，agent 永不见明文 | `{ plaintext*:string, label:string }` | ✅ |
| `warroom_secret_grant` | 为（secret × 任务 × 用途）签发限时解析授权；解析本身只能由 host 执行 | `{ secret_ref*:string, engagement_id:string, task_id*:string, purpose*:string, ttl_seconds:integer }` | ✅ |
| `warroom_secret_status` | 秘密与授权的元数据视图（仅 ref/label/TTL，绝不含明文） | `{ engagement_id*:string }` | ✅ |
| `warroom_report_export` | 导出战役报告（水位绑定 + IOC/清理附录初稿，全出口脱敏） | `{ engagement_id*:string, out_dir:string, format:md|json|both }` | ✅ |
| `warroom_status` | 任务全景：账本态 / 运行态 / 资源清单探针 / 尝试次数 | `{ engagement_id*:string, task_id*:string }` | ✅ |
| `warroom_reconcile` | 对账 unknown/unresolved 任务（探针定论，绝不默认失败重做） | `{ engagement_id*:string, task_id*:string }` | ✅ |
| `warroom_redispatch` | 重派 failed/unresolved 任务（attempt+1、换 generation，旧代回执隔离） | `{ engagement_id*:string, task_id*:string, reason:string }` | ✅ |
| `warroom_shell_status` | shell 状态三字段：历史最高证明 / 当前有效性 / 最后验证时间 | `{ engagement_id*:string }` | ✅ |
| `warroom_shell_verify` | 记录 shell 历史最高证明或再验证当前有效性（当前可控性不得由历史默认继承） | `{ engagement_id*:string, proof:string, validity:unknown|likely|confirmed_lost, evidence_ref:string }` | ✅ |
| `warroom_spray_check` | 喷洒前查断点：该(凭据×服务×账号)是否已试过、账号是否已锁定 | `{ engagement_id*:string, credential_ref*:string, service*:string, account*:string }` | ✅ |
| `warroom_spray_record` | 登记一次喷洒结果（success/fail/locked/skipped）；锁定后拒绝继续（防锁死） | `{ engagement_id*:string, credential_ref*:string, service*:string, account*:string, result*:success|fail|locked|skipped }` | ✅ |
| `warroom_metrics` | 效率遥测：记录任务级 tokens/耗时/有效产出，或查询战役聚合（无成本门闸） | `{ engagement_id*:string, command_id:string, tokens_in:integer, tokens_out:integer, wall_time_ms:integer, verified_facts:integer, role:string, model_tier:string }` | ✅ |
| `warroom_poc_search` | 知识库检索（跨战役复用）：按关键词/归类查 POC，打 Nday 前先查库 | `{ q:string, category:string }` | ✅ |
| `warroom_poc_add` | 回填 POC 到知识库（默认强制脱敏：内网地址/自有痕迹一律拒绝） | `{ code*:string, title*:string, category*:string, source:string, affected_versions:string, evidence_ref:string, body:string }` | ✅ |
| `warroom_poc_use` | 登记 POC 在某战役某资产上的使用（跨战役复用留痕） | `{ code*:string, engagement_id*:string, asset:string, result:string }` | ✅ |
| `warroom_sweep_timeouts` | 超时治理：运行超阈值的任务转 unknown（绝不自动重试，交由 reconcile 定论） | `{ engagement_id*:string, timeout_min:integer }` | ✅ |

## 约定

- 副作用只能经 `warroom_execute`（服务端 broker 校验四元组）；其余工具为查询/登记。
- 新增工具必须：进 `presets/warroom.preset.json` 的 allow（否则预设闸失败），并重跑本生成器。
- 秘密相关工具只到 `secret_ref` 粒度，解析（resolve）只存在于 host 侧，无对应工具。
