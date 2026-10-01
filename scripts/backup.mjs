#!/usr/bin/env node
// 备份：对 home 下所有 SQLite 库做一致性快照（VACUUM INTO），并校验完整性。
// 用法：node scripts/backup.mjs <warroom-home> [destDir]
// 加密数据对应密钥的恢复方式见 docs/BACKUP.md（密钥不随备份走，丢失不可恢复）。
import { mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const home = process.argv[2];
if (!home) {
  console.error('用法：node scripts/backup.mjs <warroom-home> [destDir]');
  process.exit(2);
}
const destRoot = process.argv[3] ?? join(home, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(destRoot, { recursive: true });

function findDbs(root) {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === 'backups' || name === 'node_modules') continue;
        walk(p, depth + 1);
      } else if (name.endsWith('.db')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

const dbs = existsSync(home) ? findDbs(home) : [];
if (dbs.length === 0) {
  console.error(`[✗] 未找到任何 .db（home=${home}）`);
  process.exit(1);
}

let ok = 0;
for (const src of dbs) {
  const rel = relative(home, src);
  const dest = join(destRoot, rel);
  mkdirSync(join(dest, '..'), { recursive: true });
  rmSync(dest, { force: true }); // VACUUM INTO 要求目标不存在（可重复执行）
  const db = new DatabaseSync(src);
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); // 一致性快照
    const chk = new DatabaseSync(dest);
    const r = chk.prepare('PRAGMA integrity_check').get();
    const verdict = r?.integrity_check ?? Object.values(r ?? {})[0];
    chk.close();
    if (verdict !== 'ok') throw new Error(`integrity_check=${verdict}`);
    ok += 1;
    console.log(`[✓] ${rel} → ${relative(destRoot, dest)} (integrity ok)`);
  } catch (e) {
    console.error(`[✗] ${rel}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
console.log(`[i] 备份完成 ${ok}/${dbs.length} → ${destRoot}`);
console.log('[i] 提醒：加密密钥不随备份走，需单独安全保存（docs/BACKUP.md）。');
