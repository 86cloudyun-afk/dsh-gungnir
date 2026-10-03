# #163 防御性整合：本机离线候选

本候选基于刷新后的 main `6adbb9c478164744690aed20753e792ce5728ade`，结合已审 #164 工具面限制和 #167 重派守卫，语义整合原 #163。仅本机隔离工程，未发布候选、未改变 #163–#167 分支、未合并或部署；#164 ready/merge 仍需用户另行明确确认。

## 采用与拒绝的语义

- #164 的固定 36 工具及完整输入 schema 保留，模型无 engage/import/acquire/probe。可信宿主/操作员准备授权，模型仅引用已有 engagement。Accepted ADR-001–004 不改。
- #167 的原版本、归属、时间窗、scope、class、destructive 批准和 adapter 能力复核保留。#163 的 host-owned 禁重派与归属守卫同时保留，不以新当前版本洗白旧 generation。
- #163 保留 queued 持久登记、宿主首次派发/观察、父身份及持久投递去重；源 generation 和单调序号、逐资源因果停止证明、持久领取恢复不重执行均保留。
- #162 的常驻快速 running 确认及配置文件名守卫保留，包括非 background CLI job。daemon 完成写 done；legacy `--once` 等待活动结束并保留同步 running 回执，host background `--once` 保留 done。
- #162 的强制 stopped:true 与 blanket failed 不保留。未知执行失败保留领取键：daemon/host unknown；legacy `--once` 留错误而不伪造终态。源资源 false/缺项或缺因果确认保持 unresolved，不自动重执行。
- 测试等待事实仅在夹具侧；重复 collect 显式验证 duplicate_ignored。夹具自己提供真实源代际，生产代码不补旧回执 generation。
- 执行器默认仍为原候选批准的 120000ms，不静默升至 900000ms，不吸收新的 raw stdout 诊断扩展。真实执行器完全未运行。
- 整合核对另发现 queued 复核点仍接受畸形当前 class/window/clock；14 个惰性 RED 后在既有 assertHostAuthorization 增加同 #167 的 fail-closed 检查，覆盖首次派发和完成入库。无新接口、授权协议或执行能力。

## 新验证证据

显式授权的离线 preload 位于工程证据目录，阻止真实执行器、网络和资源探针。它只覆盖本次审查套件，不是通用安全沙箱。

- 六个新增 #162/#163 兼容回归：current main RED 0/6；原 #163 移入后 RED 3 pass/3 fail；最小常驻兼容修正后通过。跨进程惰性 job 超过2秒时 ack 已返回且无 facts，完成后 source generation/sequence 对齐。
- #164 限制回归 RED 20 pass/13 fail；前置修复和 #167 定向 GREEN90/90。
- 宿主/回应器/bridge/wave/config/migration/边界综合定向177/177。
- 第一轮全量615 total/595 pass/1 fail/19 skip：新取消夹具在 ack 与 executor entry 之间发送 stop，未启动执行器导致等待残留超时。惰性确定性边界探针证实正确 unresolved、无执行和无 facts；只修夹具进入握手，产品取消语义未改。复跑615 total/596 pass/0 fail/19 skip。
- queued 畸形授权14项 RED；修复及相关定向127/127。独立审查前 `node scripts/ci.mjs` 在上述 preload 下：**629 total / 610 pass / 0 fail / 19 skip**；六闸退出0、故障矩阵21/21。
- 19 skip = 13 用户明确排除的真实 executor/network/resource 用例 +6 本机不可用 native DSH 用例。跳过不计通过。

原候选历史证据保持在 [原验证](VALIDATION-PARENT-STANDBY-2026-10-02.md)、[原独立复审](reviews/2026-10-02-parent-session-standby.md)；其503/497与8项关闭结论只针对原候选。新候选独立审查报告和精确 commit/tree 随工程交接单独提供，不沿用原全量认证。

## 整合独立审查后的最小修复

独立审查覆盖组合差异54路径与整合差异39路径；15个惰性套件196/196通过，另两项探针证实通知游标与默认适配器完成路径缺口。用户随后明确授权本机修复。完整原审查、RED/GREEN日志及独立关闭报告随工程交接提供；不是生产验收。

- 同一任务仍有 pending 通知时，共用 delivery_cursor 不前移；持久确认和游标检查在同一事务内。较早已接收但确认失败的消息在后续 tick/reload 可找到，不因较晚确认而重复投递。无新字段、迁移或投递协议。
- `Broker.execute` 的 deferred 登记在任何 command/owner、批准消费和费率预留前检查 observe 能力；RedteamMode 包装器同时检查底层 driver.observationOf。普通 fake/local 明确拒绝后台登记，原 CLI 同步接口保留，不添加新观察执行能力。queued/auth 测试夹具显式提供不产事件的惰性 observe，不修改 Fake/Local 产品实现。
- 9项新增回归：RED3pass/6fail，其中两个通知重放模式均复现[2,1]重复、四个 fake/local 入口未拒绝；修复后受影响9套件167/167通过。全量安全闸 **638 total / 619 pass / 0 fail / 19 skip**，六闸退出0，故障矩阵21/21。36工具及完整schema保留；README旧37工具文字已修正。

上述日志仅证明被测离线交错；真实 DSH 对话/持久宿主、实际执行器停止和生产重启仍未验证。原审查中更广的既有授权/执行能力、任意存储损坏与并发外部写入等未判断项保持开放，不以此修复认证。

## 后续顺序与验证限制

操作员先审阅 #164 与 #167 并在发布/ready/merge 权限明确后决定前置落点；再把本候选的整合差量应用到已确认的组合基线上，重新核对完整 tree、工具面、Accepted ADR、原代际授权和迁移9，执行离线门闸并独立审查。不要覆盖原 #163 或机械 rebase，不吸收 #165/#166 的能力。本记录不授权任何远端写入。

本 Mac 不是最终验收平台。真实 DSH/model 用户回合、云/服务器、生产文件系统、执行器终止、实际停止证明、容器围栏及完整通知体验均未验收。无候选远端 CI；#167 的远端 CI 不认证此新 tree。allowed_means、重派节奏/并发/计量/出口鲜度、真实适配器失败和冷恢复、外部 writer/撤销竞态等既有残留仍需独立裁决。一般操作自动化保持撤回，不在本候选内。
