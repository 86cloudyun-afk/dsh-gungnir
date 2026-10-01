# CHANGELOG

## Unreleased

### Added
- 节奏闸（ADR-002 D10 / 框架 §4）：并发上限（open 3 / restricted 2 / stealth 1）、
  wire_requests 滚动预算（100000 / 1000 / 100）、stealth 档 8s 最小间隔（响应带 retry_after_ms）；
  按规格修正：restricted **无**最小间隔（此前的 1s 限制为过度实现）
- 人工批准注册表：destructive 必须携带已登记令牌（跨战役/过期/重复使用分别拒绝），
  审批留痕 issued_by / used_by_command；schema v3 迁移（global 专属）
- 授权窗口 5s 时钟偏移容差
- 秘密边界（ADR-001 D7）：AES-256-GCM at-rest 加密、密钥文件 600/目录 700、
  权限化 resolve（secret × 任务 × 用途 × TTL）、全出口脱敏（gate_log / collect / 错误路径 /
  形态正则：token、私钥、kv 口令）
- schema v2 迁移（global 库专属）：secret_store / secret_grants；迁移按 labels 过滤
- 工具：warroom_secret_put / warroom_secret_grant / warroom_secret_status（无 resolve 工具——解析仅 host 可用）
- CI 三闸之一：工具 schema 严格校验器（DSH 挂载会因非法 schema 整组失败）
- GitHub Actions：验收套件 + schema 校验（node 22.x）

## v0.1.0-alpha.1 — 2026-10-02

### Added
- `packages/shared-types`（批次 0 alpha 冻结）：任务状态机与合法迁移表、错误码枚举、
  四元组/契约/回执校验、source_key/generation 构造器
- `packages/warroom-core`：
  - FactStore：成员级幂等入库（source_key + revision_no）、seq 与水位快照、计量双计数器
  - Broker：四元组门闸、命令队列（派发幂等）、撤销级联、取消与资源清单逐项证实、代际隔离
  - JumphostManager：op_log 先行补偿、TTL 实测证实、quarantined 隔离态
  - FakeAdapter：SPI rev2 参考实现 + 故障注入（丢回包 / 资源残留）
- 验收负样本套件 20 例全绿（框架 §8 清单可离线验证项）
- 规格与三份 ADR 入仓（docs/），README 治理入口
