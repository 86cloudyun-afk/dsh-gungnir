# DSH GUNGNIR（冈格尼尔）

> 永恒之枪，出手必中——**攻击路径合成**的工程化：把分散、隐蔽、看似无关的弱点，
> 拼成一条到 shell 的完整链路。

DSH 红队战役指挥框架。**100% 红队工具：仅限已获授权的攻防演练与渗透测试。
仓库只含编排层，不含任何漏洞利用代码。**

## 状态

| 项 | 现状 |
|---|---|
| 版本 | **`v0.1.0`**（v0.1 冻结闭环达成：16 批次 / 134 PR；最终审计见 [FINAL-AUDIT.md](docs/FINAL-AUDIT.md)） |
| 测试 | 863 例登记用例；本次 Mac 安全离线复核计数见 [ACCEPTANCE.md](docs/ACCEPTANCE.md) |
| CI 闸 | 六道本地闸（验收套件 / 工具 schema / 预设允许清单 / 故障矩阵 / 工具文档与看板契约同步 / 自审闸）+ **三个真跑 CI job**：围栏真实容器（`fence`）、执行层跨进程演练（`drill`）、真实 DSH 挂载验收（`native-host` → HOST_VERIFIED） |
| 故障矩阵 | 21 场景（丢回包/乱序/写失败/残留/重启/撤销/备份恢复/密钥/配置/版本/迁移/路由/心跳/知识库/交付边界/门禁/确认边界/归档幂等/门禁同源） |
| 工具 | **36** 个 `warroom_*`（schema 严格校验；以 `presets/warroom.preset.json` 允许清单为准） |
| 验收对照 | [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)（逐条状态 + 证据命令） |
| 最终审计 | [docs/FINAL-AUDIT.md](docs/FINAL-AUDIT.md)（§8 十二项 11/12 闭环；未闭环项均需操作员 DSH 环境） |
| 故障矩阵 | [docs/FAULT-MATRIX.md](docs/FAULT-MATRIX.md)（21 场景：场景/期望/契约归属） |

## 六件套与动线（一屏）

| 阶段 | 命令 | 产出 |
|---|---|---|
| **起好** | `init` → `doctor` → `config init` | 家目录、配置、体检 |
| **开工** | `engage`（授权冻结）→ `jump acquire` → `egress` → `preflight` | 可动手的战役 + 出口 + 预检结论 |
| **干活** | `wave --dry-run`（先演练）→ `wave`（依赖驱动）→ `watch`/`rate`（值班） | 事实入库、任务结项、油表可见 |
| **收口** | `checklist`（缺什么）→ `deliver`（一键交付）→ `evidence`/`report` | 报告（md/json/html，客户版/蓝队版）+ 证据包 + 门禁结论 |
| **留存** | `weekly --archive` → `backup --keep 7` → `aggregate` | 周报、备份、跨会话聚合（只读） |
| **对外** | `gate-check.mjs`（外部门禁）→ [CI-INTEGRATION.md](docs/CI-INTEGRATION.md) | 你的流水线可直接用 |

> 判断顺序：**告警 → 油表 → 漂移**；值班一屏 = `watch`（内置油表），跨战役 = `watch --all`。

## 规格与架构决策（本仓库为唯一真源）

- 规格（v1.4）：[docs/WARROOM-FRAMEWORK.md](docs/WARROOM-FRAMEWORK.md)
- ADR-001 权限与执行边界（rev1）：[docs/adr/ADR-001-permission-execution-boundary.md](docs/adr/ADR-001-permission-execution-boundary.md)
- ADR-002 数据与证据契约（rev2）：[docs/adr/ADR-002-data-evidence-contract.md](docs/adr/ADR-002-data-evidence-contract.md)
- ADR-003 Adapter 生命周期（rev2）：[docs/adr/ADR-003-adapter-lifecycle.md](docs/adr/ADR-003-adapter-lifecycle.md)
- ADR-004 v0.2 边界与验收：[docs/adr/ADR-004-v0.2-scope.md](docs/adr/ADR-004-v0.2-scope.md)
- ADR-006 执行层能力面（八项动作全实装 + 显式证据协议）：[docs/adr/ADR-006-executor-capability-surface.md](docs/adr/ADR-006-executor-capability-surface.md)
- ADR-007 批准与动作绑定（批准指纹 + 原子单次消费 + 授权手段校验）：[docs/adr/ADR-007-approval-action-binding.md](docs/adr/ADR-007-approval-action-binding.md)
- ADR-008 证据来源与资源清单真实性（目标文本不得成为事实 + 后台进程进清单）：[docs/adr/ADR-008-evidence-provenance-and-resource-manifest.md](docs/adr/ADR-008-evidence-provenance-and-resource-manifest.md)
- ADR-009 终态与资源收口（完成不掩盖活资源；终态取消仍必须真的停 + 逐项证实）：[docs/adr/ADR-009-terminal-state-and-resource-settlement.md](docs/adr/ADR-009-terminal-state-and-resource-settlement.md)
- 冻结快照：[docs/adr/frozen/](docs/adr/frozen/)
- 快速开始（真实演练输出）：[docs/QUICKSTART.md](docs/QUICKSTART.md)
- 工具清单（自动生成）：[docs/TOOLS.md](docs/TOOLS.md)
- 桥协议： [docs/DSH-BRIDGE-PROTOCOL.md](docs/DSH-BRIDGE-PROTOCOL.md) ｜ 预设挂载：[docs/PRESET.md](docs/PRESET.md) ｜ 备份恢复：[docs/BACKUP.md](docs/BACKUP.md)
- 合并审查记录：[docs/MERGE-REVIEW-2026-10-02.md](docs/MERGE-REVIEW-2026-10-02.md)

**治理**：ADR 一经 Accepted 即不可变，修正以新 rev 重写并留修订记录；规格/doctrine 改动走 PR + RFC。
贡献流程、六闸门槛、写作用域与外部 PR 审查方式见 [CONTRIBUTING.md](CONTRIBUTING.md)（含 [CODEOWNERS](.github/CODEOWNERS)）。

## 快速开始（CLI，不依赖 DSH）

```sh
node bin/warroom.mjs engage --target 10.0.0.0/24 --rhythm open      # 开工指令即授权，冻结授权对象
node bin/warroom.mjs exec  --engagement eng_... --command-id c1 --target 10.0.0.5 --class active
node bin/warroom.mjs status --engagement eng_... --task wt_...
node bin/warroom.mjs cancel --engagement eng_... --task wt_...
node bin/warroom.mjs report --engagement eng_...
node bin/warroom.mjs secret put --plaintext '...' --label ssh-pw     # 明文只进加密库
node bin/warroom.mjs jump import --id jh-1 --addr-v4 203.0.113.9
```

全部子命令支持 `--json`；默认 home 为 `$WARROOM_HOME` 或 `./.warroom`。

## 包结构

| 包 | 平面 | 内容 |
|---|---|---|
| `packages/shared-types` | 共同契约 | 状态机与迁移表、错误码、四元组/契约/回执校验 |
| `packages/warroom-core` | host | 事实库（fact.db/global.db）、门闸 broker、跳板池、秘密库、报告、adapter（fake / redteam-mode / DSH 桥） |
| `packages/warroom-tools` | agent | 36 个 `warroom_*` 工具定义（允许清单制的唯一副作用入口） |
| `packages/warroom-plugin` | DSH 插件 | host 服务骨架 + `warroom_*` 工具包装（挂载层入口） |
| `presets/` | 预设 | 三角色（commander/recon/chain）+ 允许清单 |

## 测试与四闸

```sh
npm run ci                           # 六道闸一次跑完（推荐；验收套件 863 例）
node scripts/executor-drill.mjs      # 执行层落地演练（fake / --mode bridge）
node scripts/ci.mjs --quiet          # 只看汇总（别用 | tail，管道会吞退出码）
node --test                          # 只跑验收套件
node scripts/validate-tool-schemas.mjs   # 工具 schema（DSH 挂载硬要求）
node scripts/check-preset.mjs            # 预设允许清单闭合
node scripts/fault-matrix.mjs            # 故障矩阵 21 场景（与 docs/FAULT-MATRIX.md / SCENARIOS 同源）
node scripts/self-review.mjs             # 自审：秘密/链接/验收引用/代码卫生
```

## 数据位置

`$WARROOM_HOME/engagements/<engagement_id>/fact.db`（战役事实）+ `$WARROOM_HOME/global.db`
（跳板/租约/op_log/命令队列/秘密）+ `$WARROOM_HOME/secrets/`（密钥，700/600，**不随备份走**）。
