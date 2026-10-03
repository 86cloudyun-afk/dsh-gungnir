# 字面参数修复的主线整合

2026-10-03 原 PR #172（head `63473fd89451dbe3cac9db3b17a15798b3023286`）与
main `21f18adfa81e571220fd0262ed0391a569fb3e2d` 三方整合。
解析器与示例派单生产代码无冲突，保留可信配置先解析、固定可执行文件、任务字段一次性字面替换，
不重新分词、不重复替换、不经 shell；引号与 UNC 边界回归保留。
批准契约、宿主身份、权限、Accepted ADR、资源上限与停止生产实现未改变。

README、ACCEPTANCE、FINAL-AUDIT 计数冲突按新组合实测更新。
旧 responder 首测试只解决异步等待竞态；当前主线已提供更强的确定性验证，
故整合保留 `test/dsh-responder.test.js` 主线全部字节：
`running` → 首次取消 `unresolved` → session/container 两项都有真实源停止证据 → `confirmed_stopped`。
同时保留 daemon done 活资源须真的停止、残留 false/unresolved 与身份隔离负例；
不恢复旧宽松 done 容忍，不删非空清单或逐项证明断言。

原 head 的 RED/GREEN、旧 CI 单次失败与停止负控制保留在 PR 历史；旧绿不认证当前组合。
所有 Mac 验证使用交付证据包的外部 `offline-scope.cjs`，阻断真实工具、网络/系统探针、原生 DSH 和部署。
skip 由该外部范围 guard 实施，未修改产品断言或增加测试 skip。
不含秘密的隔离副本用于测试，发布树仅保留主线 tracked secret 原对象引用，未读其内容。
真实 Windows、用户 DSH、服务器接线与长期运行验收尚未完成；不合并或部署。


## 本次新组合的 Mac 证据

完整离线六闸全部 exit 0；858 登记用例 /822 通过 /0 失败 /36 明确范围跳过。
工具数36、故障矩阵21；计数守卫采用真实登记总数，范围跳过不计为通过。
参数新回归、应答器停止与幂等、桥身份来源和批准绑定聚焦 70/70 通过，无跳过。
上述均为新组合的本次实际运行，不借用原 head 的测试或 CI 结果。
