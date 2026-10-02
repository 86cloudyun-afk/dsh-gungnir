# 外部 CI 对接（把交付门禁接进你的流水线）

指挥层（本仓）已经能判断"这份交付物能不能交"（`checklist --strict` / `deliver`）。
本文给外部流水线的三种接法。

## 一、薄门禁（推荐）

```sh
node scripts/gate-check.mjs \
  --home "$WARROOM_HOME" --engagement "$ENG" --profile delivery
```

- 退出码：`0` 通过 / `1` 未通过（会打印未过项）/ `2` 用法或前置错误（家目录不存在等）
- `--profile delivery`（默认）：授权/水位/**报告可复现**/证据/审计/备份 必须齐全
- `--profile progress`：只盯"已做的东西有没有坏"（适合每次推送都跑的日常门禁）
- `--json` 给机器读（含 `blocked` 列表）

### GitHub Actions

```yaml
- name: 交付门禁
  run: node scripts/gate-check.mjs
  env:
    WARROOM_HOME: ${{ vars.WARROOM_HOME }}
    WARROOM_ENGAGEMENT: ${{ vars.ENG_ID }}
    GUNGNIR_GATE_PROFILE: progress
```

### GitLab CI

```yaml
gate:
  script:
    - node scripts/gate-check.mjs --json
  variables:
    WARROOM_HOME: "$CI_PROJECT_DIR/.warroom"
    WARROOM_ENGAGEMENT: "$ENG_ID"
```

## 二、一键交付后再判定

```sh
node bin/warroom.mjs deliver --engagement "$ENG"      # 产物 + 门禁一起出；不达标即非零退出
```

适合"构建产物"式的流水线（把交付包作为 artifact 上传，门禁不过就不上传）。

## 三、只校验某份报告还能不能复现

```sh
node scripts/verify-report.mjs "$REPORT_MD" --home "$WARROOM_HOME" --engagement "$ENG"
```

用于"报告已经发出去了，事后复核是否被后续动作污染"的场景。

## 注意（都写在这里，不靠记忆）

1. 门禁只依据**账本与文件**；人工项（控制面有效性 / IOC 附录）需要人确认
   （`checklist --confirm <shell|ioc> --by <署名> --note <结论>`），CI 里无法也不应替人确认。
2. `delivery` 口径要求近 7 天有备份——把 `warroom backup --keep 7` 放进你的定时任务，
   否则流水线会一直红（这条是设计如此：没有备份 = 不可交付）。
3. 家目录必须可写（报告/证据/备份都写在里面）；只读挂载会在门禁处失败。
