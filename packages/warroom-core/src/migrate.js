// schema 版本与迁移框架（框架 §10 数据治理）。
// 规则：schema_version 记录在 meta 表；库版本高于代码版本 → 拒绝打开（防降级写坏数据）。
import { SCHEMA_VERSION } from './version.js';

const META_KEY = 'schema_version';
export const ERR_SCHEMA_NEWER = 'E_SCHEMA_NEWER_THAN_CODE';

/** 迁移清单：version = 目标版本，up(db) 执行该步变更。基准 DDL 由 db.js 保证，这里只做增量。 */
export const MIGRATIONS = [
  // v1 为基准结构（db.js DDL 已含），无增量
];

function readVersion(db, label) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(`${META_KEY}:${label}`);
  return row ? Number(row.v) : null;
}

function writeVersion(db, label, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(`${META_KEY}:${label}`, String(v));
}

/**
 * 运行迁移：幂等。库版本 > 代码支持版本时抛错（不静默降级）。
 * @returns {{from:number|null, to:number, applied:number[]}}
 */
export function runMigrations(db, label) {
  const current = readVersion(db, label);
  if (current !== null && current > SCHEMA_VERSION) {
    const e = new Error(`schema_version ${current} > code ${SCHEMA_VERSION}（${label}）；请升级代码而非降级库`);
    e.code = ERR_SCHEMA_NEWER;
    throw e;
  }
  const applied = [];
  if (current === null) {
    // 新库：结构与代码同版
    writeVersion(db, label, SCHEMA_VERSION);
    return { from: null, to: SCHEMA_VERSION, applied };
  }
  for (const m of MIGRATIONS) {
    if (m.version > current && m.version <= SCHEMA_VERSION) {
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
  if (!applied.includes(SCHEMA_VERSION)) writeVersion(db, label, SCHEMA_VERSION);
  return { from: current, to: SCHEMA_VERSION, applied };
}

/** 自检：完整性 + 版本可读（备份/恢复后调用）。 */
export function checkIntegrity(db) {
  const r = db.prepare('PRAGMA integrity_check').get();
  const value = r?.integrity_check ?? Object.values(r ?? {})[0];
  return value === 'ok';
}
