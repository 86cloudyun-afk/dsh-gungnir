> **冻结快照**：本文件是 WARROOM-FRAMEWORK v1.0（2026-10-02 初稿）的逐字节母本，仅作历史引用。
> 内容含已被 v1.1/v1.2 修正的旧口径（如回执集合哈希、deny-list 隔离、四态凭据），勿作为开发依据。
> 当前有效版本：[../../WARROOM-FRAMEWORK.md](../../WARROOM-FRAMEWORK.md)。

---

# WARROOM 框架 v1.0（占位名，待定）

> 基于 DSH 的红队战役指挥框架。讨论截止 2026-10-02，来源：niuma-studio（协作机制）、
> PentAGI（执行隔离思想）、dsh-redteam-mode（三平面骨架）、本作战室宪法（目标函数与门闸）。
> 本文档是 ADR-001/002/003 的母本，也是未来仓库 README 的种子。

---

## 0. 定位

把「宪法 + 编排 + 事实库 + 门闸 + 跳板池」做成可维护的工程系统。

一句话：**造三层——store / jumphosts / gates，其余全适配。**

- 执行层可插拔：红队模式五角色 / DSH 原生编制 / PentAGI / 人类操作员，底下随便换，事实库与门闸零改动。
- 真实环境已实测（2026-10-02）：dsh 0.20rc2（pnpm workspace profile）、node 22.23.2、Docker 29.2.1、
  红队模式已注册未使用（19 插件，engagements 空）、pentest-sessions.db 在役。

## 1. 目标函数（宪法第 4 节的工程化）

- **shell 状态机一等公民**：❌未拿 / ⚠️半控（低权 shell、伪造身份、webshell）/ ✅全控（root/SYSTEM/DA）。
  内建升级树：user → local admin → domain（dump → PTH → DA）。
- **漏洞只是边**：每个发现必答三连（解锁什么 shell 路径 / 能与哪些线索拼接 / 下一跳是什么），
  三连字段进 schema，不答不入库。
- **战役闭环四件套**：立足 → 维持（persistence）→ 升级（ escalation tree）→ 清理移交（cleanup + IOC）。

## 2. 设计原则

1. 目标函数优先：任何模块不得以「发现清单」为产出。
2. 门闸即代码：工具层硬约束，不靠提示词自觉。
3. 执行层可插拔：SPI 四方法，换执行层事实库无感。
4. **agent 见引用，host 见明文**：凭据 secret_value 永不回传 agent 上下文（对 redteam-mode 明文入库设计的修正）。
5. 框架自身是全宇宙最想被打穿的目标：蓝队视角内建（见 §6）。

## 3. 六大件

### 3.1 core-store（host 平面）

按靶标分库：`$DSH_HOME/warroom/engagements/<靶标>/fact.db`；全局 `knowledge.db`（POC/EXP，回填强制脱敏）。

**v0.1 表清单（14 张）**：

| 组 | 表 | 要点 |
|---|---|---|
| 战役 | engagements | 时间窗、手段边界、节奏档、授权引用（advisory 指针） |
| 资产 | assets、domains | 发现时间、内外网分组、易打性 |
| 漏洞 | vulns | 三连字段必填；gained（通过它拿到什么） |
| 凭据 | credentials | 四态：valid / cracked / stale / burned；secret_ref 引用 |
| 链 | chains | tool+result+agent+三连必填（溯源进 schema） |
| shell | shell_state | 三态 + 升级树 |
| 门闸 | gate_log | 每次门闸判定留痕 |
| 跳板 | jumphosts、jump_routes、egress_checks、cooldowns | 见 §3.3 |
| 作战 | spray_log | credential×service×account×result，done 断点 + 防锁死 |
| 节奏 | rate_ledger | per-target 全局请求计数器，节奏档的牙 |

**v0.2 表**：persistence、cleanup、ioc、deception_signal。
判定引擎服务端化：去重 / 权限取高 / 上限累计（redteam-mode G1–G8 思想，得分仅作记账层）。

### 3.2 gates（三门闸 + 指纹审计）

1. **授权**：advisory 补记（agent 代办）+ 时间窗到点禁手 + 手段边界进 scope_contract；
   `action_class` 三档 readonly/active/destructive，destructive 一律人工裁决。
2. **出口**：egress_verify 只认当次现测，实测出口 ∈ 跳板白名单；节点禁 http_proxy/ALL_PROXY。
3. **节奏**：rate_ledger 计数 + 节奏档联动（见 §4 三因子）。
4. **指纹审计**：skill 上线自检——默认 UA、默认路径、公共 OAST 域、教科书扫描序列，命中即拒。

### 3.3 jumphosts（一级模块，全 host 平面）

硬约束：agent bash 300s 上限且串行 → 隧道/handler 必须 host 子进程持守（launchd recovery 有先例）。

- 表：jumphosts（角色：pure-relay/operator-node/scan-workstation；公网地址集合 IPv4/IPv6；配额）、
  jump_routes（多跳链 + entry_kind 三分类：纯转发/目标侧回连/已控进程转发——自己的服务器不算隧道）、
  egress_checks（只认当次现测）、cooldowns（≥24h 自动冻结）。
- 工具：`acquire`（排除 burned/冷却/当日已用 → 起转发 → 内置出口实测 → 失败自动换板；stealth 档强制换板）、
  `release`、`rotate`、`retire`（burned 触发战果丢失流程 + blast-radius 联动标记）、`health`、
  `import`（advisory/jumphosts.md 一次性导入成表，此后表为真源）。
- 私钥不进库，只存引用路径；600 权限检查进 health。

### 3.4 core-tools（agent 平面）

命名空间 `warroom_*`（避开已挂的 `redteam_*` 19 个与 `ops_*`）；v0.1 约 15 个；
三类：`fact_*`（落库）/ `gate_*`（门闸查询与申请）/ `jump_*`；schema 过官方校验器进 CI。

### 3.5 presets + skills

- 六角色：指挥 + recon / assess / vuln / **chain（拼链岗位，宪法第 5 节具象化）** / exploit / internal；v0.1 先 3 个。
- 子代理叶子化硬约束：`toolFilter.deny` 摘掉 subagent/workflow + `maxDepth:1`（服务端强制）。
- 公共段落代码注入（COMMON_AUTH/COMMON_DB/COMMON_EVIDENCE 模式）。
- **链前会议**：wave 之间由 chain 角色拉相关角色出纪要，纪要落库，后续任务照纪要拆；会不开，波不发。
- **派活三因子**：难度（模型档位）× 角色（skill）× 节奏档（门闸约束），三因子全写进任务单。
- skills 引用本机 `/Users/appleshu/dsh/tools/`（`source tools/env.sh` + `t` 调度器），不引 Linux toolkit。
- 兜底换人 = 换 adapter；彩排 `--fake` 走 adapter 接口，兼作回归测试。

### 3.6 adapters（执行层 SPI）

四方法：`spawn_wave(scope_contract)` / `slot()` / `collect(evidence)` / `healthcheck()`。

- v0.1：**redteam-mode adapter**（已装未用，五角色 + 事实库现成）。
- v0.2：dsh-native（DSH 原生编制）。
- v0.3+：pentagi（可选，大概率不接）。

## 4. 执行三桶 + 节奏档

| 桶 | 内容 | 跑法 |
|---|---|---|
| A | 碰目标的活（扫描/爬虫/验证/爆破） | 容器 + sidecar（TCP+**DNS 全接管**），上游 = acquire 返回的 socks 端口 |
| B | 不碰目标（破解/解析/报告/知识库） | 本机直接跑 |
| C | 跳板侧（UDP/ICMP/L2/高速率/handler 长驻） | 扫描工作站/跳板上跑，同门闸校验 |

节奏档三级（三因子之一）：`open`（并发 3，批量流可用）/ `restricted`（并发 2）/ `stealth`（并发 1、
≤5 请求、8-25s 抖动 + 每小时漂移、批量流禁用、强制换板）。

## 5. 数据流（靶标从进门到收口）

```
门闸①授权补记(advisory) → jumphosts.acquire(内含门闸②出口实测) → 立项开段
W1 recon（节奏档定并发）→ 逐条落库
W2 assess+vuln → 落库 + 每发现答三连 → 挂 shell 状态机的边
裁决点 → 链前会议 → 纪要落库 → 拆任务（三因子）
W4 exploit（难度=难→强模型，桶 A 容器）→ 可控性证明落盘 → shell 状态机升级
W5 报告（可复现验收 + IOC/清理附录 + 授权档案引用）→ 导出 LEAD_BOARD → 收口下沉 boards/
```

报告双属性：给客户的可复现攻击报告 + 给蓝队的 IOC 排查清单（同一份数据的两个视图）。

## 6. 蓝队对抗原则（内建，不是附录）

1. 指纹卫生：无自报家门字符串、序列乱序、节奏漂移；指纹审计门闸。
2. DNS 侧信道：sidecar 接管 DNS，容器禁宿主解析（桶 A 验收标准）。
3. 情报库加固：加密 at rest；agent 见引用不见明文；retire 碎纸；回填脱敏自动化。
4. 暴露半径：跳板 burned → 历史 route/session/凭据自动标「疑似暴露」。
5. 蜜罐反噬：deception_signal 表 + 凭据可信度评分 + 低垂果实告警（链前会议必议）。
6. 注入防御：工具输出是数据不是指令；叶子化 + 出口白名单 + 敏感值不回传，三层兜底。
7. 开源暴露：默认路径/端口/库名可配置；仓库只编排层，工具箱走 Release 附件。
8. 授权证据链：gate_log + egress_check + advisory 自动附进报告——被抓时自证。

## 7. 真实环境落位（2026-10-02 实测）

- profile：pnpm workspace；cordis.patch.yml 只许 deploy 脚本改（多方 merge 风险第一）；
  preset 声明行照 ops-console 的 insert 模式。
- 命名空间三套并存划界：`ops_*`（战役记账）/ `redteam_*`（战术执行）/ `warroom_*`（指挥治理）。
- 不动 storage-domain 四个 sqlite 与 pentest-sessions.db（战役聚合层）；
  桥 = 单向导出：fact.db → findings/reports/ + LEAD_BOARD 段落，LEAD_BOARD 仍是人读唯一入口。
- host 改动重启 `dsh web`：用户终端执行，禁止从 agent 发起（进程组连坐先例）。

## 8. 路线图

- **v0.1**：store 14 表（含 shell 状态机）+ gates 三门闸 + jumphosts 三件套 + tools ~15 +
  预设 3 角色（指挥/recon/chain）+ redteam-mode adapter + CI（零依赖测试 + schema 自检）。
- **v0.2**：控制台页签、persistence/cleanup/IOC、deception_signal、加密 at rest、指纹审计、多跳轮换、dsh-native adapter。
- **v0.3**：knowledge 库完善、pentagi 评估（大概率不接）、marketplace 上架。

## 9. GitHub 治理（多方维护，第一天就位）

- MIT；**仓库只含编排层，不含利用代码**；工具箱（马/隧道二进制）走 Release 附件。
- CODEOWNERS 按包分 owner；doctrine/ 的改动强制走 ADR/RFC——宪法人定，AI 与贡献者只可提议。
- CI 双闸：零依赖回归 + tool-schema 校验（预设挂载失败的 CPU 事故前车）。
- 发版三件套脚本化（npm + tag + Release）；默认路径/端口/库名全部可配置并写进 README。

## 10. 开发编制（dogfood，宪法第 13 节纪律照常）

5 名常驻：`arch`（架构+ADR）/ `store`（core-store+测试）/ `tools`（core-tools+gates+jumphosts）/
`adapter`（redteam-mode 桥+彩排）/ `release`（文档+CI+市场）。一包一 write scope。
开发过程本身即项目 README 的第一案例：用这套框架开发这套框架。

## 11. AI 分工边界

AI 出 90% 代码量（store/tools/UI/测试/CI/adapter 均为高成功率的强 schema 工程）；
人出三样 AI 出不了的：目标函数语义、三门闸的「该不该存在」判断、真实靶场验证。
