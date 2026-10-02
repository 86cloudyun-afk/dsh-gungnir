// 维护动作（备份 / WAL 检查点 / 完整性）：脚本、CLI、doctor 共用同一实现。
import { mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const IGNORE = new Set(['backups', 'node_modules', '.git']);

function findDbs(root, depth = 0, out = []) {
  if (depth > 4 || !existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (IGNORE.has(name)) continue;
      findDbs(p, depth + 1, out);
    } else if (name.endsWith('.db')) out.push(p);
  }
  return out;
}

/**
 * 备份家目录内全部 SQLite 库（一致性快照 + 完整性校验）。
 * @returns {{dest:string, ok:number, total:number, items:Array<{rel:string, verdict:string}>}}
 */
export function backupHome({ home, dest = null }) {
  const destRoot = dest ?? join(home, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(destRoot, { recursive: true });
  const dbs = findDbs(home);
  const items = [];
  for (const src of dbs) {
    const rel = relative(home, src);
    const target = join(destRoot, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    rmSync(target, { force: true });   // VACUUM INTO 要求目标不存在（可重复执行）
    const db = new DatabaseSync(src);
    try {
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      const chk = new DatabaseSync(target);
      const r = chk.prepare('PRAGMA integrity_check').get();
      const verdict = r?.integrity_check ?? Object.values(r ?? {})[0];
      chk.close();
      items.push({ rel, verdict: String(verdict), ok: verdict === 'ok' });
    } catch (e) {
      items.push({ rel, verdict: `error: ${e.message}`, ok: false });
    } finally {
      db.close();
    }
  }
  return { dest: destRoot, ok: items.filter((i) => i.ok).length, total: items.length, items };
}

/** 最近一次备份的时间（null = 从未备份）。 */
export function latestBackup({ home }) {
  const dir = join(home, 'backups');
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir)
    .map((name) => ({ name, path: join(dir, name) }))
    .filter((e) => { try { return statSync(e.path).isDirectory(); } catch { return false; } })
    .map((e) => ({ ...e, mtime: statSync(e.path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0] ?? null;
}

/** WAL 检查点 + 直连完整性自检（维护动作，可安全重复）。 */
export function checkpointHome({ home }) {
  const results = [];
  for (const db of findDbs(home)) {
    const conn = new DatabaseSync(db);
    try {
      conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const r = conn.prepare('PRAGMA integrity_check').get();
      const verdict = r?.integrity_check ?? Object.values(r ?? {})[0];
      results.push({ rel: relative(home, db), checkpoint: 'ok', integrity: String(verdict) });
    } finally {
      conn.close();
    }
  }
  return results;
}
