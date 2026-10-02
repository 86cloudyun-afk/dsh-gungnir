# 贡献指南（多方维护）

本项目是 DSH 红队战役指挥框架（GUNGNIR）。**仓库只含编排层，不含任何漏洞利用代码**；
提交前请确认内容属于编排/治理/测试范畴。

## 硬性门槛：提交前必须六闸全绿

```sh
node --test                           # 验收套件
node scripts/validate-tool-schemas.mjs # 工具 schema（DSH 挂载硬要求）
node scripts/check-preset.mjs          # 预设允许清单闭合（新工具必须显式进 allow）
node scripts/fault-matrix.mjs          # 故障注入矩阵
node scripts/gen-docs.mjs --check      # 工具文档未漂移（改了工具就跑 --write）
node scripts/self-review.mjs           # 秘密/链接/验收引用/代码卫生
```

> **一条命令跑完全部**：`npm run ci`（= `node scripts/ci.mjs`）。它顺序跑六道闸，
> 打印逐闸退出码与汇总结论，任一失败即非零退出。
> **不许用管道里的 grep 退出码代替 gate 结论**——本项目踩过这个坑（grep 命中失败行仍返回 0，
> 见 `docs/MERGE-REVIEW-*.md`）。现该坑已由工具封堵：判定只在 `ci.mjs` 里做。
> 只想跑其中几道：`node scripts/ci.mjs --only test,self-review`；列闸门：`--list`；
> 只看汇总：`node scripts/ci.mjs --quiet`——**不要用 `| tail` 看汇总**，管道会把退出码吃掉
> （本项目两次踩这个坑，第二次正是"用 `npm run ci | tail -4` 掩盖了失败"）。

## PR 规范

1. **一个 PR 一件事**：功能/修复/文档分开；附带测试与验收引用。
2. **规格变更走 ADR**：`docs/adr/` 一经 Accepted 不可变；修正以新 rev 重写并留修订记录，
   doctrine 改动走 RFC（在 issue 里先讨论）。
3. **验收表同步**：涉及验收项的改动，更新 `docs/ACCEPTANCE.md` 对应行（状态 + 证据命令）。
4. **不许静默跳过**：测试里禁止 `.only` / `skip`；探针/环境不可用时如实 `SKIP` 并说明原因
   （例如围栏验收在无 docker daemon 的机器上输出 SKIP，而非假装通过）。
5. **秘密零容忍**：任何真实凭据、内网地址、个人基础设施痕迹都不得进仓库（自审闸会拦；
   测试夹具用官方示例串并标 `synthetic-example`）。

## 审查与合并

- 外部贡献 PR 的处理流程（本项目已实践）：
  1. 拉分支到本地工作树 → 跑该分支全量测试；
  2. 人工读 diff（安全/契约边界类改动优先）；
  3. `rebase` 到最新 `main`，冲突取并集（双方测试都保留）；
  4. 合并并在 `docs/MERGE-REVIEW-*.md` 留记录。
- 合并批次策略：**累积 ≥8 条 PR 做一次合并审查**，按序合并、打 tag、写审查记录。

## 写作用域（避免并行改动打架）

| 目录 | 所有者 | 说明 |
|---|---|---|
| `packages/shared-types` | arch | 契约冻结区，破坏性变更必须升版本并广播 |
| `packages/warroom-core` | store | 事实库/门闸/跳板/报告/探针 |
| `packages/warroom-tools` + `presets/` | tools | 工具与允许清单（改工具必须同步文档） |
| `packages/warroom-plugin` + `scripts/dsh-bridge-responder.mjs` | adapter | 执行层集成 |
| `docs/` + `.github/` + `scripts/`（发布相关） | release | 规格、治理、CI |
