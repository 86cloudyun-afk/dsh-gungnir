# WARROOM

DSH 红队战役指挥框架。规格：[/Users/appleshu/dsh/WARROOM-FRAMEWORK.md](../WARROOM-FRAMEWORK.md)（v1.4）
+ 三份 ADR（[001](../adr/ADR-001-permission-execution-boundary.md) rev1 权限与执行边界 /
[002](../adr/ADR-002-data-evidence-contract.md) rev2 数据与证据契约 /
[003](../adr/ADR-003-adapter-lifecycle.md) rev2 Adapter 生命周期）。

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
node --test test/
```

覆盖框架 §8 验收清单中可离线验证的项：门闸四元组负样本、丢回包恢复、资源残留、
成员级幂等、乱序修订、代际隔离、水位、只读连接、op_log 补偿、TTL 隔离。

## 数据位置

`$DSH_HOME/warroom/engagements/<engagement_id>/fact.db`（战役事实）+
`$DSH_HOME/warroom/global.db`（跳板/租约/op_log/命令队列）。测试使用临时目录，不触碰真实环境。
