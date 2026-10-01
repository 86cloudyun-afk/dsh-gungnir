# 备份与恢复

## 备份

```sh
node scripts/backup.mjs "$DSH_HOME/warroom"           # 默认落到 <home>/backups/<UTC 时间戳>/
node scripts/backup.mjs "$DSH_HOME/warroom" /path/to/dest
```

- 逐库使用 SQLite `VACUUM INTO` 生成**一致性快照**（对 WAL 活跃库安全），并逐份 `PRAGMA integrity_check`。
- 覆盖：`global.db`（跳板/租约/op_log/命令队列）+ `engagements/<id>/fact.db`（战役事实）。
- 任一份校验失败即非零退出，不掩盖。

## 恢复

1. 停写：确保没有 host 服务在写目标库（否则以退出码/锁报错提示）。
2. 用备份文件覆盖目标路径（先自行留存现状副本）：

```sh
cp -n "$HOME/.warroom-backup-$(date +%s)/global.db" "$DSH_HOME/warroom/global.db"
```

3. 打开一次即触发迁移自检（`runMigrations`）：库版本高于代码 → 拒绝打开并报
   `E_SCHEMA_NEWER_THAN_CODE`，此时应升级代码而不是降级库。

## 加密密钥（v0.1 起适用）

- 秘密存储使用 at-rest 加密，密钥位于 `$DSH_HOME/warroom/secrets/`（权限 700/600），
  **不随备份走**。
- 因此：备份 + 密钥 = 可恢复；只有备份没有密钥 = 秘密字段不可恢复（其余事实数据可恢复）。
- 密钥备份请单独做：离线介质或密码管理器，不要与数据库备份放同一位置。
