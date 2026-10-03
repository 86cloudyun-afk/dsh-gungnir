# Independent Review: Parent Session Standby

本机固定基线：`70a5a775127b77dd143ff9e39cd2cc0f94097255`。独立审查者：`/root/independent_review`。
审查为只读，覆盖变更代码、测试、计划、Proposed ADR-005，以及已安装官方宿主 API；
没有修改 checkout/index/HEAD，没有读取秘密，没有执行真实 DSH、模型或目标动作。

## 首轮结论

无 Critical；复现 8 项 Important，初始补丁需要修复。

| # | 独立复现的问题 | 修复及闭环 |
|---|---|---|
| 1 | 同代旧／无序号探针被当作停止证明；丢 status 后序号 floor=0 仍有因果缺口 | 持久 generation 所属取消 ID；源确认须同时匹配账本和 stop，且同代、同序、超过下限；旧源证明不补 ID |
| 2 | 后续探针省略残留资源就被假判全停 | 持久资源身份并集，遗漏仍为未证实，跨重载保留 |
| 3 | 公开 collect 可给尚未派发的宿主任务注入同代事实 | 宿主任务仅允许经验证的宿主观察入库，无模型可控 trusted 参数 |
| 4 | 第二应答器持旧 claimed 快照把 done/2 覆盖为 unknown/3 | 活跃／存活未知领取者独占发布；确认领取者退出后才重读最终记录 |
| 5 | 取消终态与通知之间崩溃导致永久漏通知 | 状态与 outbox 同一事务；派发门闸拒绝先持久登记取消 |
| 6 | 计量登记失败重试仍报 queued，实际无预留且不可派发 | 幂等重试明确 E_REGISTRATION_INCOMPLETE，不虚报成功 |
| 7 | queued／重载后 terminal 无 adapter 记录，status 报任务不存在 | 始终可查询持久账本；不可用运行态／实时证明为 null |
| 8 | 延迟实际派发未复核出口验证有效性 | 首次派发前复核适用门闸，不重复计量 |

修复测试均有预期失败记录。第一轮定向闭环确认 7 项关闭，#1 的丢状态因果问题继续保留。
补持久取消 ID 后，审查者独立运行 5 项因果证据回归，5 通过、0 失败／跳过。

## 最终定向闭环结论

> Finding #1 is locally closed. All eight original Important findings are now locally closed.

> No unresolved Important/Critical issue was identified in this narrow closure check.

这项结论是原问题的定向闭环，不代表真实宿主／云端已验收。
审查者核实：官方 SessionHandle.read 的 offset 是逻辑事件序号，规范日志从 0 连续，
因此 seq+1 游标符合所读官方 API。

## 未裁决／未验证

- 真实 DSH 启动、模型和完整会话生命周期：未授权运行，仅检查 API。
- 真实执行器取消和资源终止：仅惰性证明，未声称真实停止；缺确认必须 unresolved。
- 云／服务器部署、生产文件系统行为：本机离线范围之外。
- 上游 `0edf4f9` 新自授权／bootstrap 权限面：用户明确排除，未吸收。
- 既有知识／POC、真实凭据及其他基线安全架构：本次调度审查范围之外。
- 六项原生环境跳过：保留为未验证，不算通过。
