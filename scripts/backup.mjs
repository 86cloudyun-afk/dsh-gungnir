#!/usr/bin/env node
// 备份：对 home 下所有 SQLite 库做一致性快照（VACUUM INTO），并校验完整性。
// 用法：node scripts/backup.mjs <warroom-home> [destDir]
// 加密数据对应密钥的恢复方式见 docs/BACKUP.md（密钥不随备份走，丢失不可恢复）。
import { mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { backupHome } from '../packages/warroom-core/src/maintenance.js';

const home = process.argv[2];
if (!home) {
  console.error('用法：node scripts/backup.mjs <warroom-home> [destDir]');
  process.exit(2);
}
const destRoot = process.argv[3] ?? null;
const r = backupHome({ home, dest: destRoot });
for (const item of r.items) {
  console.log(`${item.ok ? '[✓]' : '[✗]'} ${item.rel} (integrity ${item.verdict})`);
}
console.log(`[i] 备份完成 ${r.ok}/${r.total} → ${r.dest}`);
if (r.ok !== r.total) process.exitCode = 1;
console.log('[i] 提醒：加密密钥不随备份走，需单独安全保存（docs/BACKUP.md）。');
