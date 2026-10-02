# 预设挂载（DSH 集成）

GUNGNIR 作为 DSH 插件挂载时，**隔离靠挂载层**（不是提示词）：战役会话的工具目录为允许清单，
通用执行/文件写/进程工具与 `redteam_*` / `ops_*` 直调不可达（ADR-001 D1）。

## 挂载步骤（真机契约：dsh 0.2.0-rc.2 实测）

**预设 = profile patch 里一行 `@deepseek-ai/dsh-agent-preset`**，其 `config.plugins` 是子插件清单。
**只有被挂载的插件才存在**——这就是允许清单的实现方式（不需要提示词层配合，也不需要宿主支持 deny 通配）。

```sh
node scripts/deploy-dsh.mjs --check     # 环境/文件/声明与实现一致性/幂等性
node scripts/deploy-dsh.mjs --print     # 打印将写入的 YAML（真实契约）
node scripts/deploy-dsh.mjs --verify    # dsh --dump-config 验证装配（**不需要重启**）
node scripts/deploy-dsh.mjs --apply     # 备份后写入 profile patch（幂等；patch 层只由脚本改）
```

生成的声明形如：

```yaml
- insert:
    - id: preset-warroom-gungnir
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: warroom-gungnir
        name: 红队指挥（GUNGNIR）
        description: …工具目录为允许清单：只有 warroom_* 可见，无 bash/文件写/进程/委派工具。
        plugins:
          - id: persona                     # 角色文本在**运行期**从 presets/roles/<role>.md 读入
            name: '@deepseek-ai/dsh-persona'
          - id: agent-instructions
          - id: warroom-gungnir             # 本仓挂载入口（注册 36 个 warroom_* 工具）
            name: /abs/path/packages/warroom-plugin/src/dsh-entry.mjs
          - id: tool-todo
          - id: tool-ask-user
```

> 角色文本为什么用 `!!js "…readFileSync(…)"` 而不是 YAML 块标量：角色 markdown 有多级缩进，
> 折叠标量（`>-`）会因此变成非法 YAML（实测报 `bad indentation of a mapping entry`）。
> 表达式在 loader 作用域求值，`process.getBuiltinModule('node:fs')` 可用。

**生效**：host 平面变更需重启 `dsh web`（在操作员自己的终端执行；agent 不重启承载会话的 web 进程）。
重启后新建会话选预设「红队指挥（GUNGNIR）」，直接发**开工指令**（靶标 + 范围）：
宿主截获该指令并冻结结构化授权对象（开工指令即授权事件，ADR-001 D3）。

## 预设"消失"的两个真机陷阱（都踩过）

| 症状 | 根因 | 处置 |
|---|---|---|
| 下拉里没有该预设，宿主日志报 `Duplicate agent preset: <id>` | patch **语法坑**：注释掉 `- insert:` 的唯一子项却没注释父行 → 悬空 `- insert:` → 解析错误连带预设注册失败 | 剪除脚本已修（父行连带注释）+ 回归钉住 |
| 注册表里有该预设，但带 `broken:"Preset services require isolate realms: warroom"`，客户端**不让你选** | 预设作用域内 `ctx.provide('warroom', …)`：宿主审计要求"预设提供的服务必须声明 isolate realm" | 挂载入口**默认不再 provide**（工具注册已够用）；确需服务时在预设行声明 isolate realm 并开 `provideService: true` |

自查命令（不用重启就能看客户端真正拿到的列表）：

```js
// 以 --patch 叠加一个只读探针，await registry.list() 打印
const value = await ctx.agentPresets.list();
console.error(JSON.stringify(value));
```

## 真机验证记录（2026-10-02，dsh 0.2.0-rc.2）

| 验证项 | 手段 | 结果 |
|---|---|---|
| 挂载层硬门槛 | 用**宿主自己的**校验器 `assertSupportedJsonSchema`/`assertObjectJsonSchema` 校验 36 个 `parameters` | ✅ 36/36 通过（`test/dsh-mount.test.js`） |
| 装配（不重启） | `dsh --profile web --dump-config [--patch <overlay>]` | ✅ 预设行与子插件清单出现在装配树里 |
| 注册（真实进程） | `dsh --profile headless --patch <overlay>` 让模型列出可用工具 | ✅ **36 个 `warroom_*` 全部可见**；关闭内核工具行后 `bash/write/edit/subagent` 均不存在 |
| 执行（真实进程） | 让会话调用 `warroom_poc_add` → `warroom_poc_search` | ✅ 登记入库、检索返回 `count=1`；库侧用 CLI 复核一致 |
| 作用域收窄 `restrict` | 在 context 级调用 | ⛔ 宿主拒绝："a context-global restriction would mask every agent"。**主保证=挂载构成**；restrict 仅在 agent 作用域且显式开启时尝试，失败记状态不抛错 |

> `dsh-headless` 明确不支持预设会话（"the one-shot runner does not compose"），因此预设的
> **最终点验**要在重启后的 web 会话里做：确认工具面板只有 `warroom_*`，没有 `bash/write/edit`。

## 允许清单的语义（`presets/warroom.preset.json`）

| 字段 | 含义 |
|---|---|
| `toolPolicy.mode` | `allowlist`：只有 `allow` 里列出的工具在会话内可见 |
| `toolPolicy.deny` | 显式拒绝（通配符按前缀匹配）；`bash`/`write`/`edit`/`subagent`/`workflow`/`redteam_*`/`ops_*` |
| `subagent.maxDepth` | `1`：子代理是叶子，不能再往下委派（与拒绝清单双重保险） |

> 新增工具必须**同时**进入 `allow`，否则智能体看不到它——这是刻意的摩擦。

## 三个角色的文件

| 角色 | 文件 | 职责 |
|---|---|---|
| commander | `presets/roles/commander.md` | 计划 / 派单 / 核对落库 / 汇报；不执行 |
| recon | `presets/roles/recon.md` | 攻击面收集与落库（产出"边"） |
| chain | `presets/roles/chain.md` | 链前会议主持 + 攻击路径合成 + 排序 |

> 运行时：`warroom wave --engagement <id> --meeting <wave.json>` 把「会议纪要 → 依赖派单 →
> 立即交接 → 事实入库 → 结项」一条命令跑完（框架 §3.5）。

命令行校验：`node scripts/check-preset.mjs`（CI 三闸的一部分）。
