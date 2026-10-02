# 快速开始（CLI 全链路演练）

不依赖 DSH，只用仓库内的 CLI 走完一遍：**开工 → 派单 → 收执 → 状态 → 收口 → 报告 → 复现校验**。
以下输出为真实运行记录（2026-10-02，临时 home `/tmp/wr-demo`）。

```sh
# 0) 一步起好（可选）：建 home、写配置、导入跳板示例、建首个战役
node bin/warroom.mjs init --home /tmp/wr-demo --target 10.0.0.0/24 --rhythm open --with-jumphost-sample

export WARROOM_HOME=/tmp/wr-demo
ENG=$(node bin/warroom.mjs engage --target 10.0.0.0/24 --rhythm restricted --json | jq -r .engagement_id)
```

## 1. 开工：**开工指令即授权事件**

宿主（此例为 CLI）把开工指令冻结为结构化授权对象：范围、时间窗（默认 72h，起点回拨 5s 容忍时钟偏移）、
允许手段、动作上限、节奏档。

```json
{ "engagement_id": "eng_74967d47-…", "auth_version": 1, "targets": ["10.0.0.0/24"], "rhythm": "restricted" }
```

## 2. 派单：唯一副作用通道（四元组 + 请求 ⊆ 授权）

```sh
node bin/warroom.mjs exec --engagement "$ENG" --command-id demo-1 \
  --target 10.0.0.5 --class active --resources container --intent recon --json
```
```json
{ "command_id": "demo-1", "task_id": "wt_384a3032-…", "state": "running", "generation": "1:1:1" }
```

`command_id` 是幂等键：重复派发返回同一任务；丢回包时状态为 `unknown` 且可用 `lookup` 找回。

## 3. 收执与状态

```sh
node bin/warroom.mjs collect --engagement "$ENG" --task "$TID" --json   # → { accepted: true, seq: 1, … }
node bin/warroom.mjs status  --engagement "$ENG" --task "$TID" --json   # 账本态 + 运行态 + 资源清单探针
```

事实入库是**成员级幂等**：同一 `(adapter_instance, entity_type, source_id)` 只有最大 `revision_no` 生效；
重复回执不重复记账；晚到的旧修订只留历史行。

## 4. 过程中记三样东西

```sh
node bin/warroom.mjs shell proof  --engagement "$ENG" --proof "root@10.0.0.5"   # 历史最高证明（不改当前有效性）
node bin/warroom.mjs shell verify --engagement "$ENG" --validity likely         # 当前有效性只能由再验证推进
node bin/warroom.mjs spray record --engagement "$ENG" --credential-ref sec_demo \
  --service ssh --account root --result fail                                     # 喷洒断点；locked 后一律拒绝
node bin/warroom.mjs metrics --engagement "$ENG" --command-id demo-1 \
  --tokens-in 1200 --tokens-out 300 --wall-time-ms 45000 --verified-facts 2 --role recon
```

## 5. 收口：清单逐项证实

```sh
node bin/warroom.mjs cancel --engagement "$ENG" --task "$TID" --json
```
```json
{ "task_id": "wt_384a3032-…", "state": "confirmed_stopped",
  "manifest": [ { "id": "…-session", "kind": "session", "confirmed": true },
                { "id": "…-container", "kind": "container", "confirmed": true } ] }
```

**资源残留（主会话停、容器仍在）时状态必须是 `unresolved`**，不得假称已停止；
清除残留后再 cancel 才得 `confirmed_stopped`。

## 6. 报告：同一份证据的两个视图

```sh
node bin/warroom.mjs report --engagement "$ENG" --format both --json
```
```json
{ "paths": { "markdown": "…/report-1.md", "json": "…/report-1.json" },
  "watermark": { "seq": 1, "snapshot_id": "738eeba9…", "exported_at": "2026-10-02T00:02:38.691Z" },
  "evidence_digests": { "fact_members": "4f53cda1…" } }
```

- markdown：客户报告 = 蓝队 IOC 排查清单（自动聚合，带置信度与证据引用，逐项人工确认）
- json（`gungnir-report/1`）：机器可读，同水位、同摘要
- 两者都过 redactor：明文凭据只以引用形式出现

## 7. 复现校验

```sh
node bin/warroom.mjs verify-report "$MD" --engagement "$ENG" --json
# → reproducible: true（水位 + 证据摘要双一致）；导出后有新写入则如实报漂移，退出码 3
```

## 7.5 波次编排（可选，把上面第 2–4 步批量做掉）

```sh
cat > wave.json <<'JSON'
{ "title": "链前会议 #1", "notes": "先 recon 收面，再 chain 合成到 shell 的路径",
  "decisions": ["rhythm=restricted"],
  "tasks": [
    { "id": "recon-A", "role": "recon", "targets": ["10.0.0.5"], "intent": "recon" },
    { "id": "chain-B", "role": "chain", "targets": ["10.0.0.5"], "intent": "assess", "depends_on": ["recon-A"] }
  ] }
JSON
node bin/warroom.mjs wave --engagement "$ENG" --meeting wave.json --json
```

- **会不开，波不发**：纪要落库（`meetings` 表），并随报告一起交付（md「链前会议纪要」段 / json `meetings`）
- **先演练**：`--dry-run` 只出计划（依赖序 + 同层并行分组 + 会议预览），不派单不落库
- **波内无屏障但受节奏档约束**：独立任务立即并行、依赖满足即刻交接下游，同时在飞不超过档位上限
  （open=3 / restricted=2 / stealth=1）；名额占满先结项释放，波末未结项会如实报错
- **顺序实测**：`recon-A → chain-B`（B 依赖 A 时最后派发）
- 任务报终态后自动**结项**；成环/悬空依赖如实报错

## 7.8 其余运维子命令（一览）

```sh
node bin/warroom.mjs audit  --engagement "$ENG" [--decision deny] [--since <iso>] [--export <dir>]
node bin/warroom.mjs jumps  # 见下
node bin/warroom.mjs jump status  --engagement "$ENG"          # 跳板/租约/路由总览
node bin/warroom.mjs jump release --engagement "$ENG" --route <route_id>   # 幂等收口（拆隧道）
node bin/warroom.mjs sweep  --engagement "$ENG" [--timeout-min 30]         # 超时任务转 unknown（不自动重试）
node bin/warroom.mjs evidence --engagement "$ENG" --out <dir> [--target <名>] # 三段式 EVIDENCE_INDEX
node bin/warroom.mjs shell  proof|verify --engagement "$ENG" …
node bin/warroom.mjs spray  check|record --engagement "$ENG" --credential-ref … --service … --account …
node bin/warroom.mjs metrics --engagement "$ENG" [--command-id … --tokens-in … --role … --model-tier …]
node bin/warroom.mjs secret put|grant|status …
```

全部子命令都支持 `--json`；CLI 与工具/API 共用同一套门闸与事实库。

## 7.85 维护与安全动作

```sh
node bin/warroom.mjs backup                 # 备份全部库（一致性快照 + 完整性校验）
node bin/warroom.mjs maintain               # WAL 检查点 + 完整性自检
node bin/warroom.mjs secret rotate --confirm # 轮换秘密库密钥（旧密钥归档，旧秘密仍可解）
node bin/warroom.mjs doctor                 # 体检（含最近备份新鲜度）
```

- 出口验证（建议每次换出口/开工时跑）：
  ```sh
  node scripts/egress-check.mjs --home "$WARROOM_HOME" --engagement "$ENG" [--route <route_id>]
  node scripts/egress-check.mjs --home "$WARROOM_HOME" --engagement "$ENG" --self   # 操作节点自身出口
  ```
  通过后可用配置 `requireEgressCheck: true` 把"出网前必须有有效出口验证"变成硬门闸
- 备份不随密钥走：`backups/` 与 `secrets/` 需**分别**保管（见 [BACKUP.md](BACKUP.md)）
- 轮换前先备份整个 `secrets/`：历史密钥丢失 = 对应历史密文不可恢复
- stealth 档出网间隔在 **8~25s 抖动**并按小时漂移（不形成固定周期指纹）

## 7.9 家目录配置（可选）

```sh
node bin/warroom.mjs config init            # 生成 $WARROOM_HOME/warroom.json（示例默认值）
node bin/warroom.mjs config show            # 查看当前生效配置
```

默认值覆盖：`rhythm`（新战役默认节奏档）、`timeoutMin`（sweep 超时）、`adapterKind`、
`bridgeTimeoutMs`、`fenceImage`、`waveConcurrency`。**拼错字段会报错**，不会被静默忽略。

## 7.95 adapter 一致性自检（写自己的执行层时）

```sh
node scripts/conformance.mjs                       # 对内置 fake adapter 跑（回归）
node scripts/conformance.mjs --module ./my.mjs     # 对你自己的 adapter 跑（SPI rev2 契约）
```

契约要点、失败项含义见 [ADR-003](adr/ADR-003-adapter-lifecycle.md)。

## 7.99 全部子命令索引

```sh
# 起步与维护
init | doctor | config show|init | backup [--keep N] | restore --from <dir> [--apply] | maintain
# 战役
engage | exec | collect | status | cancel | revoke | wave [--dry-run] | sweep
# 情报与证据
fact | audit [--export] [--format csv] | report --format both | verify-report | evidence
# 出口与跳板
jump import|acquire|list|status|release|sweep | egress status|record
# 秘密与知识
secret put|grant|status|rotate | poc_search|poc_add|poc_use（工具）
# 执行层
conformance [--module <path>] | metrics | spray check|record
```

## 8. 下一步

- 一键体检：`node bin/warroom.mjs doctor`（环境/数据/秘密）
- 六道闸自检：`node --test` + `scripts/{validate-tool-schemas,check-preset,fault-matrix,self-review}.mjs`
- 挂载到 DSH：`node scripts/deploy-dsh.mjs --check`（见 [PRESET.md](PRESET.md)）
- 真实执行层：`node scripts/dsh-bridge-responder.mjs --root "$WARROOM_HOME/dsh-bridge"`（见 [DSH-BRIDGE-PROTOCOL.md](DSH-BRIDGE-PROTOCOL.md)）
