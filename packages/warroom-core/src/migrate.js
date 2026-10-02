// schema 版本与迁移框架（框架 §10 数据治理）。
// 规则：
//   · 每个库（label）有自己的目标版本 = 该 label 适用迁移的最大版本号（无迁移则为 1）；
//   · 库版本 > 代码 SCHEMA_VERSION → 拒绝打开（防降级写坏数据）；
//   · 迁移按版本号升序执行（数组顺序无关）。
import { SCHEMA_VERSION } from './version.js';

const META_KEY = 'schema_version';
export const ERR_SCHEMA_NEWER = 'E_SCHEMA_NEWER_THAN_CODE';

/** 迁移清单：version = 目标版本，labels 限定作用的库，up(db) 执行该步变更。 */
export const MIGRATIONS = [
  {
    version: 2,
    labels: ['global'],
    up(db) {
      // v2：秘密边界（ADR-001 D7）——加密存储 + 授权表
      db.exec(`
        CREATE TABLE IF NOT EXISTS secret_store (
          secret_ref TEXT PRIMARY KEY, label TEXT NOT NULL,
          ciphertext BLOB NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS secret_grants (
          grant_id TEXT PRIMARY KEY, secret_ref TEXT NOT NULL, engagement_id TEXT,
          task_id TEXT NOT NULL, purpose TEXT NOT NULL, expires_at TEXT NOT NULL, ts TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_secret_grants_lookup
          ON secret_grants(secret_ref, task_id, purpose, expires_at);
      `);
    },
  },
  {
    version: 3,
    labels: ['global'],
    up(db) {
      // v3：人工裁决批准（destructive 单次令牌）
      db.exec(`
        CREATE TABLE IF NOT EXISTS approvals (
          approval_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, action_class TEXT NOT NULL,
          reason TEXT, issued_by TEXT, expires_at TEXT NOT NULL, single_use INTEGER NOT NULL DEFAULT 1,
          used_by_command TEXT, ts TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 4,
    labels: ['global'],
    up(db) {
      // v4：任务执行尝试序号（generation 的第三段）
      const cols = db.prepare('PRAGMA table_info(command_queue)').all().map((c) => c.name);
      if (!cols.includes('attempt')) {
        db.exec('ALTER TABLE command_queue ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1');
      }
    },
  },
  {
    version: 5,
    labels: ['global'],
    up(db) {
      // v5：任务级效率遥测（ADR-002 D10）——预算不是门闸，效率才是目标
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_metrics (
          command_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, task_id TEXT,
          role TEXT, model_tier TEXT,
          tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
          wall_time_ms INTEGER NOT NULL DEFAULT 0, verified_facts INTEGER NOT NULL DEFAULT 0,
          ts TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 6,
    labels: ['fact'],
    up(db) {
      // v6：链前会议纪要（框架 §3.5 运行时语义：会不开，波不发）
      db.exec(`
        CREATE TABLE IF NOT EXISTS meetings (
          meeting_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, title TEXT NOT NULL,
          notes TEXT NOT NULL, decisions TEXT, created_at TEXT NOT NULL
        );
      `);
    },
  },
];

/** 某 label 在**本代码版本**下的目标 schema 版本。 */
export function targetVersionFor(label) {
  const versions = MIGRATIONS.filter((m) => !m.labels || m.labels.includes(label)).map((m) => m.version);
  return versions.length ? Math.max(...versions) : 1;
}

function readVersion(db, label) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(`${META_KEY}:${label}`);
  return row ? Number(row.v) : null;
}

function writeVersion(db, label, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(`${META_KEY}:${label}`, String(v));
}

/**
 * 运行迁移：幂等。库版本高于代码支持版本时抛错（不静默降级）。
 * @returns {{from:number|null, to:number, applied:number[]}}
 */
export function runMigrations(db, label) {
  const target = targetVersionFor(label);
  const current = readVersion(db, label);
  if (current !== null && current > SCHEMA_VERSION) {
    const e = new Error(`schema_version ${current} > code ${SCHEMA_VERSION}（${label}）；请升级代码而非降级库`);
    e.code = ERR_SCHEMA_NEWER;
    throw e;
  }
  const applied = [];
  if (current === null) {
    writeVersion(db, label, target);
    return { from: null, to: target, applied };
  }
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of ordered) {
    if (m.version > current && m.version <= target && (!m.labels || m.labels.includes(label))) {
      db.exec('BEGIN IMMEDIATE');
      try {
        m.up(db);
        writeVersion(db, label, m.version);
        db.exec('COMMIT');
        applied.push(m.version);
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  }
  if (readVersion(db, label) !== target) writeVersion(db, label, target);
  return { from: current, to: target, applied };
}

/** 自检：完整性 + 版本可读（备份/恢复后调用）。 */
export function checkIntegrity(db) {
  const r = db.prepare('PRAGMA integrity_check').get();
  const value = r?.integrity_check ?? Object.values(r ?? {})[0];
  return value === 'ok';
}
