# 验收对照表（v0.1 · 2026-10-02）

规格：[WARROOM-FRAMEWORK.md](WARROOM-FRAMEWORK.md) §8 + 三份 ADR 的验收节。
所有条目均可用仓库内命令复跑；**缺口如实标注，不假装通过**。

复跑全部：**`node scripts/ci.mjs --quiet`**（六闸一次跑完，判定在脚本里）。
逐闸等价命令：`node --test`（**469 例**）→ `node scripts/validate-tool-schemas.mjs` →
`node scripts/check-preset.mjs` → `node scripts/fault-matrix.mjs`（**21 场景**）→
`node scripts/gen-docs.mjs --check`（工具/看板/矩阵文档同步）→ `node scripts/self-review.mjs`。
CI 另有**三个真跑 job**：`fence`（真实容器围栏）、`drill`（跨进程执行层演练）与 `native-host`（真实 DSH 挂载验收 → HOST_VERIFIED）。
端到端演练：`node scripts/executor-drill.mjs [--mode bridge]`；契约自检：`node scripts/conformance.mjs`。

## 框架 §8 验收清单（12 项）

| # | 验收项 | 证据 | 状态 |
|---|---|---|---|
| 1 | 允许清单负样本：bash/文件写/进程工具不在战役会话工具目录 | `presets/warroom.preset.json` + `test/preset.test.js` + `scripts/check-preset.mjs` + **`test/dsh-mount.test.js`** + **`scripts/verify-host.mjs`** + **`test/dsh-host-verified.test.js`**（宿主校验器 + 官方 boot API 真实进程挂载验收） | ✅ **真实挂载已闭环**（dsh 0.2.0-rc.2）：`scripts/verify-host.mjs` 用官方 boot API 真起 web profile，断言 ①注册表无 broken + 预设在册 ②`retain` 成功 ③主控会话工具目录 = 允许集（`warroom_*` 全数，0 内核工具；数量与允许清单同源，当前 37），过了才打 **HOST_VERIFIED**。CI `native-host` job 每次推送真装官方 DSH 复跑（`--require-host` 防静默通过）；缺宝时如实 SKIP |
| 2 | broker 负样本：缺四元组 / 请求 ⊄ 授权对象 / auth_version 过期 | `test/gates.test.js`（三负样本 + 类档 + 窗口） | ✅ |
| 3 | 授权撤销 + 时间窗：级联取消 + 探针证实停止 | `test/gates.test.js`、`test/gate-controls.test.js`、故障矩阵⑥ | ✅ |
| 4 | 丢回包恢复：接收成功→断回包→重启→lookup 找回，无重复任务 | `test/dispatch.test.js`、故障矩阵① | ✅ |
| 5 | 资源残留负样本：主会话停、容器在 → unresolved | `test/dispatch.test.js`、故障矩阵④ | ✅ |
| 6 | 成员幂等：{A}→{A,B} 不重复记账；乱序修订不覆盖；重复回执无效 | `test/store.test.js`、故障矩阵② | ✅ |
| 7 | 旧代结果不覆盖新版本（代际隔离） | `test/store.test.js`、`test/reconcile.test.js` | ✅ |
| 8 | 日志 / 报告 / 错误输出无秘密明文 | `test/secrets.test.js`、`test/report.test.js`、CLI 冒烟 | ✅ |
| 9 | 桶 A 隔离实测：无 sidecar 出网失败；DNS 不落宿主 | CI `fence` job（run [36944503518](https://github.com/86cloudyun-afk/dsh-gungnir/actions/runs/36944503518)） | ✅ **真实验收已通过**：runner 上创建 `--internal` 网络 + sidecar 双挂 + 任务容器，`wget` 直连**被阻断**（日志逐步可查）；本地无 daemon 时如实 SKIP |
| 10 | 报告水位双校验（seq + snapshot + 证据摘要） | `test/report.test.js` | ✅ |
| 11 | 非所有者写连接被只读模式拒绝 | `test/store.test.js` | ✅ |
| 12 | fact.db 停写注入：op_log 补偿 + 恢复补审计 + TTL 隔离 | `test/compensation.test.js`、故障矩阵③ | ✅ |

## ADR-001（权限与执行边界 rev1）

| 验收项 | 证据 | 状态 |
|---|---|---|
| 允许清单负样本（挂载层缺失，非提示词拒绝） | preset + checker + **`scripts/verify-host.mjs`**（官方 boot API 实挂验收 → HOST_VERIFIED）+ CI `native-host` job | ✅ **真实挂载已闭环**：主控会话工具目录由挂载构成在真实 DSH 进程里实测 = 允许集（37 `warroom_*`，0 内核工具），非提示词拒绝 |
| broker 负样本三类 | `test/gates.test.js` | ✅ |
| 授权对象冻结性：重启后恢复且哈希一致；agent 无写路径 | `test/migrate-backup.test.js`、`test/fault-matrix.test.js` | ✅（哈希一致性由 engagements.auth_hash 保留；agent 侧无写工具由 preset deny 表达） |
| 撤销级联 + 秘密抽测 | `test/gates.test.js`、`test/secrets.test.js` | ✅ |
| 桶 A 隔离实测 | CI `fence` job（runner 真跑：`--internal` 网络 + sidecar + 任务容器，直连被阻断）；本地无 daemon 时如实 SKIP | ✅ |

## ADR-002（数据与证据契约 rev2）

| 验收项 | 证据 | 状态 |
|---|---|---|
| 成员幂等三例（集合扩张 / 修订 / 重复回执） | `test/store.test.js`、故障矩阵② | ✅ |
| 并发逆序：两任务逆序 collect 均有效 | `test/store.test.js` | ✅ |
| 水位双校验 | `test/report.test.js` | ✅ |
| 非所有者写被拒 | `test/store.test.js` | ✅ |
| fact 停写注入 + 补偿 + TTL 隔离 | `test/compensation.test.js`、故障矩阵③④ | ✅ |
| auth_version 递增不影响 engagement_id / 库路径 / 租约 | `test/gates.test.js`、`test/migrate-backup.test.js` | ✅ |

## ADR-003（Adapter 生命周期 rev2）

| 验收项 | 证据 | 状态 |
|---|---|---|
| 丢回包 + lookup 找回 + 唯一任务 | `test/dispatch.test.js`、故障矩阵① | ✅ |
| 资源残留负样本 | `test/dispatch.test.js`、故障矩阵④ | ✅ |
| 撤销级联 + unresolved 入人工队列 | `test/gates.test.js`、`test/reconcile.test.js` | ✅ |
| 时间窗到期同路径 | `test/gates.test.js` | ✅ |
| 执行器断联 → unknown；reconcile 定论；不自动重做 | `test/reconcile.test.js`、`test/dsh-bridge.test.js` | ✅ |
| cancel 幂等 | `test/dispatch.test.js` | ✅ |
| 超时 → unknown（绝不自动重试）| `test/timeout.test.js`（清扫不产生新命令、reconcile 才定论）| ✅ |
| 旧代回执隔离 | `test/store.test.js`、`test/reconcile.test.js` | ✅ |
| SPI 契约（跨 adapter 一致） | `test/adapter-conformance.test.js`、`test/dsh-bridge.test.js` | ✅ |

## 缺口与计划（如实记录）

| 缺口 | 影响 | 计划 |
|---|---|---|
| 桶 A 容器隔离的运行验收（§8-9 / ADR-001-5） | 已由 CI `fence` job 承担（daemon 可用即真测；`--require-daemon` 防静默通过）；本机 docker daemon 未运行时本地表现为 SKIP | 观察 CI `fence` job 结果；如需本地复跑，启动 Docker Desktop 后执行脚本 |
| ~~允许清单在真实 DSH 挂载层生效~~ **（已闭环 2026-10-02）** | **已闭环**：`scripts/verify-host.mjs` 用官方 boot API 真起 web profile 并断言预设无 broken + `retain` 成功 + 主控会话工具目录 = 允许集（37 `warroom_*`，0 内核工具），过了才 **HOST_VERIFIED**；CI `native-host` job 真装官方 DSH 每推送复跑（`--require-host` 防静默） | ✅ 已闭环（本机实跑 HOST_VERIFIED；`test/dsh-host-verified.test.js` 缺宝 SKIP、有宝实跑） |
| 进程级取消证实 | **已落地**：真实探针（PID `process.kill(pid,0)` / 端口 TCP 连接 / 容器 `docker inspect`，未知一律 fail-closed）；"主会话已停、子进程仍在"必须 unresolved（真实子进程回归） | ✅ 完成（test/process-probes.test.js） |
| 真实执行层应答器 | **已提供**：应答器（`scripts/dsh-bridge-responder.mjs`，含 `--executor` 插件与 fail-closed）、
可跑 stub（`executors/dsh-plugin-cmd.example.mjs`）、实装指引（`docs/DSH-EXECUTOR-IMPL.md`）；
CI `drill` job 每次推送都跑跨进程链路 | 剩余：把 `GUNGNIR_EXECUTOR_CMD` 指向你环境里的真实派单命令（需 DSH 环境） |

## 批次 4–6 新增能力的验收映射

| 能力 | 判据 | 证据 | 状态 |
|---|---|---|---|
| 知识库（跨战役复用） | 两战役共用同一 POC 且留痕；未脱敏被拒 | `test/knowledge.test.js` | ✅ |
| 回填强制脱敏 | 内网 IP / 环回 / 内部域名 / 未替换占位一律 `E_KB_UNSANITIZED` | `test/knowledge.test.js` | ✅ |
| 进程级停止证实 | 真实子进程在 → unresolved；杀掉后 → confirmed_stopped | `test/process-probes.test.js` | ✅ |
| 围栏真实容器验收 | CI `fence` job：任务容器直连被阻断 | run [36944503518](https://github.com/86cloudyun-afk/dsh-gungnir/actions/runs/36944503518) | ✅ |
| 波次编排（会不开波不发） | 纪要落库 + 依赖立即交接 + 结项 | `test/wave.test.js` | ✅ |
| 波次演练（零副作用） | dry-run 前后命令/纪要/事实计数不变 | `test/wave.test.js` | ✅ |
| 超时治理 | 超时转 unknown、清扫不新增命令 | `test/timeout.test.js` | ✅ |
| 证据落盘（三段式索引） | md/json/水位/索引齐全且无明文 | `test/evidence.test.js` | ✅ |
| 审计（含拒绝路径） | decision 过滤 + JSONL 导出 + deny 留痕 | `test/audit.test.js` | ✅ |
| 跳板台账与收口 | status 计数正确；release 幂等 | `test/jumps-tool.test.js` | ✅ |
| 喷洒矩阵（断点/扩散防护） | 已试过/已锁定不进 ready；锁定跨服务拦截 | `test/spray-matrix.test.js` | ✅ |
| 效率视图（档位 + 返工率） | by_tier 派生指标；重派计入返工率 | `test/efficiency.test.js` | ✅ |
| 执行器插件（fail-closed） | 未配置不写假回执；三方端到端 | `test/executor-plugin.test.js`、`test/executor-guide.test.js` | ✅ |
| 性能门（扩展） | 审计/JSON 报告/矩阵在大 N 下过阈值 | `test/bench.test.js` | ✅ |
| stealth 抖动与漂移 | 区间内随机；同小时稳定、跨小时变化；门闸按本次要求间隔拒绝（带 retry_after_ms） | `test/stealth-jitter.test.js` | ✅ |
| 体检（doctor） | 空 home 不报错、有数据全绿 | `test/doctor.test.js` | ✅ |
| 影响面摘要 | 等级/范围去重/控制面口径；未评估不猜 | `test/impact.test.js` | ✅ |
| 看板 JSON 契约 | 七视图字段由真实样本推导；漂移即 CI 失败 | `test/gen-docs.test.js` | ✅ |
| CLI 知识库 | poc 子命令与工具同源；未脱敏拒收 | `test/cli-poc.test.js` | ✅ |
| 外部门禁 | 退出码 0/1/2；与 checklist 同源 | `test/gate-check.test.js` | ✅ |
| 性能门（交付面） | HTML 报告与看板视图在 N=3000 下过闸 | `test/bench.test.js` | ✅ |
| 报告时序与分段 | 逐任务耗时 + ASCII 条；缺时间戳为 — | `test/gantt.test.js` | ✅ |
| 周报归档 | ISO 周落盘、同周覆盖、历史倒序 | `test/weekly.test.js` | ✅ |
| 执行层实装指引 | 指引 + 可跑 stub（未配置 fail-closed） | `test/executor-impl-doc.test.js` | ✅ |
| 蓝队视图 IOC 前置 | 整段搬迁且段集合不变 | `test/ioc-report.test.js` | ✅ |
| HTML 窄屏适配 | 表格滚动容器 + 媒体查询；零外部资源 | `test/report-html.test.js` | ✅ |
| 角色动线落地 | 值班/交付/路径口径写进三角色提示词 | `presets/roles/*.md`、`scripts/check-preset.mjs` | ✅ |
| HTML 目录与锚点 | 中文标题可锚、同名加序号、短报告不出目录 | `test/report-html.test.js` | ✅ |
| 多战役周报 | 只算窗口内有活动的战役；含交付门禁列 | `test/weekly.test.js` | ✅ |
| 执行层演练 | fake 与 bridge 两模式全链路；CI job 常跑 | `test/executor-drill.test.js`、CI `drill` job | ✅ |
| 舰队视图 | 有事在前；单战役失败不影响整屏 | `test/watch.test.js` | ✅ |
| 人工确认留痕 | 署名/时间/结论入审计；不刷绿门禁；自动项拒绝 | `test/checklist.test.js`、`test/fault-matrix.test.js` | ✅ |
| 值班一屏 | watch 内置油表摘要 + 用尽/锁定告警 | `test/watch.test.js` | ✅ |
| HTML 打印友好 | @media print 规则 + 封面块；零外部资源 | `test/report-html.test.js` | ✅ |
| 交付清单 | 自动项只依据账本与文件；人工项不打勾；可落盘 | `test/checklist.test.js` | ✅ |
| 交付包标准化 | 证据目录含清单，索引有「交付自检」段 | `test/evidence.test.js` | ✅ |
| 交付门禁 | delivery/progress 两口径；--strict 非零退出 | `test/checklist.test.js`、`test/fault-matrix.test.js` | ✅ |
| 一键交付 | 报告 all + 证据包 + 备份 + 门禁结论；不达标非零退出 | `test/deliver.test.js` | ✅ |
| 巡检统一视图 | 一屏汇聚路由/任务/出口/壳 + 告警；严格只读 | `test/watch.test.js` | ✅ |
| 速率与预算视图 | wire 用量/剩余/间隔（含抖动）/锁定；只读 | `test/rate-view.test.js` | ✅ |
| 效率 CSV 导出 | 六节行结构 + RFC4180 转义 + CLI 双路 | `test/metrics-csv.test.js` | ✅ |
| 报告 HTML | 自包含、无外部资源、mermaid 双份 | `test/report-html.test.js` | ✅ |
| 交付前一体化 | `report --verify` 导出即校验；漂移非零退出 | `test/report-selfcheck.test.js` | ✅ |
| 战役时序视图 | 事件按真实时间排序；缺失阶段为 null；账本态单列 | `test/timeline.test.js` | ✅ |
| 报告受众差异化 | 客户版剔除审计/知识库/台账；三受众均保留水位与自校验 | `test/ioc-report.test.js` | ✅ |
| 证据交付视图 | 客户版/蓝队版分目录归档；索引注明内部全量 | `test/evidence.test.js` | ✅ |
| 预检留痕 | `--record` 写入审计，默认不留痕 | `test/preflight.test.js` | ✅ |
| 波次桶/出口标注 | 每任务 bucket/egress；缺出口拒绝开工且留痕 | `test/wave.test.js` | ✅ |
| 体检报告复现性 | 漂移即 warn 并提示重出（复用同一判定） | `test/doctor.test.js` | ✅ |
| 效率四段观测 | 排队/交接/执行/返工分段正确；无数据为 null | `test/efficiency-segments.test.js` | ✅ |
| 跨会话聚合（只读边界） | 聚合库写入必须失败；聚合不改本框架水位 | `test/aggregate.test.js` | ✅ |
| 知识库检索加权 | 命中率优先、新鲜度衰减、sort 可切 | `test/knowledge.test.js` | ✅ |
| 拓扑分组视图 | 子图 + 图例 + 通往控制面的边加粗 | `test/topology.test.js` | ✅ |
| 执行三桶 | 桶 A 必须有出口；桶 B 禁 socks；桶 C 需跳板且情报不落跳板；预检分层告警 | `test/buckets.test.js` | ✅ |
| 开工前预检 | 三态结论 + 波次目标逐个核授权范围 + 成环拦截 | `test/preflight.test.js` | ✅ |
| 活跃 route 生命周期 | 心跳续期；租约释放/长时无心跳 → stale；围栏不再取该出口 | `test/route-liveness.test.js` | ✅ |
| 长时任务心跳 | 持续心跳不被清扫；心跳失效转 unknown 且基准标为 heartbeat | `test/heartbeat.test.js` | ✅ |
| 报告攻击路径拓扑 | 显式引用优先、隐式标「推断」、无引用不画边 | `test/topology.test.js` | ✅ |
| 知识库复用入报告 | md 段 + json `kb_usage`；未使用不出现 | `test/ioc-report.test.js` | ✅ |
| 单命令门禁 | 六闸逐条跑、汇总判定、失败非零退出 | `test/ci-runner.test.js` | ✅ |
| 桥接 adapter 过一致性套件 | 跨进程 + 停止逐项证实 | `test/conformance-bridge.test.js` | ✅ |
| 备份保留与恢复演练 | `--keep` 只轮转自动备份；restore 默认 dry-run，apply 前先做恢复前快照 | `test/restore.test.js` | ✅ |
| 波次与节奏档联动 | 同时在飞 ≤ 档位上限；波末未结项如实报错 | `test/wave.test.js` | ✅ |
| 报告自校验 | 导出即复核；漂移如实标记 | `test/report-selfcheck.test.js` | ✅ |
| 事实查询（工具+CLI） | 过滤/历史修订/统计一致 | `test/fact-query.test.js` | ✅ |
| 出口验证门闸 | 记录/状态；开启后无有效 pass 即拒绝出网；wire_cost=0 不受影响 | `test/egress-gate.test.js` | ✅ |
| 出口验证实跑 | route/self 两模式；代理变量拒绝；退出码 0/1/2/3 语义化 | `test/egress-script.test.js` | ✅ |
| 一致性套件独立入口 | 坏 adapter 被逐条指出并非零退出 | `test/conformance-cli.test.js` | ✅ |
| 密钥轮换 | 旧秘密仍可解；归档 600；缺密钥明确报错 | `test/secrets.test.js` | ✅ |
| 报告体量控制 | md 截断给计数；JSON 全量 | `test/ioc-report.test.js` | ✅ |
| 备份/维护 | 可重复备份 + 完整性；CLI backup/maintain | `test/maintenance.test.js` | ✅ |
| 故障矩阵扩展 | 21 场景（含备份恢复往返） | `test/fault-matrix.test.js` | ✅ |

## 数字快照

- 测试：469 例（`node --test`）
- CI 闸：6 + 故障矩阵 21 场景 + 三个真跑 job（`fence` / `drill` / `native-host`）
- 工具：37 个（schema 严格校验，DSH 挂载要求）
- schema 版本：fact=6 / global=8（**按 label 计算目标版本**；高版本库拒绝打开）
- 标签：`v0.1.0-alpha.17`（批次 1–16 已合并）
