# CHANGELOG

## Unreleased

### Added
- **规模冒烟与性能门**（`scripts/bench.mjs`）：事实入库 / 快照 / 报告 / 复现校验的耗时阈值；
  实测 N=5000 时入库 17ms、快照 11ms、报告 90ms、校验 11ms（阈值 3000/1000/3000/1000ms）
- **ADR-004**：v0.2 冻结边界（围栏运行验收 / 进程级取消证实 / 知识库 / 真实应答器接入），
  明确不做项（UI→v0.3、marketplace→v0.3、PentAGI 不做）
- **QUICKSTART**：CLI 全链路真实演练（含捕获输出与两阶段停止语义说明）
- **IOC 自动聚合**（v0.2 项提前落地）：结构化条目（kind/ref/source/evidence_ref/confidence/
  manual_confirm），去重（kind+ref）与清单摘要哈希；凭据只出引用、明文不进报告
- **报告 JSON 双格式**（`gungnir-report/1`）：与 markdown 同水位同摘要（同一份证据两个视图），
  JSON 同样过 redactor；`report --format md|json|both`（CLI/工具/API 三入口）
- **自审闸**（CI 第五闸，`scripts/self-review.mjs`）：秘密扫描（合成示例需显式标记）、
  文档相对链接可达、验收表引用路径存在、代码卫生（src 无 console.log / 测试无 skip·only /
  未标注来源的 TODO）、CI 四闸覆盖自检；闸门自身有齿（注入真凭据形态与死链必须失败）
- **DSH 桥应答器参考实现**（`scripts/dsh-bridge-responder.mjs`）：消费 `gungnir-bridge/1` 协议，
  echo/fixture 两种模式、幂等（同 external_id 只处理一次）、原子写；
  **跨进程端到端测试**（GUNGNIR 与应答器分属不同进程，仅经 spool 通信）
- **桶 A 容器围栏**（ADR-001 验收 5）：拓扑计划 + 9 类静态不变量 fail-closed 校验 +
  docker 命令序列 + 运行时验收（daemon 不可用如实 SKIP，**绝不假装通过**）；
  一键复跑：`node scripts/fence-verify.mjs --engagement <id> --socks <route>`
- **DSH 插件包骨架** `packages/warroom-plugin`：host 服务工厂（三种 adapter：fake/local/bridge）、
  `apply(ctx)` cordis 契约（注册 `ctx.warroom` + dispose 收尾）、DSH 工具包装
  （16 个工具 → `execute` 绑定 host 服务，包装层做四元组预检）、启动即再水化
- CLI 全子命令补全（verify-report / shell / spray / metrics），覆盖全部 16 个工具的能力面
- **挂载部署脚本** `scripts/deploy-dsh.mjs`（--check / --print / --apply）：
  patch 层只允许脚本改（多方维护冲突高发），apply 前自动备份、幂等不重复插入
- 报告**证据摘要**（sha256：整体 + 按 entity_type）与**复现校验器**
  （`scripts/verify-report.mjs` / `broker.verifyReport`）：对照当前库判定报告是否仍可复现，
  有漂移如实回报（退出码 3），不修数据
- 效率遥测（ADR-002 D10）：任务级 `tokens_in/out`、`wall_time_ms`、`verified_facts`（同任务幂等覆盖），
  战役聚合给出 `by_role` 视图与端到端指标（`facts_per_1000_tokens`、`ms_per_fact`）——
  **无成本门闸**，服务于编制与档位决策；跨战役记录被拒
- 多战役隔离测试：任务/事实/度量互不串味；共享跳板池全局单份记账（租约按战役归属）
- schema v5（task_metrics）
- shell 状态三字段 API（ADR-002 D8）：`recordShellProof`（历史最高证明）与 `verifyShell`
  （当前有效性，仅 unknown/likely/confirmed_lost，必须由再验证驱动——拿过 root ≠ 现在仍可控）
- 凭据喷洒台账（宪法反模式 5/6 库化）：断点查询（避免重复爆破）与**防锁死**（账号 locked 后一律拒绝）
- 工具集扩到 15 个（shell_status / shell_verify / spray_check / spray_record）；
  预设允许清单同步更新（新增工具必须显式进清单的摩擦按设计生效）
- **DSH 桥驱动**（`adapters/dsh-bridge.js` + `docs/DSH-BRIDGE-PROTOCOL.md`）：
  以 spool 文件协议与 DSH 侧执行层通信（原子写、幂等 external_id、崩溃可恢复）；
  超时 → unknown 且 spool 留待办 job（绝不自动重试）
- 一致性套件升级为**异步停止确认感知**（`awaitStopMs`）：把 ADR-003「cancel 是请求、
  证实要探针」的语义编进契约检查；桥驱动与本地驱动共用同一套件
- 故障注入矩阵（框架 §10，CI 第四闸）：丢回包 / 乱序与重复回执 / 事实库写失败 /
  进程残留 / 重启恢复 / 撤销跨重启，六场景一键复跑（`scripts/fault-matrix.mjs`）
- 再水化提升为公共 API（`rehydrate`）：只恢复非终态命令，终态不重建；CLI 复用同一实现
- CLI（`bin/warroom.mjs`）：engage / exec / collect / status / cancel / revoke / report / secret /
  jump / adapter 全部子命令 + `--json`；门闸与授权在 CLI 路径上同样强制
- **adapter 再水化**（`hydrate`）：跨进程恢复任务状态（CLI 每次调用是新进程；真实驱动同样需要
  向执行层查询既有任务的语义）
- 三角色预设（commander/recon/chain）+ 允许清单 `presets/warroom.preset.json` + 挂载文档 `docs/PRESET.md`；
  CI 新闸 `scripts/check-preset.mjs`（清单必须覆盖全部工具、危险能力必须显式拒绝、角色文件必须齐备）
- Adapter 一致性套件（9 项契约检查，含负样本"有齿"验证）：FakeAdapter 与
  RedteamModeAdapter(LocalDriver) 全绿，任何新执行层换进来先过此套件
- redteam-mode 桥骨架：SPI → 五角色映射、Driver 接口、`docs/REDTEAM-BRIDGE.md`（真实驱动留 v0.2 集成）
- 报告导出器（框架 §5）：markdown 报告 = 客户攻击报告 = 蓝队 IOC 排查清单（同一份证据两个视图）；
  水位（seq + snapshot_id + exported_at）入正文与文件名；IOC/清理附录半自动初稿（隧道 / 未完成任务 /
  隔离态资源 / 凭据引用）；全出口脱敏（明文秘密 + 形态正则）；导出后新增事实不进旧报告
- 工具：warroom_report_export / warroom_status / warroom_reconcile / warroom_redispatch（共 11 个）
- 对账与重试（ADR-003 D3/D6）：\`reconcile\` 只接受 unknown/unresolved、资源残留则维持挂起、
  探针定论绝不自动重做；\`redispatch\` 升 attempt 换 generation，旧代回执继续隔离；
  \`status\` 全景（账本态/运行态/清单探针/尝试次数）
- 状态迁移表强制：非法迁移报 \`E_INVALID_TRANSITION\`（迁移表补齐 unknown→unresolved、failed→running 等边）
- 修复：丢回包/去重返回路径补 generation（调用方在任何分支都能拿到代际）
- 迁移框架按版本号排序执行（数组顺序不再影响结果）；schema v4（command_queue.attempt）
- 节奏闸（ADR-002 D10 / 框架 §4）：并发上限（open 3 / restricted 2 / stealth 1）、
  wire_requests 滚动预算（100000 / 1000 / 100）、stealth 档 8s 最小间隔（响应带 retry_after_ms）；
  按规格修正：restricted **无**最小间隔（此前的 1s 限制为过度实现）
- 人工批准注册表：destructive 必须携带已登记令牌（跨战役/过期/重复使用分别拒绝），
  审批留痕 issued_by / used_by_command；schema v3 迁移（global 专属）
- 授权窗口 5s 时钟偏移容差
- 秘密边界（ADR-001 D7）：AES-256-GCM at-rest 加密、密钥文件 600/目录 700、
  权限化 resolve（secret × 任务 × 用途 × TTL）、全出口脱敏（gate_log / collect / 错误路径 /
  形态正则：token、私钥、kv 口令）
- schema v2 迁移（global 库专属）：secret_store / secret_grants；迁移按 labels 过滤
- 工具：warroom_secret_put / warroom_secret_grant / warroom_secret_status（无 resolve 工具——解析仅 host 可用）
- CI 三闸之一：工具 schema 严格校验器（DSH 挂载会因非法 schema 整组失败）
- GitHub Actions：验收套件 + schema 校验（node 22.x）

### Fixed
- **误写真实 profile**：部署脚本原先优先读 `DSH_PROFILE_DIR` 环境变量，在本机（真实 DSH 会话）
  执行测试时把预设行写进了操作员的 profile —— 已按备份**逐字节回滚**并在真实文件上验证
  "warroom 残留 0"；修正为 `--home` 优先，测试隔离清空 DSH 环境变量；备份/幂等行为补回归测试。
  （教训：脚本在"看起来是测试"的上下文里仍可能触达真实环境——涉及全局配置的写入必须有
  显式目标与隔离测试。）

## v0.1.0-alpha.3 — 2026-10-02

批次 2（PR #11–#19，+外部 #18 安全修复）合并入 main。合并后：测试 **94/94**、
工具 **16** 个、四闸全绿。审查记录：`docs/MERGE-REVIEW-2-2026-10-02.md`。

要点：CLI 全子命令与部署脚本、故障注入矩阵（CI 第四闸）、DSH 桥驱动与协议、
**scope 通配越权修复（外部贡献）**、shell 三字段、喷洒防锁死、效率遥测、报告复现校验。

## v0.1.0-alpha.2 — 2026-10-02

批次 1（PR #1–#10）合并入 main：CI 三闸、迁移与备份、秘密边界、节奏闸与人工批准、
reconcile/redispatch、报告导出、adapter 一致性套件、三角色预设。
其中 PR #7 / #9 为外部贡献（取消探针一次、command_id 服务端校验），审查记录见
`docs/MERGE-REVIEW-2026-10-02.md`。合并后：测试 63/63、工具 schema 11/11、预设闸通过。

## v0.1.0-alpha.1 — 2026-10-02

### Added
- `packages/shared-types`（批次 0 alpha 冻结）：任务状态机与合法迁移表、错误码枚举、
  四元组/契约/回执校验、source_key/generation 构造器
- `packages/warroom-core`：
  - FactStore：成员级幂等入库（source_key + revision_no）、seq 与水位快照、计量双计数器
  - Broker：四元组门闸、命令队列（派发幂等）、撤销级联、取消与资源清单逐项证实、代际隔离
  - JumphostManager：op_log 先行补偿、TTL 实测证实、quarantined 隔离态
  - FakeAdapter：SPI rev2 参考实现 + 故障注入（丢回包 / 资源残留）
- 验收负样本套件 20 例全绿（框架 §8 清单可离线验证项）
- 规格与三份 ADR 入仓（docs/），README 治理入口
