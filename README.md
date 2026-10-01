# DSH GUNGNIR（冈格尼尔）

> 永恒之枪，出手必中——**攻击路径合成**的工程化：把分散、隐蔽、看似无关的弱点，
> 拼成一条到 shell 的完整链路。

DSH 红队战役指挥框架。**规格与架构决策全部在仓库内维护**（多方维护入口）：

- 规格（v1.4）：[docs/WARROOM-FRAMEWORK.md](docs/WARROOM-FRAMEWORK.md)
- ADR-001 权限与执行边界（rev1）：[docs/adr/ADR-001-permission-execution-boundary.md](docs/adr/ADR-001-permission-execution-boundary.md)
- ADR-002 数据与证据契约（rev2）：[docs/adr/ADR-002-data-evidence-contract.md](docs/adr/ADR-002-data-evidence-contract.md)
- ADR-003 Adapter 生命周期（rev2）：[docs/adr/ADR-003-adapter-lifecycle.md](docs/adr/ADR-003-adapter-lifecycle.md)
- 冻结快照：[docs/adr/frozen/](docs/adr/frozen/)

**治理**：ADR 一经 Accepted 即不可变，修正以新 rev 重写并留修订记录；规格/doctrine 改动走 PR + RFC。
本仓库是规格唯一真源；线上提交前跑 `node --test`（验收负样本套件）。

**100% 红队工具：仅限已获授权的攻防演练与渗透测试。仓库只含编排层，不含任何漏洞利用代码。**

## v0.1 冻结闭环

单战役、单 adapter（redteam-mode，接入中）、服务端门闸、可取消任务、证据入库、报告导出。
推进方式见框架 §11（批次 0 = 共享类型 → 四线并行 → 最小真实链路交叉验证）。

## 包结构

| 包 | 平面 | 内容 |
|---|---|---|
| `packages/shared-types` | 共同契约 | 状态机、错误码、四元组/契约/回执校验（批次 0，alpha 冻结） |
| `packages/warroom-core` | host | 事实库（fact.db/global.db）、门闸 broker、跳板池、fake adapter |
| `packages/warroom-tools` | agent | `warroom_*` 工具定义（v0.1 骨架，包 DSH 工具 schema） |

## 测试（验收负样本）

```sh
node --test
```

覆盖框架 §8 验收清单中可离线验证的项：门闸四元组负样本、丢回包恢复、资源残留、
成员级幂等、乱序修订、代际隔离、水位、只读连接、op_log 补偿、TTL 隔离。

## 数据位置

`$DSH_HOME/warroom/engagements/<engagement_id>/fact.db`（战役事实）+
`$DSH_HOME/warroom/global.db`（跳板/租约/op_log/命令队列）。测试使用临时目录，不触碰真实环境。
