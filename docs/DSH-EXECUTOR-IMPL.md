# DSH 侧执行器实装指引（最后一公里）

[DSH-EXECUTOR.md](DSH-EXECUTOR.md) 讲的是**契约**（job 进、回执出）。本文讲**在你的 DSH 环境里怎么接**。

## 一、三个名字先对齐

| 名字 | 谁提供 | 作用 |
|---|---|---|
| `--executor executors/dsh-redteam-executor.mjs` | 本仓（已提供） | 桥的插件：把 job 交给一条**命令** |
| `GUNGNIR_EXECUTOR_CMD` | 你（环境变量） | 那条命令（本文的落点） |
| `GUNGNIR_DSH_TOOL_CMD` | 你（若用示例脚本） | 你环境里的**真实派单命令** |

## 二、最小接法

```sh
# 你的派单命令：读参数 → 调红队模式插件服务 → stdout 输出 {members, resources}
export GUNGNIR_DSH_TOOL_CMD="dsh tool redteam_dispatch --role {role} --targets {targets} --intent {intent}"
export GUNGNIR_EXECUTOR_CMD="node executors/dsh-plugin-cmd.example.mjs"
node scripts/dsh-bridge-responder.mjs --root "$WARROOM_HOME/dsh-bridge" \
  --executor executors/dsh-redteam-executor.mjs
```

先跑演练确认链路：

```sh
node scripts/executor-drill.mjs --mode bridge    # 用内置示例执行器，验证桥本身
```

## 三、角色映射（指挥层意图 → 你的角色）

| contract.intent | 建议落到 | 说明 |
|---|---|---|
| `recon` | 侦察角色 | 只读信息收集 |
| `assess` | 评估角色 | 弱点确认（默认兜底） |
| `vuln` | 漏洞验证角色 | 单点利用验证 |
| `exploit` | 利用角色 | 拿到控制面（本框架只关心**路径与证据**） |
| `internal` | 内网角色 | 横向与提权 |

映射写在适配器构造参数里（`new RedteamModeAdapter({ driver, roleByIntent })`），协议本身不认识业务角色。

## 四、回执的硬要求（不合规会被主控拒收或停在未决）

1. `members[]` 必带 `entity_type / source_id / revision_no / content_hash / payload`；
   `source_id` 在同一实体上必须稳定（成员级幂等的关键）。
2. `resources[]` 必带 `id / kind / stopped`；**停止证明要靠实测**（主控会用真实探针复核 pid/端口/容器）。
3. 执行器**只上报事件，不改状态**：账本状态机由主控独占推进。
4. 失败就失败：命令非零退出/输出非法 → 主控记 `unknown`，**绝不自动重试**。
   长任务请调 `warroom heartbeat --task <id>` 上报进度（否则会被超时巡检转 unknown）。

## 五、边界（与本框架的分工）

- **会话记录（pentest-sessions.db）只做聚合**：本框架**只读**它（`warroom aggregate --sessions-db <path>`），
  永不写入；你的执行层照旧写你自己的库。
- **情报不落跳板**：桶 C 执行发生在跳板侧时，只回传事实回执，产物与凭据留控制台。
- **出口仍受门闸约束**：执行器不得自行绕开出口控制（围栏/跳板由指挥层下发）。

## 六、验收口径

```sh
node scripts/conformance.mjs --module <your-adapter.mjs>   # SPI 契约自检（含停止逐项证实）
node scripts/ci.mjs --quiet                                # 六道闸
node bin/warroom.mjs preflight --engagement <id>           # 开工前预检
node bin/warroom.mjs watch --engagement <id> --text        # 值班一屏（告警 + 油表）
```
