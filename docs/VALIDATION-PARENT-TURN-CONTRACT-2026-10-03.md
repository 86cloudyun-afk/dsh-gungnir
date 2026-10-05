# 原生派单的主回合交互契约修复

基线：`d2a4eaf653a2a12bacf23d44ede05fa4fb4ddcb8`（已合并 #163）。
用户报告主会话仍显示等待子智能体及 `timeout_ms: 120000`；尚无现场部署版本、任务日志或实际工具调用记录。

## 已复现的源码缺口

原生 `toToolDefinition.execute(args, exec)` 在 `exec` 为 undefined/null 时，穿过
`dshTools` 的宿主上下文分支，进入直接工具的同步 `broker.execute` 兼容路径。
该路径可进入 filebridge 的同步 `_awaitFile`；源码没有通用子智能体 wait 工具。
此证据证明原生入口存在同步回退缺口，不证明用户现场 120000ms 的来源。

修复在原生包装边界拒绝缺父 agent 的调用，错误码 `E_HOST_CONTEXT_REQUIRED` 明确说明未登记、未启动。
存在但畸形的父身份继续由原有身份和 broker 校验拒绝。合法调用复用既有持久后台任务与通知机制，
返回原有 task_id、generation、state，并增加 `host_dispatch`：background、host_notification、return_to_user。
实际 DSH 工具描述同步说明登记后结束当前回合；该提示不保证模型遵守，也不替代真实宿主验收。

直接工具和 CLI 同步兼容保留；Broker、归属路径、HostTaskRunner、权限、Accepted ADR、
执行器 120000ms 资源上限均未修改。没有新增持久编排或自动重派机制。

## 回归证据

`node --test test/parent-turn-contract.test.js` 的 12 个惰性测试覆盖：

- 缺失或畸形父上下文在任何登记、计量、适配器派发前拒绝。
- 派单返回 queued 与可追踪标识时 source 尚未派发、尚未完成。
- 模拟父会话的新用户回合能查询状态，完成/失败通知延后到用户回合结束。
- done/failed 各只通知一次；同命令幂等返回保留后台契约、不重复通知。
- 无通知能力拒绝；直接工具的同步兼容保持。

RED 阶段 12 项中 6 项预期断言失败（缺上下文、描述和返回契约）；修复后目标套件通过。
旧 `bootstrap-verbs` 原生正样本也遗漏了父上下文：现夹具提供稳定父身份和惰性观察器，
保留 schema、可信授权引用和正确任务断言，并验证 queued 返回后由 host tick 首次派发。
既有 host-runner/tasks/delivery 回归覆盖取消迟到成功、撤销、旧代/旧序号、重启 unknown 不重派及持久通知去重。

独立只读复审未发现阻断性问题。复审明确：手动切换模拟 agent 状态不能证明部署环境的真实主回合已结束。

## 验证与限制

复跑六闸：`npm run ci`；文档计数：`node scripts/check-doc-counts.mjs`。
Mac 沙箱基线 706 项中 4 项因本地监听 EPERM 失败、6 项因无原生 DSH 跳过；允许临时本地监听后重验。
首次全量修复验证发现上述旧 native 正样本缺上下文并修正。
随后全量运行一次既有 conformance-bridge 在 1200ms 内未取得停止/回执证据，单独复跑通过；
该测试与停止证据守卫保持原样。最新完整六闸全部通过：718 项中 712 通过、0 失败、
6 项因本机缺原生 DSH 跳过；文档计数守卫确认 718 / 36 工具 / 21 故障场景。
旧授权正样本和文档增量独立复审也未发现阻断性问题。

所有新增用例仅使用合成目录、惰性 Fake adapter 与模拟父会话；未执行真实任务载荷、模型或目标动作。
未部署、重启服务或清理账本。现场仍需核部署版本、调用上下文、工具名与通知能力，
再用无害任务验收真实父会话返回、新消息处理和通知；CI 的 native-host 挂载证据不能代替用户服务器验收。
