# #163 精确发布后的两项 CI 修复

原发布 head `e0e9e445a09ab7461cc9dc448482390ea40ad512` 与已审本地 `dd0924bb02388eef5aee2b7980b1d0668678daaa` 同 tree `4b4ffa8c29dcf0101f409b777b46b45f004a5b48`。独立远端核对246 leaf/55差异路径完全一致。原 [CI run37072976279](https://github.com/86cloudyun-afk/dsh-gungnir/actions/runs/37072976279) attempt1失败：standard638/629pass/2fail/7skip、native638/634pass/2fail/2skip。fence/drill和单独native mount通过，后续standard闸跳过。原本机guard的638/619/0/19仅是旧tree历史证据，不覆盖被明确排除的诊断调用。

## 根因和最小修复

- 停止测试允许 `Broker.execute` 记录真实 daemon 初始 done，却随后要求逐资源 stopped。`collect` 不改变状态；Accepted ADR-003 D4要求终态cancel仅返回当前终态，所以不会调用adapter.stop。调查preload只等真实source done，确定性重现原断言失败，未写造状态/证明。产品生命周期、Broker/adapter/responder及Accepted ADR完全不改。
- 停止夹具改为真实跨进程 legacy `--once`，严查初始running、事实入库、首次unresolved和stop文件、session/container两项源证据均true、最终confirmed_stopped。新增daemon实际初始done用例严查collect保留done、cancel返回done、stop文件不存在及非空资源仍false，明确done不证明stopped。原daemon在飞取消/资源残留用例保留，不能复活或假报停止。
- executor错误保留批准120000ms默认、原命令解析和source generation检查，仅增加err.code/killed/signal标量。保留原err.message和stderr前500字符边界，不引入新的stdout/stderr尾部或900000ms扩展。原err.message本身可能含底层stderr，此既有暴露未重新认证；真实执行器诊断安全需另行审查。
- 只读取检查#165/#168的诊断夹具：当前Node解释器和带空格的脚本复制/链接至无空格临时alias，保持exit9和具体原因断言，再强化killed=false/signal=none。恢复原环境变量并清理临时目录，不扩展产品空白命令解析，不改变/合并其他PR。

## 本机离线证据

两项原测试在真实惰性source握手下RED0/2。停止夹具与daemon终态用例2/2通过，便携诊断在产品改动前仍RED。标量元数据修复后，九个相关套件86total/80pass/0fail/6skip。完整 `node scripts/ci.mjs` 在本次明确范围的外部preload下639total/621pass/0fail/18skip，六闸退出0，故障矩阵21/21、固定36工具。完整日志、调查preload、独立复审及精确commit/tree/patch随本机交接提供。

18skip为12个仍排除的真实executor/network/resource用例与6个本机不可用native用例；原排除诊断现在仅用惰性Node子进程运行。跳过不计通过，preload不作为通用安全沙箱。完整套件生成的合成默认home key随后未读字节直接移除，原tracked secret对象始终缺失/未获取/未读取。

本修复只作为本机候选，发布tree变动需精确审查和发布授权。旧远端head仍是失败结果，不能用本机green替代新head CI。Mac不是最终运行验收平台；真实父会话/模型回合、云/服务器、生产fsync/重启、执行器终止和实际资源停止证明保持未验证。终态任务的资源清理并未实现，done不是confirmed_stopped，不能据此关闭真实资源验收。无ready/merge/deploy或其他PR待批准动作授权。
