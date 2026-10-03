# Parent Session Standby — 本机验证记录

范围为防御性会话调度、持久任务恢复和原父会话通知。基线固定
`70a5a775127b77dd143ff9e39cd2cc0f94097255`，隔离分支 `codex/parent-session-standby`。
Mac 仅初测；不将这份记录视为云／服务器最终验收。

## 最终门禁

命令：`node scripts/ci.mjs`，退出 0。

| 门禁 | 结果 |
|---|---|
| node --test | 503 总数：497 通过、0 失败、6 环境跳过 |
| tool-schema | 通过 |
| preset | 通过，固定 36 工具 |
| fault-matrix | 21/21 通过 |
| docs | 通过，生成 schema/工具文档同步 |
| self-review | 通过，链接、验收引用、合成秘密标记与卫生检查 |

最终完整输出为交付目录 `final-ci.log`；四项宿主套件 `review-final-targeted.log` 为
63/63 通过。`git diff --check` 通过。Accepted ADR-001–004、预设允许清单、工具目录均未改。

基线全套 440 项为 432 通过、2 失败、6 跳过。两项失败都是 Mac 沙箱 `listen EPERM 127.0.0.1`；
最终使用自动审查允许的临时回环测试权限，两项通过。没有修改持久权限／安全设置。

## RED → GREEN 证据

- 初始派单登记、非阻塞桥、恢复、源代际：`task1-red.log` → `task1-green.log`。
- 宿主观察及投递：`task2-red.log`、`delivery-red.log` → `task2-green.log`。
- 取消／collect／settle／redispatch／计量／批准边界：`task2-boundaries-red.log` → `task2-boundaries-green.log`。
- 跨进程惰性 worker 与持久领取：`task3-red.log` → `task3-green.log`。
- 完成状态丢失、同代事实序号、卸载、缺附着：`recovery-red.log` 四项预期失败 → `recovery-green.log` 25/25。
- 独立复审问题：`review-red.log` 13 项预期失败；`publication-race-red.log` 确定性竞态失败；
  `stop-source-red.log` 两项源证明失败；各修复日志通过。
- 丢状态和因果确认：`causal-proof-red.log` 三项预期失败；`causal-ledger-red.log` 账本／spool 重绑定失败；
  最终四宿主套件 63/63。停止回执的标识由实际模拟源确认，适配器不补旧证据。

测试仅使用惰性 adapter、临时目录、无副作用 executor、内置 SQLite、回环夹具及本机测试子进程。
没有执行真实目标动作、真实模型调用、部署或出版。原仓秘密 blob 未取回；测试生成的随机夹具密钥
仅供测试程序内部自用，未向助手／对话输出，不进入提交／补丁。

## 独立审查和剩余限制

[审查记录](reviews/2026-10-02-parent-session-standby.md)：首轮复现 8 项 Important，无 Critical；
修复后原 8 项均由同一独立审查者定向确认本地关闭。原生 API 形状的测试不能替代完整宿主运行。

六项跳过包括 deploy --verify、fail-closed 原生正／负例、HOST_VERIFIED、真实 activate、
36 工具原生会话目录；缺 DSH_BIN/DSH_PKG_DIR，不启用真实运行。
真实模型、真实执行器终止、真实容器围栏、云／服务器、生产文件系统与最终会话体验未运行。
真实执行器若未返回匹配取消标识的逐资源新证据，结果保持 unresolved。

[上游兼容记录](UPSTREAM-COMPATIBILITY-2026-10-02.md)：未合入 `0edf4f9` 的 #153/#154 自授权／bootstrap。
补丁只承诺固定 36 工具基线。已有 GitHub 写入 403 约束仍有效：未 push、发 PR、合并，
不使用 CLI 绕过拒绝；主任务另行处理变基安全裁决、最终平台验收和发布权限。
主任务另报告 #157 外部合入 `278e72d5…`，含未修 shell 参数／出口例外边界；仅记录、未取回／执行。
不能未经独立安全审查整体变基吸收 #153/#154/#157 能力。
