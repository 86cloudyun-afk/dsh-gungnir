# 验收对照表（v0.1 · 2026-10-02）

规格：[WARROOM-FRAMEWORK.md](WARROOM-FRAMEWORK.md) §8 + 三份 ADR 的验收节。
所有条目均可用仓库内命令复跑；**缺口如实标注，不假装通过**。

复跑全部：`node --test`（72 例）→ `node scripts/validate-tool-schemas.mjs` →
`node scripts/check-preset.mjs` → `node scripts/fault-matrix.mjs`（四闸，CI 同款）。

## 框架 §8 验收清单（12 项）

| # | 验收项 | 证据 | 状态 |
|---|---|---|---|
| 1 | 允许清单负样本：bash/文件写/进程工具不在战役会话工具目录 | `presets/warroom.preset.json` + `test/preset.test.js` + `scripts/check-preset.mjs` | ✅ 文件与校验器就绪；**真实挂载层生效待 DSH 集成波次**（见「缺口」） |
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
| 允许清单负样本（挂载层缺失，非提示词拒绝） | preset + checker | ⚠️ 校验器就绪，真实挂载待集成 |
| broker 负样本三类 | `test/gates.test.js` | ✅ |
| 授权对象冻结性：重启后恢复且哈希一致；agent 无写路径 | `test/migrate-backup.test.js`、`test/fault-matrix.test.js` | ✅（哈希一致性由 engagements.auth_hash 保留；agent 侧无写工具由 preset deny 表达） |
| 撤销级联 + 秘密抽测 | `test/gates.test.js`、`test/secrets.test.js` | ✅ |
| 桶 A 隔离实测 | fence.js + fence-verify.mjs | ⚠️ 静态就绪；真实验收待 daemon/CI runner |

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
| 允许清单在真实 DSH 挂载层生效 | 预设文件与校验器就绪，未在真实会话验证 | v0.2 集成波次（随 DSH 插件挂载一起验收） |
| 进程级取消证实 | **已落地**：真实探针（PID `process.kill(pid,0)` / 端口 TCP 连接 / 容器 `docker inspect`，未知一律 fail-closed）；"主会话已停、子进程仍在"必须 unresolved（真实子进程回归） | ✅ 完成（test/process-probes.test.js） |
| 真实执行层应答器 | 桥协议与驱动就绪，DSH 侧应答器未实现 | v0.2（`docs/DSH-BRIDGE-PROTOCOL.md` 待办） |

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
| 密钥轮换 | 旧秘密仍可解；归档 600；缺密钥明确报错 | `test/secrets.test.js` | ✅ |
| 报告体量控制 | md 截断给计数；JSON 全量 | `test/ioc-report.test.js` | ✅ |
| 备份/维护 | 可重复备份 + 完整性；CLI backup/maintain | `test/maintenance.test.js` | ✅ |
| 故障矩阵扩展 | 11 场景（含备份恢复往返） | `test/fault-matrix.test.js` | ✅ |

## 数字快照

- 测试：197 例（`node --test`）
- CI 闸：6 + 故障矩阵 11 场景 + 围栏真实容器 job
- 工具：24 个（schema 严格校验，DSH 挂载要求）
- schema 版本：fact=6 / global=5（**按 label 计算目标版本**；高版本库拒绝打开）
- 标签：`v0.1.0-alpha.7`（批次 1–6 已合并；批次 7 合并时升 alpha.8）
