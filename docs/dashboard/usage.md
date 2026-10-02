# GUNGNIR 对话战图

战图是只读浏览器视图：全局与局部钻取默认并列，完整五层图可切换；对话引用只导航到现有节点、route 或 task，不触发工具、派单或事实写入。每条 route 始终显示自身跳板、入口/出口、租约和出口核验。合成示例须在页面中主动选择，并持续标记为演示。

## 本地只读启动

```sh
node bin/dashboard.mjs --home "$WARROOM_HOME" --port 0
```

不传 `--home` 时，页面展示真实空状态且不会创建默认家目录。明确传入的 home 不存在、数据库损坏或路径逃逸会显示错误，不回退到演示数据。服务只绑定 `127.0.0.1`，`--host` 仅接受 loopback；浏览器请求仅允许同一 Host/Origin 的 GET/HEAD 和已知页面资源/API。进程收到 SIGINT/SIGTERM 后关闭监听器。使用 `--help` 查看参数。

## DSH Client 挂载

隔离 profile 的挂载候选配置是将插件 loader 条目的 `name` 指向仓库内 `packages/warroom-dashboard/src/dsh-entry.mjs` 的绝对路径；manifest 声明的 package identity 是 `@gungnir/warroom-dashboard`，Client entry 为 `./client`。该配置仍须在目标 DSH profile 中实挂并检查 Client slot 是否出现；源码/manifest 和进程内测试不证明实际插件已激活，也不构成 `HOST_VERIFIED`。

在该 profile 的插件配置中为 Host 插件传入固定 session→engagement 绑定：

```json
{
  "home": "/absolute/path/to/WARROOM_HOME",
  "sessionBindings": {
    "session-abc": "eng-2026-001"
  }
}
```

每次 RPC 都重新调用 `sessionController.list({}, signal)` 确认会话可见，再以该绑定决定唯一 engagement；UI 参数只作一致性校验。未绑定、不可见或不一致会返回 scope 错误。Host `webServer.register` 只交付固定静态资源；JSON 由已认证的 `connection.rpc.handle('/warroom-dashboard', ...)` 提供。Client 在 `conversation.view` slot 的 `inject(sessionId)` 取得可信会话身份。嵌入 iframe 使用 `sandbox="allow-scripts"` 与 opaque origin，严格验证 `event.source`、`null` origin、随机 nonce 和消息形状；child 只通过父页面桥接读取 RPC，不能 HTTP 回退，也不收到 token 或 Host context。

Conversation 是冷读快照，不是 live subscription。读取 `inspect` 的已记录事件前缀，再通过 `page` 取得正文；只显示人为 `user/message` 与已提交的 `assistant/message` 文本块，合成 user source、tool、stream、attempt 和 reasoning 都不会呈现。历史分页/正文截断会在 diagnostics 中标注；刷新会重新冷读。脱敏针对显示白名单字段中的常见 token/password 格式，不访问秘密表。

## 验证

```sh
node --test test/dashboard-snapshot.test.js test/dashboard-graph.test.js test/dashboard-server.test.js test/dashboard-dsh.test.js test/dashboard-client.test.js test/dashboard-transport.test.js
node --check bin/dashboard.mjs
node --check packages/warroom-dashboard/src/server.js
node --check packages/warroom-dashboard/src/dsh-entry.mjs
node --check packages/warroom-dashboard/src/conversation.js
node --check packages/warroom-dashboard/src/client.js
```

本轮已完成独立临时 HOME/cwd 中的实际 DSH Client 页签和 Chrome 验收，测试正文与数据库均为合成夹具，详见 [验收记录](validation.md)。生产宿主加载仍须使用目标 session binding 和目标浏览器单独验收。
