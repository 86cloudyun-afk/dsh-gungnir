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
# 路径含空格：JSON 数组或引号，见 executors/parse-cmdline.mjs
node scripts/dsh-bridge-responder.mjs --root "$WARROOM_HOME/dsh-bridge" \
  --executor executors/dsh-redteam-executor.mjs
```

先跑演练确认链路：

```sh
node scripts/executor-drill.mjs --mode bridge    # 用内置示例执行器，验证桥本身
```

## 二·补｜真执行器：`executors/tool-runner.mjs`（已在仓库里）

不想自己写执行器时，用这个：它把桥的 job 变成**真工具调用**（走操作员既有工具链）。

```sh
# 1) 起应答器（把 job 交给执行器；执行器由 GUNGNIR_EXECUTOR_CMD 指定）
cd /Users/appleshu/dsh/warroom
GUNGNIR_EXECUTOR_CMD="node executors/tool-runner.mjs" \
GUNGNIR_TOOLS_ENV=/Users/appleshu/dsh/tools/env.sh \
GUNGNIR_EXIT_SOCKS=socks5h://127.0.0.1:21084 \
node scripts/dsh-bridge-responder.mjs --root <WARROOM_HOME>/dsh-bridge \
  --executor executors/dsh-redteam-executor.mjs

# 2) 让预设用桥（写家目录配置，**下次宿主启动生效**）
echo '{"adapterKind":"bridge"}' > <WARROOM_HOME>/config.json
```

角色 → 工具（可在 `tools/TOOLBOX.md` 查到同款模板）。**执行器按 `contract.action` 办事，不按角色猜**；
下表是「没有 action 时按 role 兜底」的映射，八项能力全部实装：

| 角色 / action | 命令 | 产出事实 |
|---|---|---|
| `recon` | `subfinder -d <域名> -silent` → `httpx -silent -td -title -sc -rl 20` | `domain` / `asset` |
| `assess` / `nuclei_scan` | `nuclei -silent -jsonl -severity critical,high,medium -rl 5 -retry 1` | `vuln` |
| `vuln` | 给了 `template`/`tags`/`severity` 走定点 nuclei；给了 `command` 就按命令跑 | `vuln` / `artifact` |
| `http_get` | `curl -sS -i -m 20 -x <socks> …`（显式 `-x`，只发 1 个请求） | `asset` |
| `exec` | `contract.command`（或 `argv` 数组）经非登录 `bash -c` 执行 | `artifact` |
| `exploit` | 同上（命令由操作员给出；destructive 由 broker 门闸要**绑定动作 + 靶标**的人工批准令牌） | `session` / `credential` / `artifact` |
| `internal` | 同上（横向/提权用 netexec、impacket、msf 任选） | `session` / `credential` / `asset` / `artifact` |
| `chain` | `contract.steps` 顺序执行（≤12 步），任一步失败即停 | `chain` / `artifact` |

现查能力面（机器可读）：

```sh
node executors/tool-runner.mjs --capabilities
```

**契约字段**：`action`、`url`、`method`、`command`（字符串）、`argv`（数组，按参数边界拼壳，空格路径不会被拆开）、
`steps`（chain 用）、`template`/`tags`/`severity`（vuln 用）、`parse`（`nuclei|httpx|curl|evidence`）、
`timeout_ms`（操作员命令超时，默认 300s，上限 `GUNGNIR_MAX_TIMEOUT_MS`＝1h）。

**回执形状**（与 `executors/dsh-redteam-executor.mjs` 对齐）：`{ generation, external_id, members, resources }`——
`generation` 必须回带 `contract.generation`（插件层按代际校验，缺了整单 `exit=4`、wire=0）；
`_debug` 只在本机 `GUNGNIR_TOOL_RUNNER_VERBOSE=1` 时打到 stderr，不进回执。

**证据回传协议**（显式、不推断、**必须带本单凭据**）：命令 stdout 逐行写

```sh
printf 'GUNGNIR_MEMBER %s: {"entity_type":"session","source_id":"ssh:10.0.0.5:root","payload":{"user":"root"}}\n' \
  "$GUNGNIR_EVIDENCE_NONCE"
```

- **nonce 是每单随机生成的**，只放在操作员命令的环境变量 `GUNGNIR_EVIDENCE_NONCE` 里。
  原因是命令 stdout 会流过**目标可控文本**（`curl` 一个页面、脚本回显响应体）：不带凭据的话，
  目标页面写一行同格式文本就能把自己塞进账本当战果（真机实测：`http_get` 抓一个含该行的页面 → 账本多出 `shell` 事实）。
- **JSON 要用单引号包住**（双引号会被 shell 吃掉，喂给协议的会是一段没引号的伪 JSON）。
- 显式 `contract.trusted_stdout: true` 才接受不带 nonce 的旧写法（`GUNGNIR_MEMBER: {…}`），用于 stdout 不经目标的自有脚本。
- 只有**操作员给的命令**能申报证据；内置抓取模板（`http_get`/`recon`/`nuclei_scan`/`vuln`）的 stdout 是目标返回体，一律不解析。
- 被拒行数记在 `_debug.evidence.rejected`（`GUNGNIR_TOOL_RUNNER_VERBOSE=1` 可见），原始 stdout 照旧落盘可取证。

可用的 `entity_type`：`asset` / `domain` / `vuln` / `credential` / `session` / `shell` / `chain` / `artifact`。
字段不全或类型不在表内的行**直接忽略**（执行器不猜）。`content_hash` 由执行器按**规范化内容重算**，
不采信自报值。操作员命令无论成功与否都会留一条 `artifact` 事实（命令哈希 + 退出码 + 输出哈希 + 落盘路径）——
**非零退出是被派命令的真实结果，不是执行层故障**；**超时与被信号杀（SIGKILL/OOM）才作为错误抛出**
（证据不完整，主控记 `unknown`，同时把该命令的整个进程组清掉）。内置工具模板仍按老规矩：非零退出即失败。

> 输出捕获走**文件**而不是管道：管道会被后台子进程继承，执行器会一直等到管道关闭（实测 `sleep 3 & echo hi`
> 白等 3 秒，等到子进程自己退了还报 `stopped: true` —— 一条假停止证明）。产物文件即 `<step>.stdout.txt` / `.stderr.txt`。

**资源清单（停止证明不许代填）**：每条命令以**独立进程组**运行；命令退出后实测该组——
组空 → 该步骤 `stopped: true`；组内仍有存活成员 → `stopped: false`，且**每个后台子进程逐条列出**
（`<step>-child-<pid>`，带 `pid`/`cmd`）。留了后台进程的步骤会让任务停在该资源的 `unresolved` 上
（要拿 `confirmed_stopped` 就得真的停掉它们），这是有意的语义。

**档位绑定**：契约声明的 `action_class` **不得弱于**动作自身的档位（`http_get`/`recon` = readonly，
`nuclei_scan`/`vuln`/`exec`/`internal`/`chain` = active，`exploit` = destructive）；`exploit` 必须显式声明
`action_class=destructive`，否则执行层直接拒绝（用 `active` 标签套 destructive 动作 = 绕过人工批准的旁路）。

> 秘密别写进 argv：产物目录（stdout/stderr 原文）与执行日志按原样留档，凭据用环境变量引用（`$TOKEN`）。

**出口纪律**：`contract` 里**任何可寻址对象**（`targets`、`url`、`chain` 步内 `targets`/`url`）只要落在外部地址
且没给 `GUNGNIR_EXIT_SOCKS`，就**拒绝执行**——`url` 不是绕过出口的旁路。本地/实验室目标需显式
`GUNGNIR_ALLOW_DIRECT=1`。原始输出落盘到 `GUNGNIR_ARTIFACT_DIR`（默认 `<cwd>/artifacts/<external_id>/`）
供人工复核；工具失败即非零退出 → 主控记 `unknown`。

> 授权范围同理：broker 的 scope 校验（`packages/warroom-core/src/gates.js`）与出口判定都覆盖
> `targets` + `url` + chain 步内目标，`url` 指向范围外资产会在门闸处就被拒绝。

> 性能坑（已修）：执行器用 **非登录** shell（`bash -c`）跑工具。`bash -lc` 会加载交互式 profile，
> 实测一条命令要 ~30 秒（并把执行层耦合到你的 shell 环境）。需要工具链环境就显式给
> `GUNGNIR_TOOLS_ENV=/path/to/tools/env.sh`。

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
