# ADR-005 宿主持有派单与父会话完成通知

- 状态：Proposed（2026-10-02）；不修改 Accepted ADR-001–004。
- 基线：`70a5a775127b77dd143ff9e39cd2cc0f94097255`。
- 范围：防御性会话调度、任务恢复和通知可靠性；不增加执行工具、角色或目标动作。

## 已批准的行为

DSH 的 `warroom_execute` 使用宿主提供的 `ToolRunContext.agent` 绑定父会话。
broker 校验授权、预算与幂等约束，将任务和父会话身份一起持久登记，立即返回
`task_id / generation / state=queued`。工具返回时没有工具持有的后台 Promise。
宿主服务负责首次派发、观察回执、停止证明和通知。commander 汇报已登记后结束活动回合，
不等待、不轮询子任务；用户消息正常处理，无事保持空闲。

CLI 和直接 broker 的同步调用接口（包括 wave）保留。DSH 工具执行上下文存在却缺 agent、
宿主通知能力或稳定父身份时拒绝派单；不得悄悄退回阻塞路径。

## 持久边界

- global.db 保存父 session id + durable header.createdAt、原授权版本、首次派发标记、取消标记、
  源事件游标、通知日志、父会话日志读取游标、取消标识和已知资源清单；只能由宿主服务写。
- 首次派发前先持久写 attempted。崩溃落在 attempted 与执行器接收之间时，只观察现有任务，
  状态 unknown，不自动重派。尚未 attempted 的登记任务可以首次派发，但必须重新检查授权。
- 进程重启和插件重载通过既有 task_id 附着 filebridge job，不调用 spawn；通知重放也不派单。
- 事件必须携带源 generation 与单调 event_seq。缺代际、旧 attempt、旧序号、取消后的完成、
  授权撤销/过期后的完成均不能激活任务、入有效事实或产生成功通知。
- 事实和探针也必须保留其源 generation。不得用 adapter 当前记录替旧回执补 generation。
- 完成事件去重与源游标、账本迁移、待通知登记同一 global.db 事务提交。
  事实库先按既有成员键幂等落库，失败时不推进源游标。
- 宿主任务的公开 collect 不接受调用方回执；仅验证后的宿主观察路径可入库。
  未完成计量登记的幂等重试明确报 E_REGISTRATION_INCOMPLETE，不虚报 queued。
  实际首次派发再次检查适用的出口验证门闸，不重复预留预算。

## 停止与通知

取消工具先登记 cancel_requested；宿主请求停止，随后清单逐资源取证。
清单至少含会话；缺项、缺代际、残留资源均为 unresolved，不能凭状态字符串宣称已停止。
已知资源身份取声明和历史观察的持久并集；后续回执省略资源不能抹去停止证明义务。
取消登记同时保存代际所属的 request_id；stop 携带该标识和当前源序号下限。
停止证明须同代、与状态同序、超过下限，并由源明确返回匹配持久账本的 stop_request_id。
源状态丢失时也不能用旧回执推断因果；缺确认保持 unresolved，不能给旧 executor 证据补标识。
取消终态与对应通知同一事务提交；派发边界门闸失败先进入持久取消路径。
取消标记不可因 late done / running 被清除；不自动重派。

通知只发回登记父会话。session id 和 createdAt 必须同时匹配；找不到父会话时保留通知，
身份不匹配时封存，不跨会话投递。父会话正在活动或有待处理用户消息时推迟通知，
在真正空闲时使用普通 followup；不得用 steer 打断用户。

通知 id 由 command/generation/source sequence 确定。宿主先 flush 父会话，通过
sessionPersistence.open(id, 'read') 读取 append-only inbox splice 日志检查通知是否已经接受；
followup 后再次 flush 和检查，才登记 delivered 与读取游标。
崩溃于发送和确认之间时从同一父日志核验，不重复发消息。
缺持久存储/flush 能力时保持未确认，不虚报送达。
通知只携带账本 task_id、generation、状态与核账要求；原始 worker 输出不进入通知提示词。
commander 收到通知后先查账本再汇报事实与未证实项。

## 桥协议增量

现有 gungnir-bridge/1 JSON 形态增加 generation（status/facts/probes/stop）与 event_seq（status/facts/probes）。
宿主后台模式只原子写 job/stop 并返回，不调用 Atomics.wait；旧 CLI 等回执接口保留。
应答器先持久记录已领取 job，重启不再次执行；执行结果写 facts/probes 后才公布完成状态。
领取进程独占完成发布；其他进程不覆盖活跃或存活未知的领取者。只有确认领取进程已退出后，
才重读其已持久记录并恢复状态。领取者 PID 仅用于排除并发发布，不作资源停止证明。
已领取但未完成的任务恢复为 unknown，不重试 executor。stop 不伪造 executor 的资源停止证明。
完成事实与状态必须同序；已完成领取保留最终事件，状态丢失后核验回执并重放原序号，不重执行。
所有这些变化只收窄可靠性边界，不增添执行能力。
host 任务查询始终返回持久账本；运行态或实时停止证据不可用时为 null，不依赖内存附着。

## 验收与限制

使用无副作用惰性 worker/夹具验证：派单已返回、用户插话优先；忙闲通知；丢通知/重启/重复乱序；
取消完成竞态、旧代、撤销、父销毁/身份失配；资源残留；工具允许集不扩大；CLI wave 回归。
本机 Mac 仅离线初测。真实模型、目标动作、部署、云端/服务器最终验收均未授权、未运行。
不得推送、发 PR、合并或以 CLI 绕过连接器写入拒绝；交付本地提交与补丁供主任务审查。
