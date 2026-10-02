# 快速开始（CLI 全链路演练）

不依赖 DSH，只用仓库内的 CLI 走完一遍：**开工 → 派单 → 收执 → 状态 → 收口 → 报告 → 复现校验**。
以下输出为真实运行记录（2026-10-02，临时 home `/tmp/wr-demo`）。

```sh
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
- **波内无屏障**：独立任务立即并行；依赖满足即刻交接下游（实测顺序 `recon-A → chain-B`）
- 任务报终态后自动**结项**；成环/悬空依赖如实报错

## 8. 下一步

- 六道闸自检：`node --test` + `scripts/{validate-tool-schemas,check-preset,fault-matrix,self-review}.mjs`
- 挂载到 DSH：`node scripts/deploy-dsh.mjs --check`（见 [PRESET.md](PRESET.md)）
- 真实执行层：`node scripts/dsh-bridge-responder.mjs --root "$WARROOM_HOME/dsh-bridge"`（见 [DSH-BRIDGE-PROTOCOL.md](DSH-BRIDGE-PROTOCOL.md)）
