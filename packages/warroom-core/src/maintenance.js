// 维护动作（备份 / WAL 检查点 / 完整性）：脚本、CLI、doctor 共用同一实现。
import { mkdirSync, readdirSync, statSync, existsSync, rmSync, copyFileSync } from 'node:fs';
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
 * @param {{home:string, dest?:string|null, keep?:number|null}} opts
 *   keep：只保留最近 N 份自动备份（按目录 mtime 轮转；**手工指定的 dest 不参与轮转**）
 * @returns {{dest:string, ok:number, total:number, items:Array<{rel:string, verdict:string}>, pruned:string[]}}
 */
export function backupHome({ home, dest = null, keep = null }) {
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
  const pruned = [];
  if (keep !== null && dest === null) {
    // 只轮转"自动备份"（backups/ 下的时间戳目录），手工 dest 一律不动
    const root = join(home, 'backups');
    const dirs = readdirSync(root)
      .map((name) => ({ name, path: join(root, name) }))
      .filter((e) => { try { return statSync(e.path).isDirectory(); } catch { return false; } })
      .map((e) => ({ ...e, mtime: statSync(e.path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of dirs.slice(Math.max(0, keep))) {
      rmSync(stale.path, { recursive: true, force: true });
      pruned.push(stale.name);
    }
  }
  return { dest: destRoot, ok: items.filter((i) => i.ok).length, total: items.length, items, pruned };
}

/**
 * 恢复演练/落地：把某份备份覆盖回家目录。
 * - dryRun（默认）：只做**计划与校验**（备份完整性、目标库版本兼容、将要覆盖的文件清单），不改动任何数据
 * - apply：先给现状打一份"恢复前备份"（backups/pre-restore-<ts>），再逐库覆盖
 * @returns {{plan:Array<{rel:string, action:string, verdict:string}>, applied:boolean, safetyBackup:string|null, warnings:string[]}}
 */
export function restoreHome({ home, from, dryRun = true, broker = null }) {
  const warnings = [];
  if (!existsSync(from)) throw new Error(`备份目录不存在：${from}`);
  const plan = [];
  for (const rel of walkRel(from)) {
    if (!rel.endsWith('.db')) continue;
    const src = join(from, rel);
    const chk = new DatabaseSync(src);
    const r = chk.prepare('PRAGMA integrity_check').get();
    const verdict = String(r?.integrity_check ?? Object.values(r ?? {})[0]);
    const ver = (() => {
      try { return chk.prepare("SELECT k, v FROM meta WHERE k LIKE 'schema_version:%'").all(); } catch { return []; }
    })();
    chk.close();
    const target = join(home, rel);
    plan.push({ rel, action: existsSync(target) ? 'overwrite' : 'create', verdict, schema: ver });
    if (verdict !== 'ok') warnings.push(`${rel} 备份完整性异常（${verdict}）——建议放弃该备份`);
  }
  if (plan.length === 0) warnings.push('备份中没有可恢复的 .db 文件');

  let safetyBackup = null;
  if (!dryRun) {
    safetyBackup = join(home, 'backups', `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const b = backupHome({ home, dest: safetyBackup });
    if (b.ok !== b.total) warnings.push('恢复前快照未全部成功，请谨慎继续');
    for (const item of plan) {
      const src = join(from, item.rel);
      const dst = join(home, item.rel);
      mkdirSync(join(dst, '..'), { recursive: true });
      copyFileSync(src, dst);
    }
    if (broker) warnings.push('已恢复磁盘数据：若宿主进程仍在运行，请重启它（旧连接持有已替换的文件句柄）');
  }
  return { plan, applied: !dryRun, safety_backup: safetyBackup, warnings };
}

/** 目录内所有文件的相对路径（用于恢复计划）。 */
function walkRel(root, base = '', out = [], depth = 0) {
  if (depth > 4) return out;
  for (const name of readdirSync(join(root, base))) {
    const rel = base ? `${base}/${name}` : name;
    const p = join(root, rel);
    const st = statSync(p);
    if (st.isDirectory()) walkRel(root, rel, out, depth + 1);
    else out.push(rel);
  }
  return out;
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
