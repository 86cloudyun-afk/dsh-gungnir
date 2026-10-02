# v0.1 最终验收审计

> 历史审计记录（真实宿主/容器结论不作为本次修复新树的验收）：
> 生成时间：2026-10-02 · 审计范围：WARROOM-FRAMEWORK v1.4 §8 十二项 + ADR-001/002/003 验收节
> 汇总口径：**只认可复跑的仓库内命令**；推不出来的一律写"未闭环"。

## 一、一次性结论

| 项 | 结果 |
|---|---|
| 框架 §8 十二项 | **12/12 已闭环**（§8-1 真实 DSH 挂载层已由官方 boot API 实挂验收闭环 → HOST_VERIFIED，CI `native-host` job 每推送复跑；详见 [ACCEPTANCE](ACCEPTANCE.md) §8-1 与 `scripts/verify-host.mjs`） |
| ADR-001（权限与执行边界） | 5/5 闭环（含桶 A 真实容器验收，由 CI `fence` job 真跑） |
| ADR-002（数据与证据契约） | 6/6 闭环 |
| ADR-003（Adapter 生命周期） | 9/9 闭环 |
| 本次授权边界修复 | 离线定向与安全回归、schema、preset、故障矩阵、生成文档、自审；真实执行器、网络探针及原生宿主验收未运行（见 [ACCEPTANCE](ACCEPTANCE.md)） |
| CI 真跑 job | `fence`（真实容器围栏）、`drill`（跨进程执行层演练）、`native-host`（真实 DSH 挂载验收 → HOST_VERIFIED）、`test` → 皆绿 |
| 端到端演练 | `node scripts/executor-drill.mjs` → 全链路通过（11 步）；`--mode bridge` 亦通过 |
| 契约自检 | `node scripts/conformance.mjs` → 8/8（且对真实桥接 adapter 亦通过） |
| 性能 | N=5000：md 报告 73ms / json 167ms / html 73ms / 看板视图×5 35ms / 证据落盘 545ms / RSS 234MB |

## 二、§8 十二项逐条证据

| # | 验收项 | 复跑命令 | 状态 |
|---|---|---|---|
| 1 | 允许清单负样本（bash/写文件/进程工具不可见） | `node scripts/check-preset.mjs`；`node --test test/preset.test.js`；`node scripts/verify-host.mjs`（官方 boot API 实挂）；`node --test test/dsh-host-verified.test.js` | ✅ 文件与校验器闭环；**真实挂载已闭环**（dsh 0.2.0-rc.2，实挂主控会话工具目录 = 允许集、0 内核工具 → HOST_VERIFIED；CI `native-host` 复跑） |
| 2 | broker 负样本（缺四元组 / 请求 ⊄ 授权 / 版本过期） | `node --test test/gates.test.js` | ✅ |
| 3 | 撤销 + 时间窗：级联取消 + 探针证实停止 | `node --test test/gates.test.js test/gate-controls.test.js` | ✅ |
| 4 | 丢回包恢复：接收成功→断回包→重启→lookup 找回 | `node --test test/dispatch.test.js`；`node scripts/fault-matrix.mjs`（①） | ✅ |
| 5 | 资源残留：主会话停、容器在 → unresolved | `node --test test/dispatch.test.js test/process-probes.test.js` | ✅ |
| 6 | 成员幂等（集合扩张/乱序修订/重复回执） | `node --test test/store.test.js`；矩阵② | ✅ |
| 7 | 旧代结果不覆盖新版本 | `node --test test/store.test.js test/reconcile.test.js` | ✅ |
| 8 | 日志/报告/错误输出无秘密明文 | `node --test test/secrets.test.js test/ioc-report.test.js` | ✅ |
| 9 | 桶 A 隔离实测（无 sidecar 出网失败、DNS 不落宿主） | CI `fence` job；本地 `node scripts/fence-verify.mjs --engagement <id>` | ✅（CI 真跑；本地无 daemon 时如实 SKIP） |
| 10 | 报告水位双校验（seq + snapshot + 证据摘要） | `node --test test/ioc-report.test.js test/report-selfcheck.test.js` | ✅ |
| 11 | 非所有者写连接被只读模式拒绝 | `node --test test/store.test.js test/aggregate.test.js` | ✅ |
| 12 | fact.db 停写注入：op_log 补偿 + 恢复补审计 + TTL 隔离 | `node --test test/compensation.test.js`；矩阵③④ | ✅ |

## 三、未闭环项（如实，且都因环境依赖）

> §8-1（允许清单在真实 DSH 挂载层生效）原列此处，已于 2026-10-02 闭环：`scripts/verify-host.mjs` 用官方 boot API 真起 web profile，实测主控会话工具目录 = 允许集（`warroom_*` 全数、0 内核工具）→ **HOST_VERIFIED**，CI `native-host` job 每推送复跑。详见 [ACCEPTANCE](ACCEPTANCE.md) §8-1。

| 项 | 现状 | 闭环条件 |
|---|---|---|
| 真实派单命令对接 | 桥、应答器、执行器插件、示例 stub、实装指引全部就绪；CI 每推一次都跑跨进程演练 | 把 `GUNGNIR_EXECUTOR_CMD` 指向你环境里的派单命令（见 [DSH-EXECUTOR-IMPL.md](DSH-EXECUTOR-IMPL.md)） |

> 这一项需要**操作员的 DSH 环境**，不是本仓可以自行完成的代码工作；
> 仓库侧的准备（契约、fail-closed 行为、演练、CI 常跑）已全部做完。

## 四、交付物清单（本仓）

- **编排层代码**：`packages/*`（shared-types / warroom-core / warroom-tools / warroom-plugin）
- **CLI**：`bin/warroom.mjs`（30+ 子命令，见 [QUICKSTART.md](QUICKSTART.md) 一图流）
- **工具**：36 个 `warroom_*`（[TOOLS.md](TOOLS.md) 与 [tools.schema.json](tools.schema.json) 自动生成）
- **预设与角色**：`presets/warroom.preset.json` + `presets/roles/{commander,recon,chain}.md`
- **契约**：`docs/adr/*`（四份 ADR）、`docs/dashboards.schema.json`（看板字段）、`docs/tools.schema.json`
- **可读文档**：QUICKSTART / ACCEPTANCE / FAULT-MATRIX / DSH-EXECUTOR(-IMPL) / CI-INTEGRATION / BACKUP / MERGE-REVIEW-1..16
- **可复跑验证**：六闸（`npm run ci`）、故障矩阵 21 场景、契约自检、端到端演练、性能冒烟

## 五、开发过程纪律（自证）

- **PR 制**：132 条 PR 分 16 个批次合并（每批满 8 条做一次合并审查，记录在 `docs/MERGE-REVIEW-*.md`）
- **门禁**：每批合并前后均跑 `node scripts/ci.mjs --quiet`；CI 另跑围栏真容器、跨进程演练与真实 DSH 挂载验收（`native-host`）
- **如实记录**：每批自查节记录真实缺陷与装置问题（含两次"管道吞退出码"的纪律违规及其机制化修复）
- **不确定性处理**：未知探针 fail-closed；缺数据为 `null` 而非 0；未脱敏内容拒收；门禁不通过不交付
