// 数据库打开与 DDL。写所有权：fact.db / global.db 的读写连接由唯一 host 服务持有；
// 其它组件一律 mode=ro（ADR-002 D9）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from './migrate.js';
import { TASK_LEDGER_DDL } from './task-ledger.js';

export const FACT_DDL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY,
  target_scope TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  allowed_means TEXT NOT NULL,
  action_class_limit TEXT NOT NULL,
  rhythm TEXT NOT NULL,
  auth_version INTEGER NOT NULL DEFAULT 1,
  auth_object TEXT NOT NULL,
  auth_hash TEXT NOT NULL,
  user_message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fact_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter_instance TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  generation TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  superseded_by INTEGER,
  flags TEXT,
  ts TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_member
  ON fact_members(adapter_instance, entity_type, source_id) WHERE active = 1;
CREATE TABLE IF NOT EXISTS fact_seq (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS gate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, decision TEXT NOT NULL,
  code TEXT, detail TEXT, request_json TEXT, recovered_at TEXT
);
-- 类型化投影占位（v0.2 物化）；v0.1 事实以 fact_members 为唯一存储
CREATE TABLE IF NOT EXISTS assets (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS domains (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vulns (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chains (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shell_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT, engagement_id TEXT NOT NULL,
  highest_proof TEXT, current_validity TEXT NOT NULL DEFAULT 'unknown', last_verified_at TEXT
);
CREATE TABLE IF NOT EXISTS jump_routes (
  route_id TEXT PRIMARY KEY, lease_id TEXT, jumphost_id TEXT, socks TEXT,
  state TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS egress_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, jumphost_id TEXT,
  exit_ip TEXT, verdict TEXT NOT NULL, route_id TEXT, recovered_at TEXT
);
CREATE TABLE IF NOT EXISTS cooldowns (jumphost_id TEXT, until TEXT, reason TEXT, PRIMARY KEY (jumphost_id, until));
CREATE TABLE IF NOT EXISTS spray_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, credential_ref TEXT,
  service TEXT, account TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS meetings (
  meeting_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, title TEXT NOT NULL,
  notes TEXT NOT NULL, decisions TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, engagement_id TEXT NOT NULL,
  target TEXT, kind TEXT NOT NULL CHECK (kind IN ('wire', 'tool')), amount INTEGER NOT NULL DEFAULT 1
);
`;

export const GLOBAL_DDL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jumphosts (
  id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'pure-relay', ssh_host TEXT,
  status TEXT NOT NULL DEFAULT 'healthy', quota INTEGER NOT NULL DEFAULT 3,
  used_today INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, addr_v4 TEXT, addr_v6 TEXT
);
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY, jumphost_id TEXT NOT NULL, engagement_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldowns (
  jumphost_id TEXT NOT NULL, until TEXT NOT NULL, reason TEXT, ts TEXT NOT NULL,
  PRIMARY KEY (jumphost_id, until)
);
CREATE TABLE IF NOT EXISTS op_log (
  op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT, state TEXT NOT NULL,
  detail TEXT, ts TEXT NOT NULL, recovered_at TEXT
);
CREATE TABLE IF NOT EXISTS command_queue (
  last_heartbeat_at TEXT,
  command_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, task_id TEXT,
  contract TEXT NOT NULL, state TEXT NOT NULL, generation TEXT, attempt INTEGER NOT NULL DEFAULT 1,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secret_store (
  secret_ref TEXT PRIMARY KEY, label TEXT NOT NULL,
  ciphertext BLOB NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL,
  key_id TEXT
);
CREATE TABLE IF NOT EXISTS secret_grants (
  grant_id TEXT PRIMARY KEY, secret_ref TEXT NOT NULL, engagement_id TEXT,
  task_id TEXT NOT NULL, purpose TEXT NOT NULL, expires_at TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secret_grants_lookup
  ON secret_grants(secret_ref, task_id, purpose, expires_at);
CREATE TABLE IF NOT EXISTS task_metrics (
  command_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, task_id TEXT,
  role TEXT, model_tier TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  wall_time_ms INTEGER NOT NULL DEFAULT 0, verified_facts INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, action_class TEXT NOT NULL,
  reason TEXT, issued_by TEXT, expires_at TEXT NOT NULL, single_use INTEGER NOT NULL DEFAULT 1,
  used_by_command TEXT, ts TEXT NOT NULL
);
`;

function applyDdl(db, ddl) {
  db.exec(ddl);
}

export function openEngagementDb(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'fact.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  applyDdl(db, FACT_DDL);
  runMigrations(db, 'fact');
  return db;
}

export function openGlobalDb(home) {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'global.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  applyDdl(db, GLOBAL_DDL);
  applyDdl(db, TASK_LEDGER_DDL);
  runMigrations(db, 'global');
  return db;
}

/** 只读连接（非所有者组件用；写操作将被 SQLite 拒绝——ADR-002 D9 验收负样本）。 */
export function openReadOnly(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA query_only = ON');
  return db;
}
