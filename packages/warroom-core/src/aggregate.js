// 聚合边界（框架 §7）：`pentest-sessions.db` **只做聚合**——我们只读它，永不写。
// 产出"合并视图"：DSH 控制台侧聚合库（若有） + 本框架各战役事实库 → 一张跨会话战果表。
// 铁律：聚合库以 `mode=ro` 打开；任何写入尝试都会抛错（测试守着这条）。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 只读打开聚合库（不存在则返回 null）。 */
export function openSessionsDb(path) {
  if (!path || !existsSync(path)) return null;
  return new DatabaseSync(path, { readOnly: true });
}

/** 读取 DSH 侧聚合库的战果表（容错：表不存在即视为空）。 */
export function readSessionAggregate(db) {
  if (!db) return { facts: 0, findings: 0, assets: 0, sessions: 0, available: false };
  const count = (table) => {
    try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { return 0; }
  };
  return {
    available: true,
    facts: count('facts'), findings: count('findings'), assets: count('assets'), sessions: count('sessions'),
  };
}

/**
 * 合并视图：本框架各战役 + DSH 聚合库。
 * @param {{home:string, sessionsDbPath?:string|null}} p
 */
export function aggregateView({ home, sessionsDbPath = null }) {
  const engDir = join(home, 'engagements');
  const engagements = [];
  if (existsSync(engDir)) {
    for (const id of readdirSync(engDir)) {
      const dbPath = join(engDir, id, 'fact.db');
      if (!existsSync(dbPath)) continue;
      const db = new DatabaseSync(dbPath, { readOnly: true });   // 本框架数据也只读，聚合不具副作用
      try {
        const byType = db.prepare('SELECT entity_type, COUNT(*) AS n FROM fact_members WHERE active = 1 GROUP BY entity_type ORDER BY n DESC').all();
        const row = db.prepare('SELECT auth_version, rhythm, created_at FROM engagements WHERE id = ?').get(id);
        const shell = (() => {
          try { return db.prepare("SELECT detail FROM gate_log WHERE decision = 'shell_proof' ORDER BY id DESC LIMIT 1").get()?.detail ?? null; }
          catch { return null; }
        })();
        engagements.push({
          engagement_id: id, auth_version: row?.auth_version ?? null, rhythm: row?.rhythm ?? null,
          created_at: row?.created_at ?? null,
          facts_total: byType.reduce((a, b) => a + b.n, 0),
          by_type: byType, shell_proof: shell,
        });
      } catch (e) {
        engagements.push({ engagement_id: id, error: e.message });
      } finally {
        db.close();
      }
    }
  }

  const sessions = openSessionsDb(sessionsDbPath);
  let dsh = { available: false };
  try { dsh = readSessionAggregate(sessions); } finally { sessions?.close(); }

  return {
    schema: 'gungnir-aggregate/1',
    generated_at: new Date().toISOString(),
    home,
    engagements,
    totals: {
      engagements: engagements.length,
      facts: engagements.reduce((a, e) => a + (e.facts_total ?? 0), 0),
      shells: engagements.filter((e) => (e.shell_proof ?? '').includes('shell')).length,
    },
    dsh_sessions: dsh,
    boundary: '本视图只读：本框架各战役库以 readOnly 打开；DSH 聚合库（pentest-sessions.db）亦只读，永不写入',
  };
}
