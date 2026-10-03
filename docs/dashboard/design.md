# GUNGNIR 对话联动战图

用户已批准的方向：全局总览与局部钻取为默认视图，保留完整分层战图，支持从对话定位当前链路。风格为近黑底、细直角线路、紧凑节点和少量状态色。复杂度通过分层、聚焦和折叠处理。

## 使用体验

- 左侧约四分之一为对话与相关事件，右侧为战图；窄屏改为上下排列。
- 默认上方显示全局、下方展开选中节点及上下游；全图模式显示完整拓扑。
- 点对话中的明确引用定位图中节点，点节点反向突出相关对话。搜索支持节点、来源、任务与跳板编号；没有匹配时明确提示。
- 节点分为入口/跳板、资产、证据、链路、结论五层，由下向上推进。支持分叉、汇合、共享证据、孤立事实及环；任何关系都必须来自显式数据引用，模糊引用不猜边。
- 主线旁固定显示跳板编号、入口、出口、租约和出口核验结果。未知值显示未知。折叠、聚焦不能隐藏失败、待核验与过期租约，相关计数和摘要必须保留。
- 证据只在入邻居、出邻居、路线/任务关联和风险状态完全相同的情况下合并；其余保留原节点。每个摘要保留全部来源 ID，点击可展开。折叠不能创建新的可达路径，摘要数量须对应实际合并结果。
- 对话定位是导航。输入框提供本地查找与定位，不触发执行、停止、派单或改变事实。
- 内置演示须明确标记演示数据；真实数据库为空、不可读或 DSH 对话未接入时分别显示真实状态，不替换成演示。

## 数据与边界

事实库仍为唯一真源。dashboard 使用 SQLite `readOnly: true` 打开已有 `fact.db` 和 `global.db`，不建库、不迁移、不调用 Broker/adapter，也不读秘密表。快照只输出渲染需要的白名单字段；payload 不原样出接口。

节点身份使用 `(adapter_instance, entity_type, source_id)`，不同适配器或类型的同名来源不能合并。引用优先解析完整对象，其次同适配器的唯一来源，再其次全局唯一来源；歧义和缺失引用计入 diagnostics，不能选第一条。历史事实不参与当前拓扑。

节点/边的显示标签、缺失标签的显示回退和会话标题使用已有 redactor，先脱敏再截断。身份与引用字段保留既有值以维持精确导航；脱敏不改写三元组 ID 或拓扑。原生读取错误仅返回固定代码与文案，不向页面传递本机路径或底层异常。

租约有效不表示出口有效；同一跳板其它 route 的 pass 不适用于当前 route；旧租约/过期 route 的出口记录不显示当前通过。取消请求不显示已停止，历史 proof 与当前 validity 分列，缺失状态保持 unknown。

DSH 原生接入遵循当前 0.2.0-rc.2 的 Client composition：插件在 `conversation.view` 注册“战图”页签，React wrapper 挂载由宿主交付资源的 sandbox iframe（仅 allow-scripts，无 allow-same-origin）。`webServer.register` 仅交付静态资源；原生页面不开放 HTTP 数据接口。父页面通过现有 `ctx.connection.rpc.call` 发起已认证读取，iframe 只接收白名单 DTO，不接收 token 或宿主上下文。

桥接仅接受 `event.source === iframe.contentWindow`、opaque origin（null）、正确随机 nonce 与白名单消息形状的请求，操作范围限定四个读取端点。父页面通过 slot 的 `inject(sessionId)` 注入当前会话，页面输入不能扩大范围；切换会话、卸载或取消必须中止请求并丢弃旧响应。子页面验证父 origin/source 和 nonce。iframe 的 embedded 模式只使用桥接，连接失败不回退到 HTTP；原生资源 CSP 禁止网络数据连接，仅静态资源开放不带凭据的 CORS。

服务端配置 `sessionBindings: { [sessionId]: engagementId }` 作为固定战役绑定。每个原生 RPC 请求均调用 `sessionController.list({}, signal)` 复验会话可见，绑定决定允许读取的唯一战役；没有绑定或不再可见则拒绝，UI 的 engagement 参数仅用于一致性校验。原生会话列表只返回当前绑定会话。冷读对话使用真实 `inspect`/`page` 契约，只提取用户与助手正文，并屏蔽工具载荷与敏感字串。

独立入口只在 loopback 服务本地页面和快照，按 Host/Origin 限制来源；浏览器端不接收宿主 token。所有外部内容按文本呈现。

## 快照接口（gungnir-dashboard/1）

`readDashboardSnapshot({ home, engagementId, now? })` 返回：

- `schema`, `mode: live|demo`, `generated_at`, `engagement`, `watermark`, `nodes`, `edges`, `routes`, `tasks`, `conversation`, `diagnostics`。
- `nodes`: `{ id, source_id, adapter_instance, entity_type, label, layer, state, route_ids, task_ids, highest_proof, current_validity, updated_at }`。state 为 `verified|pending|failed|unknown`，layer 为 0..4。
- `edges`: `{ id, from, to, label, kind, route_ids }`；kind 为 `explicit|reference|route`。引用关系区别于已证实攻击步骤。
- `routes`: `{ route_id, jumphost_id, entry_ip, exit_ip, state, lease: { state, expires_at, remaining_seconds }, egress: { verdict, checked_at, current }, node_ids, edge_ids }`。
- `tasks`: `{ task_id, command_id, state, role, route_id, updated_at }`。
- `conversation`: `{ status, session_id, messages }`；消息 `{ id, role, text, created_at, node_ids, route_ids, task_ids }`。状态为 `connected|unavailable|demo`。仅结构化引用和唯一精确 ID 产生关联，普通 IP/模糊文本不自动连边。
- `diagnostics`: `{ unresolved_refs, ambiguous_refs, warnings, counts, truncated }`；截断必须显示实际总数和截断说明。

`listDashboardEngagements({ home })` 返回已有战役的摘要数组。读取时验证 engagement 的路径不逃逸 home。`createDemoSnapshot()` 返回同一形状的纯内存演示，包含四跳板、分叉/汇合/共享证据及通过/待核验/失败/未知情况。

`layoutGraph(snapshot, options)` 返回完整可渲染节点坐标、直角边路径和边界；`focusedSubgraph(snapshot, selectedId)` 返回当前节点的完整祖先/后继闭包，遍历必须能处理环。布局不因聚焦删除全局警告。

## 验收

只读打开与读取前后库 hash/水位不变；混淆身份、跨战役、歧义引用、恶意标签、过期租约、route 核验错配、取消请求、空库和损坏库都有回归。真实浏览器验证对话↔节点定位、全图/钻取切换、折叠保留异常、缩放/拖拽/适配、搜索、快照刷新、窄屏和错误状态。最终交付包含实际页面截图、六闸结果与 PR；DSH 真宿主挂载单列验证结果。
