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

## 二·参数配置与字面替换

`GUNGNIR_EXECUTOR_CMD` 与 `GUNGNIR_DSH_TOOL_CMD` 使用同一 argv 解析器；推荐用 JSON 字符串数组表示复杂路径。数组必须非空，每项为非空字符串；可执行文件不能为空白，所有参数禁止 NUL。非法 JSON 不回退为普通分词。

普通写法在引号外按空白分词；单双引号可出现在词内，相邻片段拼成一个参数，例如 `--label="hello world"` 得到 `--label=hello world`，`'a'"b"c` 得到 `abc`。引号内空白原样保留，空引号可表示空参数。引号内只有反斜杠紧接当前引号会转义该引号；其它反斜杠（包括连续反斜杠、UNC 前缀与 `\n` 文字）全部原样保留。引号外反斜杠不转义空白；`$HOME`、`;`、`|` 等没有 shell 含义。未闭合引号明确报错。

连续反斜杠紧接当前引号时，普通写法明确报歧义错误（避免把路径分隔符与引号转义猜成另一种含义）。需要在关闭引号前保留反斜杠、字面引号或复杂转义时，使用 JSON argv 消除歧义；JSON 的转义规则与普通写法不同。例如以下配置文本的第二项是两个前导反斜杠的 UNC 路径：

```json
["node", "\\\\server\\share\\folder name"]
```

示例派单脚本先解析可信配置，再对每个参数一次性替换 `{role}`、`{intent}`、`{action_class}`、`{targets}`、`{external_id}`。可执行文件禁止占位符，不支持的命名占位符明确报错。job/contract 必须为对象，字段须为字符串，targets 须为字符串列表（按既有规则用逗号连接）。缺省 role/intent 为 `recon`（intent 优先沿用 role），action_class 为 `readonly`，targets/external_id 为空；缺失或 null 沿用这些既有默认值。

任务字段中的空白、引号、反斜杠、Unicode、换行、其它占位符和美元符号只作为字面数据，替换后不再分词、解析 JSON 或重复替换，空值保留原参数位置。示例与桥接调用仍使用 `execFile`，不经过 shell。此保证只约束 argv 结构；下游程序仍可按自己的规则解释前导 `-` 等参数，本修复不自动插入 `--` 或改写选项。参数解析器只报告结构性错误，示例派单脚本只报告结构性原因/退出标量，不回显任务 argv 或子进程输出；桥接执行器既有输出诊断未调整。调用超时和输出缓冲上限保持原值。

回归命令：`node --test test/executor-cmdline.test.js test/executor-parser-regressions.test.js test/executor-impl-doc.test.js`，只用惰性 Node argv 记录夹具，不证明真实 Windows/DSH/服务器验收。

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

角色 → 工具（可在 `tools/TOOLBOX.md` 查到同款模板）：

| 角色 | 命令 | 产出事实 |
|---|---|---|
| `recon` | `subfinder -d <域名> -silent` → `httpx -silent -td -title -sc -rl 20` | `domain` / `asset` |
| `assess` | `nuclei -silent -jsonl -severity critical,high,medium -rl 5 -retry 1` | `vuln` |
| `vuln` / `exploit` / `internal` / `chain` | **未实装** | 明确非零退出（fail-closed，不猜不造） |

**出口纪律**：目标是外部地址时必须给 `GUNGNIR_EXIT_SOCKS`（跳板出口），否则**拒绝执行**；
本地/实验室目标需显式 `GUNGNIR_ALLOW_DIRECT=1`。原始输出落盘到 `GUNGNIR_ARTIFACT_DIR`
（默认 `<cwd>/artifacts/<external_id>/`）供人工复核；工具失败即非零退出 → 主控记 `unknown`。

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
