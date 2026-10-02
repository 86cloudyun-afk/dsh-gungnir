# 上游兼容风险（只读核对）

本地防御性调度分支固定在 `70a5a775127b77dd143ff9e39cd2cc0f94097255`。
主任务通知的上游 `0edf4f97543756539fe53fbbaad02eda471aa1af` 已通过 GitHub compare 只读核对；
没有 fetch/checkout/merge/rebase 其代码。

## 与本任务的重叠

- `presets/roles/commander.md`：上游增加会话 `warroom_engage`、跳板 import/acquire 自举动线，
  并声称四步均能由会话自己完成。本分支仅新增派单后待命/通知核账约定，不吸收该自举能力。
- `packages/warroom-tools/src/index.js`：上游增加模型可见 engage 与 jumps 动作；本分支不改该文件，
  wrapper 仍从固定基线读取既有 36 工具。后续若应用到上游，不能仅凭 wrapper 接口未变就判安全。
- `packages/warroom-plugin/src/dsh-entry.mjs`、`src/tools.js`：此次 compare 未显示上游直接修改；
  但它们消费的 TOOLS/allowlist 已变化，因此存在语义重叠与允许集扩大风险。
- `presets/warroom.preset.json`、生成工具文档/schema 以及 dsh-mount、toolpolicy、fail-closed、
  host-verified 测试：上游工具数/允许集已改变；本地 36 工具证据不能覆盖上游新增自授权边界。
- `docs/ACCEPTANCE.md`：双方涉及版本/验收行，后续应保留本分支离线证据和未运行项。

## 发布前必须由主任务裁决

需要变基时先报告上述 commander/允许集/测试冲突与安全影响，独立审查模型可见自授权来源。
不得为修复会话待命而接入或增强 engage、跳板导入、跳板取用或执行能力。
本地补丁只支持固定基线，未声称兼容上游新的权限面；仍禁止 push/PR/merge。

## 主任务后续安全提醒（仅登记）

主任务报告 #157 已外部合入 main `278e72d5f5b9b1c9ec6106dd6b3ab1da88c6fb68`（16:38:55），
其真实工具执行器含目标参数拼接 shell、出口例外等未修边界；#153 模型自建授权风险仍在。
本分支未取回、合入或执行该执行器，未独立裁决其实现；这里仅保留主任务的安全兼容提醒。
不能未经独立安全审查就整体变基／合入上述能力。发布权限、授权来源、shell 参数边界和出口门闸
必须由主任务另行裁决；本防御性调度补丁不扩大到这些上游动作。
