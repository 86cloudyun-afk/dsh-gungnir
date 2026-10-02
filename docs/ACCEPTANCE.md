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

## 数字快照

- 测试：118 例（`node --test`）
- CI 闸：6（测试 / 工具 schema / 预设允许清单 / 故障注入矩阵 / 工具文档同步 / 自审闸）
- 工具：16 个（schema 严格校验，DSH 挂载要求）
- schema 版本：5（迁移按版本号排序、高版本拒绝打开）
- 标签：`v0.1.0-alpha.4`（批次 1/2/3 已合并）
