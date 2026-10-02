# DSH 侧执行器接入指南

GUNGNIR（指挥层）不直接碰目标：**一切动手的活交给执行层**。执行层与指挥层之间是
[桥协议](DSH-BRIDGE-PROTOCOL.md)（spool 文件），执行器通过 `--executor` 插件挂载。

## 拓扑

```
GUNGNIR（本仓，指挥层） ──spool──► 应答器（DSH 侧）──executor──► 执行器命令 ──► 红队模式/工具
   ↑ 门闸/授权/事实库                                   ↑ 你只需实现这一个"命令"
```

## 最小接法（三步）

```sh
# 1) 写一个执行器命令：读 stdin 的 job JSON，向 stdout 写回执 JSON
#    （参考实现：executors/example-role-cmd.mjs）
# 2) 用 dsh-redteam-executor 把它接进应答器
export GUNGNIR_EXECUTOR_CMD="node /path/to/your-executor.mjs"
node scripts/dsh-bridge-responder.mjs --root "$WARROOM_HOME/dsh-bridge" \
  --executor executors/dsh-redteam-executor.mjs
# 3) 指挥层侧正常开工/派单；事实经桥入库
node bin/warroom.mjs wave --engagement "$ENG" --meeting wave.json
```

## 你的执行器要做什么

1. 解析 stdin 的 `job`（`external_id` / `role` / `contract`：targets、action_class、generation、task_id）。
2. 按 `role` 派单到你自己的执行层（红队模式五角色、脚本、人工队列皆可）——**注意**：
   一切出网流量仍受 GUNGNIR 门闸与跳板池约束，执行器不得绕开出口控制。
3. 回收结果并输出 `{ members, resources }`：
   - `members[]`：事实成员，必须带 `entity_type / source_id / revision_no / content_hash / payload`；
     `source_id` 在同一实体上保持稳定（成员级幂等的关键，见 ADR-002 D5）。
   - `resources[]`：任务持有的资源（`session|container|process|port`）+ `stopped` 状态；
     **停止证明要靠实测**（主控会用真实探针复核 pid/端口/容器）。

## 语义约束（与 ADR-003 对齐）

| 约束 | 说明 |
|---|---|
| 只上报事件，不改状态 | 状态机由主控独占推进 |
| 失败即失败 | 执行器崩溃/输出非法 → 主控记 `unknown`，**绝不自动重试**（防重复告警/锁号） |
| 超时要如实 | 不要用轮询空转伪装进度；主控有 `sweep` 把超时任务转 `unknown` |
| 停止要证实 | `stopped:true` 需与实际一致；残留会让任务停在 `unresolved`（人工队列） |

## 接入检查单

```sh
node scripts/doctor.mjs --home "$WARROOM_HOME"        # 环境/数据体检
node scripts/fence-verify.mjs --engagement <id>       # 围栏真实验收（需要 docker daemon）
node bin/warroom.mjs wave --dry-run --engagement <id> --meeting wave.json   # 先演练
node bin/warroom.mjs audit --engagement <id>          # 事后核对门闸判定
```
