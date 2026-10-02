# 事故复盘：GUNGNIR 会话"四线全阻塞、目标零流量"（2026-10-02）

## 现象
会话在 GUNGNIR 预设下开了 W30、派了四条线（L1 测绘 / L2 攻击面 / L3 认证面 / L5 ops），
四条线**全部 blocked**、**目标零流量**，阻塞点集中在三处：授权对象、出口路由、工具面。

## 根因（三层）

1. **工具面缺"自举"与"执行"两半**（直接原因）
   - 会话工具面 = `warroom_*` + `todo_write` + `ask_user_question`，**无 bash/文件/HTTP**（ADR-001 D1 的设计后果，隔离靠挂载层）。
   - `warroom_jumps` 的动作枚举当时只有 `status|release|sweep|sweep_routes|heartbeat`，
     **没有 `import` / `acquire`**（CLI 有，工具面没有）→ 会话永远无法自己拿到出口。
   - 工具面没有创建战役的入口 → 授权对象无从冻结。
2. **环境未预置**（触发条件）：`engagements` 表零行（冻结从未发生）；跳板链路死在第 2 层
   （节点侧无 SOCKS 监听、无隧道进程），本机直连出口不是合法出口。
3. **代码缺陷**（放大了故障可读性）
   - `preflight` 在战役不存在时抛原始 `TypeError: Cannot read properties of undefined (reading 'auth_version')`，
     使用者看不出"该先冻结授权"。
   - `adapterKind` 默认 `fake` → 即便派单成功，回执也只是**占位事实**。
   - `docs/PRESET.md` 曾宣称"宿主截获开工指令并冻结授权对象"——**实现并不存在**（文档超出实现）。

## 修复（本次）

| 修复 | 位置 | 回归 |
|---|---|---|
| 战役不存在 → 可读结论 + 自举指引（fail-closed 语义不变） | `packages/warroom-core/src/preflight.js` | `test/preflight.test.js` |
| `warroom_jumps` 增 `import` / `acquire`（会话可自建出口） | `packages/warroom-tools/src/index.js` | `test/bootstrap-verbs.test.js` |
| 新增 `warroom_engage`（把操作员开工指令冻结为结构化授权） | 同上 + `presets/warroom.preset.json` | 同上 + `test/preset.test.js` |
| 角色动线：开工自举四步写进指挥官提示词 | `presets/roles/commander.md` | `scripts/check-preset.mjs` |
| 文档与实现对齐（去掉"宿主截获"的错误宣称） | `docs/PRESET.md` | 自审闸 |
| 部署脚本显式 `--adapter`，fake 时明确警告 | `scripts/deploy-dsh.mjs` | `test/cli-deploy.test.js` |

## 现在的自举链路（会话可独立完成，无需外部帮忙）

```
warroom_engage(targets, user_message_id)      # 冻结授权 → auth_version/auth_hash
→ warroom_jumps(action=import, hosts=[...])   # 登记跳板
→ warroom_jumps(action=acquire, target=...)   # 拿出口路由
→ warroom_egress_check(action=record, …)      # 出口现测并记录
→ warroom_preflight 不再 blocked → wave / execute 派单
```

`test/bootstrap-verbs.test.js` 把这条链路钉死：**只用工具面**从零走到成功派单，且缺任一前置必须明确报错。

## 仍未闭环（环境侧，不是代码）

- 跳板链路第 2 层（节点 → 跳板）需操作员侧恢复；控制台映射可由 `tools/jumpool.sh up` 重建，
  但节点侧无 SOCKS 监听/隧道进程时出口恒为 DEAD（不得连续重试，SOP 有明令）。
- 真执行通道需显式配置：`--adapter bridge`（或 local）+ 执行器命令，见 `docs/DSH-EXECUTOR-IMPL.md`。
