# 预设挂载（DSH 集成）

GUNGNIR 作为 DSH 插件挂载时，**隔离靠挂载层**（不是提示词）：战役会话的工具目录为允许清单，
通用执行/文件写/进程工具与 `redteam_*` / `ops_*` 直调不可达（ADR-001 D1）。

## 挂载步骤

1. 插件包接入 profile（pnpm workspace 或 `dsh plugin --profile web add`）。
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 增加 preset 声明行（**只由部署脚本改，不手编**）：

```yaml
- insert:
    - id: warroom-gungnir
      name: dsh-warroom-preset
      config:
        preset: <插件目录>/presets/warroom.preset.json
        rolesDir: <插件目录>/presets/roles
        home: !!js dshHomePath('warroom')
```

3. 重启 `dsh web`（host 平面变更必须重启；client 侧改动才走热更）。
4. 新建会话选择预设「红队指挥（GUNGNIR）」，直接发**开工指令**（靶标 + 范围）：
   宿主截获该指令并冻结结构化授权对象（开工指令即授权事件，ADR-001 D3）。

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

命令行校验：`node scripts/check-preset.mjs`（CI 三闸的一部分）。
