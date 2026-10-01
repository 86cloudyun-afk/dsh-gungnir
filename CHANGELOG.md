# CHANGELOG

## Unreleased

### Added
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
