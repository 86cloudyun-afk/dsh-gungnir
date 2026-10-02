# CHANGELOG

## Unreleased

### Added
- 文档收口：ACCEPTANCE 增 7 行验收映射（路由生命周期/任务心跳/拓扑/知识库复用/门禁/桥接一致性）
  与数字同步（251 例 / 27 工具 / 故障矩阵 14 场景）、README 改用 `npm run ci`、QUICKSTART 增门禁速查
- **一致性套件跑真实桥接 adapter**（跨进程回归）：新增 `test/conformance-bridge.test.js`；
  并修掉它逼出的三个真问题——桥接 adapter 的 `manifestOf` 不再只依赖应答器文件
  （宿主按契约声明资源 + **延迟绑定**实测状态，fail-closed 但不会"一次 false 永远 false"）；
  应答器 `fixture` 模式缺夹具时**不再静默返回空资源**（改为报错留痕，绝不写假回执）
- **故障矩阵 11→14 场景**：路由失效→围栏拒绝（`E_FENCE_NO_ROUTE`）、长任务心跳失效→unknown
  （基准标为 heartbeat）、知识库未脱敏→拒绝入库；`addPoc` 改为**显式拒绝未知字段**
  （静默丢字段 = 静默丢证据，与配置校验同一哲学）
- **报告攻击路径拓扑**（`topology.js`）：按事实 payload 的显式引用（`steps`/`path`/`achieved_via`）
  画边、隐式引用（`asset`/`target`/`host`/`via`/`source_ref`/`unlocks`）补边并标注「推断」；
  报告 md 出 mermaid `flowchart LR` 图 + JSON `topology`；**无引用不画边**，
  并如实提示"有 N 条弱点/链路/控制面事实未给出引用关系"
- **单命令门禁** `npm run ci`（`scripts/ci.mjs`）：顺序跑六道闸，打印逐闸退出码与汇总结论，
  任一失败即非零退出；支持 `--list` / `--only <names>`。自审闸规则同步**加强**：
  校验 CI 入口确实覆盖六道闸（runner 指向也算），并核对 runner 内登记的闸数
- **报告收录知识库复用**：`KnowledgeBase.usageByEngagement`（按战役查 POC 使用记录，含标题/分类/
  资产/结果）→ 报告 md 新增「知识库复用（POC 使用记录）」段 + JSON `kb_usage`；未使用则不出现该段
- **长时任务心跳**（schema v8）：`broker.heartbeat(engagementId, taskId, {note})` / 工具
  `warroom_heartbeat`（27 个工具）/ CLI `warroom heartbeat`；`sweepTimeouts` 改以**最近心跳**
  为基准（并在结果里标明 `since: heartbeat|dispatch`）——正常跑很久的任务不再被误判超时；
  终态任务拒绝心跳
- **活跃 route 生命周期**：`heartbeatRoute`（续期租约 + 刷新路由时间 + 留痕）、
  `sweepRoutes`（租约释放/到期或长时无心跳 → 路由转 `stale`，围栏不再取该出口，
  只改状态不删记录）；工具 `warroom_jumps` 增 `sweep_routes` / `heartbeat`，CLI `jump sweep-routes|heartbeat`；
  战役清单由宿主注入（路由属战役库，global 无索引）
- 文档收口：ACCEPTANCE 增 8 行（备份保留/波次联动/自校验/事实查询/出口实跑/套件入口）、
  README 数字同步（229 例 / 26 工具）、QUICKSTART 增「全部子命令索引」
- **一致性套件独立入口**：`scripts/conformance.mjs [--module <path>]` + CLI `warroom conformance`
  ——外部 adapter 作者可对自己的 adapter 跑同一套 SPI rev2 契约检查（8 项，含幂等与资源清单），
  失败项逐条列出并非零退出。**修掉一个真 bug**：`summarize().failed` 是数组，
  原脚本用 `> 0` 判断导致坏 adapter 也返回 0
- **出口验证实跑脚本** `scripts/egress-check.mjs`：经 route 的 SOCKS 出口回显端点比对登记地址，
  或 `--self`（操作节点自身出口，**检测到代理环境变量即拒绝**）；结果自动入账；
  退出码语义化（0 通过 / 1 不匹配 / 2 前置缺失 / 3 SKIP——环境不可用即如实 SKIP，不伪造通过）；
  支持 `--observed` 离线补录。`doctor` 新增「出口验证门闸」检查（强制中但无有效 pass → warn）
- **出口验证门闸**（框架 §11）：`recordEgressCheck` / `egressStatus` / `assertEgressVerified`
  ——验证结果入 `egress_checks` 并留痕 gate_log；配置 `requireEgressCheck=true`（+ `egressMaxAgeMin`）
  时，**出网动作必须有有效期内的 pass**，否则 `E_GATE_EGRESS_UNVERIFIED`（默认关闭，不阻塞既有用法）；
  工具 `warroom_egress_check`（26 个工具）、CLI `warroom egress status|record`
- **事实查询下沉并补齐 CLI**：`store.queryFacts({entityType, sourceId, since, includeHistory, adapterInstance, limit})`
  成为工具与 CLI 的唯一实现；`warroom fact --type/--source/--history/--adapter/--limit`
  （默认只看有效事实，`--history` 可看被取代修订与取代总数）；工具 schema 同步扩展
- **报告自校验**：导出瞬间对照当前库复核水位与证据摘要，把结论写进 md（「自校验（导出时即时复核）」段）
  与 JSON（`self_check` 字段）——交付物自带"可否复现"的结论与复核命令
- **波次与节奏档联动**：波内同时在飞任务不超过档位上限（open=3 / restricted=2 / **stealth=1**），
  名额占满时先收执结项释放（依赖驱动不变）；波结束仍有未结项任务 → **如实报错**，
  杜绝"看起来跑完"；演练计划同步给出 `max_in_flight` 与节奏档
- **备份保留与恢复演练**：`backup --keep N`（只轮转自动备份，手工 dest 不动）；
  `restore --from <dir>` 默认 **dry-run**（计划 + 完整性校验，不改数据），`--apply` 前**先做恢复前快照**
  并提示重启宿主进程；损坏备份被识别（非零退出）
- **性能门再扩展**：证据落盘（4000ms）与全库备份（6000ms）纳入矩阵；
  实测 N=5000：证据落盘 153ms、备份 9.9ms、RSS 176MB
- **围栏 ↔ 跳板联动**：`planFenceForEngagement` 从战役库读**活跃 route** 作为围栏唯一上游
  （无活跃 route 即 `E_FENCE_NO_ROUTE`，fail-closed）；静态校验新增"上游与 route 记录一致"不变量；
  `fence-verify --from-home/--route` 支持真实联动（缺 route 时非零退出并给取出口命令）
- 文档收口：QUICKSTART 增「维护与安全动作」（backup/maintain/rotate/doctor + 抖动说明）、
  ACCEPTANCE 增 4 行能力映射与数字刷新、README 同步
- **故障矩阵扩展 6→11 场景**：新增持久层韧性——**备份恢复往返**（篡改后回归备份时点 + 完整性）、
  密钥缺失明确报错、非法配置构造即失败、高版本库拒绝打开、老库迁移自动补齐后继续作业
- **备份/维护内建**：`maintenance.js`（`backupHome` / `latestBackup` / `checkpointHome`）由
  脚本、CLI（`warroom backup` / `maintain`）、`doctor` 共用；`doctor` 新增**备份新鲜度**检查
  （>7 天或从未备份给 warn）；`scripts/backup.mjs` 改为复用 API（行为不变）
- **报告体量控制**：md 报告每类事实默认最多列 50 条（`--max-facts` / `max_facts_per_type` 可调），
  超出只给计数与提示（**全量仍在 JSON 视图**）；返回 `size{md_bytes,facts}`
- **密钥轮换**（高级秘密管理）：`rotateKey()` 归档旧密钥（`keys/<key_id>.bin`，600）→ 换新密钥 →
  **单事务重加密全部秘密**并更新 `key_id`（schema v7）；旧秘密轮换后照常可解（历史密钥参与解密），
  缺少历史密钥时**明确报错**而不是静默失败；工具 `warroom_secret_rotate`（需 `confirm=true`）、
  CLI `secret rotate --confirm`
- **stealth 档抖动与漂移**（框架 §4 完整落地）：实际最小间隔在 [8s, 25s] 内随机抖动，
  再按小时做 ±20% 漂移（同一小时内稳定、跨小时变化）——**不让固定周期成为流量指纹**；
  `rng` 可注入（测试确定性）；漂移永不低于基础地板
- **机器可读 schema 导出** `docs/tools.schema.json`（`gungnir-tools/1`：24 个工具的
  name/description/input_schema + 允许清单命中 + 预设角色），随代码同步校验（漂移即 CI 失败）
- **`warroom init` 首启向导**：建家目录 → 写示例配置（已存在则保留，`--force` 覆盖）→
  `--with-jumphost-sample` 导入占位跳板 → `--target` 建首个战役 → 打印下一步命令清单
- **审计分页与 CSV 导出**：`audit({limit, offset, order})` 返回 `page{matched,has_more}`；
  `auditExportCsv`（RFC4180 转义、可按 decision/since 过滤）；工具与 CLI 同步暴露
  （`--limit/--offset/--order/--format csv`）
- **家目录配置** `$WARROOM_HOME/warroom.json`：默认节奏档 / sweep 超时 / adapter 类型 /
  桥超时 / 围栏镜像 / 波内并发提示；**非法或未知字段明确报错**（不静默忽略，避免"以为生效了"）；
  `warroom config show|init [--force]`；Broker 与插件服务都读取它
- **验收映射刷新**：`docs/ACCEPTANCE.md` 新增「批次 4–6 新增能力 → 判据/证据/状态」映射表（15 项）
- **执行器接入闭环**：`docs/DSH-EXECUTOR.md`（三步接法 + 语义约束表 + 接入检查单）、
  `executors/example-role-cmd.mjs`（可跑示例：按 role 产出占位事实与资源）；
  **三方端到端回归**（GUNGNIR ↔ 应答器子进程 ↔ 执行器孙进程）
- **波次演练模式** `warroom wave --dry-run`：只出计划（依赖序、**同层可并行分组**、会议预览、
  各任务动作类别与资源类型），**不落库、不派单、不占并发名额**；演练与执行共用同一依赖判定，
  成环/悬空依赖在演练阶段即暴露
- **性能门扩展**：规模冒烟新增审计导出、JSON 报告、喷洒矩阵三项阈值；
  实测 N=5000 时：入库 18ms / 快照 12ms / md 报告 90ms / **json 报告 145ms** / 审计 0.4ms / 矩阵 9ms
- **`warroom doctor` 一键体检**：Node/sqlite 版本、docker daemon（不可用给 warn 不误报 fail）、
  WARROOM_HOME 可写、global 与各战役库完整性 + schema 版本、秘密密钥权限、知识库存在性；
  支持 `--json`；失败项非零退出，提示项不阻塞
- **跳板台账与收口**：`JumphostManager.status`（主机/租约/路由总览）、`releaseRoute`（幂等收口）；
  工具 `warroom_jumps`（status/release/sweep，工具数 23→24）、CLI `jump status|release`
- **报告全景补强**：md 增「审计摘要（门闸判定分布）」与「跳板与隧道台账」两段，
  JSON（`gungnir-report/1`）增 `audit_summary` 与 `jump_routes` 字段——一份报告说清战役全貌
- **审计查询与导出**：`broker.audit`（按 decision/since 过滤 + 决策分布）、`broker.auditExport`
  （JSONL，行数一致、写入时已脱敏）；工具 `warroom_audit`（工具数 22→23）、CLI `warroom audit`
  （查询 / 导出两路）；拒绝路径同样留痕（deny 可追溯）
- **凭据喷洒矩阵**（框架 §5.1）：`sprayMatrix`（凭据 × 服务 × 账号展开，标注 tried/locked，
  只有 `run` 格子进 ready 列表）+ `sprayApply`（批量登记，重复格子跳过、**锁定结果切断后续**）；
  工具 `warroom_spray_matrix`（工具数 21→22）
- **应答器执行器插件**（ADR-004 项 4 收尾）：`--executor <path>` 挂载
  `{ name, run(job) }`；内置 `echo-executor`（彩排）与 `dsh-redteam-executor`
  （按 `GUNGNIR_EXECUTOR_CMD` 调外部执行器，stdin job → stdout 回执）；
  **未配置/输出非法即失败、绝不写假回执**；失败可重试且不破坏幂等
- **效率视图增强**（ADR-002 D10）：新增 `by_tier`（模型档位分桶）与 `rework`
  （重派任务数 / 返工率 / unresolved / unknown 计数）；角色与档位桶均带
  `facts_per_1000_tokens` 与 `ms_per_verified_fact`——「谁划算」有数字可依，仍无成本门闸
- **多方维护治理文件**：`CONTRIBUTING.md`（六闸门槛/PR 规范/写作用域/外部 PR 审查流程）、
  `.github/CODEOWNERS`、PR 模板（六闸勾选项）、ADR 提案与缺陷报告议题模板
- **证据落盘桥**（对齐作战室第 8 节纪律）：`warroom evidence --engagement <id> --out <dir> [--target <名>]`
  → 目录内 `report-<seq>.md` / `report-<seq>.json` / `watermark.json` /
  **`EVIDENCE_INDEX.md`（Confirmed / Leaked credentials(仅引用) / Raw artifacts 三段式）**；
  明文秘密永不落盘（回归断言索引与报告均无明文）
- **超时治理**（ADR-003 D3）：`broker.sweepTimeouts` / `warroom_sweep_timeouts` / CLI `sweep`——
  运行超阈值任务转 `unknown`，**绝不自动重试**（回归断言：清扫不新增命令、不重派），
  留痕 gate_log，交由 reconcile 依证据定论；默认 30 分钟
- **围栏真实验收在 CI 通关**（证据 run 36944503518）：internal 网络 + sidecar 双挂 + 任务容器，
  直连出网被阻断；验收表 §8-9 更新为 ✅ 并附证据链接
- 报告收录**链前会议纪要**（md 段 + json `meetings`）：波次与报告的追溯链闭合；
  QUICKSTART 增补波次章节，PRESET.md 标注运行时入口
- **波次编排**（框架 §3.5 运行时语义）：`warroom wave --engagement <id> --meeting <file>` ——
  会议纪要落库（会不开波不发）→ 按依赖派单 → 独立任务立即并行、依赖满足即刻交接（波内无屏障）
  → 回执按成员级幂等入库 → 执行器报终态后**结项**（`broker.settle`）；成环/悬空依赖如实报错
- **迁移框架按 label 计算目标版本**（真 bug 修复）：v6 是 fact 专属迁移，此前会把 global 库
  也盖成 6；现在每个库有自己的目标版本（fact=6、global=5），高版本库仍拒绝打开
- **围栏真实验收进 CI**（ADR-004 范围项 1）：新增 `fence` job（GitHub runner 自带 docker daemon），
  `--require-daemon` 让 daemon 不可用时**失败而非静默通过**；本地无 daemon 时默认 SKIP（退出 0）
- **进程级取消证实**（ADR-004 范围项 2）：真实探针 `probes.js`（PID 存活 / TCP 端口监听 /
  容器 inspect；探针不可用一律 fail-closed 视作未证实）；资源清单支持描述对象
  （`{kind:'process',pid}` / `{kind:'port',port}` / `{kind:'container',container_id}`）；
  回归用**真实子进程**：子进程仍在 → unresolved，杀掉后 → confirmed_stopped；
  reconcile 同样不把"进程仍在"判成完成
- **知识库**（ADR-004 范围项 3）：`$home/knowledge.db` 全局单份，POC 条目（code/title/14 类归类/
  来源/影响版本/证据引用）+ 跨战役使用留痕；**回填强制脱敏**（内网 IPv4、环回、内部域名后缀、
  未替换占位一律拒绝；显式 `allow_unsanitized` 必须写理由并入审计字段）
- 工具面 `warroom_poc_search / add / use`（工具数 19），预设允许清单与工具文档同步刷新
- **工具文档自动生成与同步校验**（`scripts/gen-docs.mjs`，CI 第六闸）：`docs/TOOLS.md` 由代码生成，
  `--check` 检出漂移（含"新增工具必须进允许清单"的约定说明）
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

## v0.1.0-alpha.9 — 2026-10-02

批次 8（PR #61–#68，8 条）合并入 main。合并后**六闸全绿**：测试 229/229、工具 **26** 个、
预设允许清单、故障矩阵 11/11、工具文档与 schema 同步、自审闸。
审查记录：`docs/MERGE-REVIEW-8-2026-10-02.md`。

要点：备份保留与恢复演练、波次与节奏档联动、报告自校验、事实查询与 CLI、出口验证门闸与实跑、
一致性套件独立入口、文档收口。

## v0.1.0-alpha.8 — 2026-10-02

批次 7（PR #53–#60，8 条）合并入 main。合并后**六闸全绿**：测试 203/203、工具 25 个、
预设允许清单、**故障矩阵 11/11**、工具文档与 schema 同步、自审闸。
审查记录：`docs/MERGE-REVIEW-7-2026-10-02.md`。

要点：stealth 抖动与漂移、密钥轮换、报告体量控制、备份/维护内建、故障矩阵扩展、
围栏与跳板联动、性能门扩展。

## v0.1.0-alpha.7 — 2026-10-02

批次 6（PR #45–#52，8 条）合并入 main。合并后**六闸全绿**：测试 186/186、工具 24 个、
预设允许清单、故障矩阵、工具文档与 schema 同步、自审闸。审查记录：`docs/MERGE-REVIEW-6-2026-10-02.md`。

要点：性能门扩展、波次演练（dry-run）、执行器接入指南与三方端到端、验收映射刷新、
家目录配置、审计分页与 CSV、`warroom init` 首启向导、机器可读 schema 导出。

## v0.1.0-alpha.6 — 2026-10-02

批次 5（PR #37–#44，8 条）合并入 main。合并后**六闸全绿**：测试 169/169、工具 **24** 个、
预设允许清单、故障矩阵、工具文档同步、自审闸。审查记录：`docs/MERGE-REVIEW-5-2026-10-02.md`。

要点：效率视图（档位分桶 + 返工率）、执行器插件（fail-closed）、喷洒矩阵（扩散防护）、
审计查询/导出、报告全景（审计+跳板台账）、跳板收口、文档收口、`warroom doctor`。

## v0.1.0-alpha.5 — 2026-10-02

批次 4（PR #29–#36，8 条）合并入 main。合并后**六闸全绿**：测试 145/145、工具 21 个、
预设允许清单、故障矩阵、工具文档同步、自审闸。审查记录：`docs/MERGE-REVIEW-4-2026-10-02.md`。

要点：知识库（强制脱敏）、进程级取消证实（真实探针）、围栏真实验收进 CI 并通关、
波次编排（会议纪要+依赖立即交接）、超时治理、证据落盘桥（三段式索引）、多方维护治理文件。

## v0.1.0-alpha.4 — 2026-10-02

批次 3（PR #21–#28，8 条）合并入 main。合并后**六闸全绿**：测试 118/118、工具 schema 16/16、
预设允许清单、故障矩阵 6/6、工具文档同步、自审闸。审查记录：`docs/MERGE-REVIEW-3-2026-10-02.md`。

要点：DSH 插件包骨架、桶 A 围栏（拓扑+静态不变量+运行脚本）、桥应答器（跨进程端到端）、
自审闸、IOC 自动聚合 + 报告 JSON、ADR-004、规模冒烟性能门、工具文档防漂移。

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
