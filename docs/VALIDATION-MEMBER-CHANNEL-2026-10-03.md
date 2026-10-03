# 现有通道的失败回执修复

原修复的历史基线：`d2a4eaf653a2a12bacf23d44ede05fa4fb4ddcb8`。仅修复编排/回执正确性，未部署或合并。

## 可复现的代码缺口

`scripts/dsh-bridge-responder.mjs` 原先只核源身份和 `members/resources` 数组，随后后台一律发布 `done`。
因此执行器明确返回 `state: failed/incomplete`、`ok: false` 或错误对象，同时带空数组时，会被转为成功。
`executors/dsh-redteam-executor.mjs` 的命令包装还会丢掉这些失败字段，并把缺失/畸形资源数组补成 `[]`。
这些是惰性夹具已复现的源码缺陷；不能据此认定现场 `intake` 缺工具或此前 120000ms 问题的根因。

修复在命令包装前、fixture 两个源 envelope 映射前和应答器发布前使用同一纯校验：显式非成功返回 `E_EXECUTOR_INCOMPLETE`，
缺失/畸形数组返回 `E_EXECUTOR_RECEIPT_INVALID`。保留已领取的幂等键，状态保持 `unknown`；
不写空成功事实或资源证明，不自动重试，不推断任何资源已经停止。
固定诊断代码与 job 的 `external_id/generation/role` 一起持久保存到 claim/status；
不把执行器提供的自由文本错误内容当作可信诊断或新权限。
现有 driver 只消费既有状态字段，诊断详情仍在源 claim/status 文件中。

## 兼容矩阵

| 源返回 | 行为 |
|---|---|
| 原合法回执，无 outcome 字段，同代身份与两数组完整 | 保留原成功路径，合法零事实回执仍可完成 |
| `state: done` / `status: success` 或 `done` / `ok: true`，且所有出现的标记一致 | 保留原成功路径 |
| 显式 `failed/incomplete/partial/unknown`、畸形 outcome、非空错误 | 保持未知，不发布完成，也不伪造 partial 账本事件 |
| 缺失/畸形 `members/resources` | 拒收，不由包装层补写 |
| 错 external_id / 缺失或错 generation | 原来源校验继续拒收 |
| 同一 job 重投、应答器重启 | 不重执行；拒收诊断保留，不恢复成 `done` |

`error: null` / `errors: []` 可与合法成功共存；未提供 outcome 的旧回执兼容不表示已验证通道工具可用。

## 原修复时的静态能力接线清单与现场缺口

| 角色/组件 | 已存在的工具或通道 | 本仓可核实的条件 | 仍未知 |
|---|---|---|---|
| commander / recon / chain | 共享预设的 36 个 `warroom_*` 工具；专门事实查询、报告与证据导出 | 源注册与允许清单闭合；没有直接通用文件/进程工具 | 现场实际激活预设、工具目录与版本 |
| recon 需要执行层动作 | `warroom_execute` → Broker → RedteamModeAdapter → 文件桥 | 指挥角色经既有受约束通道派单；未显式映射的 intent 默认 `assess` | 现场角色映射与任务是否送到该入口 |
| adapter | `fake` / `local` / `bridge` | 前两者为模拟；家目录配置名是 `warroom.json`，配置加载器会拒绝误命名的 `config.json` | 用户报告当前是 fake、bridge 未接线，尚无部署证据 |
| 文件桥应答器 | `--executor` 插件与既有 `GUNGNIR_EXECUTOR_CMD` 命令接口 | 同 spool 根、源任务身份/代际和完整回执是已有约束；命令未配置会失败 | 现场已安装提供者、注册对象与工具能力；命令存在不能证明它具备某种工具 |
| intake / x1-exec / lingshu ref | 本仓无定义 | 不能把文本 spawn 或 UTF-8 引用读取当作通用执行/文件通道 | 哪个插件/版本/角色/提供者创建了这些名称及其实际工具清单 |

不存在可供本仓核验的只读能力发现接口。本 PR 不新增 `preflight(job)` 调用或能力声明接口，
不修改 allow/deny、Broker 授权、Accepted ADR、执行资源超时或真实工具 runner。
后续需要部署版本、已激活角色、既有提供者注册与脱敏工具清单，才能判断具体缺少哪个配置或注册。
若将来设计纯数据能力声明，它只能收紧角色匹配/拒收缺能力，不能代替实际授权与可用性证据；该设计尚未接生产逻辑或 Accepted。

## 原修复的历史验证

- 独立复审发现并补修 fixture 同类绕过；8 项负例先红后绿，最终复审未发现其他重要问题。
- 红证据：原实现把惰性 `failed` 返回发布为 `done`；收紧 outcome 后，包装层缺失/null/object 资源仍有三项负例误完成。
- `node --test test/executor-outcome.test.js test/executor-plugin.test.js test/host-responder.test.js test/dsh-responder.test.js`：68 项通过。
- 不含秘密目录的独立临时副本 `npm run ci`：六闸通过，测试 754、通过 748、失败 0、原生 DSH 环境缺失 6 项。
- 本地初次全套受沙箱 loopback 监听限制有四项 EPERM；全局覆盖 WARROOM_HOME 的一次复跑使原配置优先级测试失败。
  使用独立验证副本、保留原测试环境后上述失败消失；没有改测试守卫或共享配置实现。
- 新测试的 targets 为空、wire_cost=0，仅临时模块与 JSON 回执，无真实目标、模型调用或攻击工具。

现场工具可用性、通道部署、任意文件读写能力均未验证。push / pull_request CI 另以最终提交的运行记录为准。


## 整合最新主线的复核

2026-10-03 与 main `21f18adfa81e571220fd0262ed0391a569fb3e2d`（已合入 #177）三方整合。
原纯回执校验、命令包装、fixture 映射与持久 unknown 诊断保留；生产代码没有冲突。
仅解决 README/ACCEPTANCE 计数冲突，并刷新 FINAL-AUDIT 单一数字锚点。
保留主线源身份与 generation/event_seq、非空清单与逐项停止证据、批准契约和宿主守卫；
未新增工具、权限、提供者接线或真实执行能力。

新组合 Mac 离线六闸均 exit 0：889 登记用例 /853 通过 /0 失败 /36 明确范围跳过；
执行器 outcome、桥来源隔离与批准绑定聚焦 95/95 通过。计数工具36/故障场景21。
跳过仅由本地外部 `offline-scope.cjs` preload 执行，不改变产品测试或守卫。
原章节与静态接线表记录原修复证据，本次不把它视为现场能力认证；旧 CI 不能替代新组合 CI。
旧工作树测试生成 key 的清理拒绝保持，不读取、清理或上传该文件；本次新隔离副本未复制秘密，
发布树仅继承主线原有 tracked secret 对象引用。
现场 intake/lingshu/x1-exec 工具目录、部署版本和用户服务器运行验收仍待核实；未合并或部署。
