// 知识库（ADR-004 范围项 3）：POC/EXP 跨战役复用 + 回填强制脱敏。
// 存储：$home/knowledge.db（全局单份，跨战役共享——因此脱敏是硬门槛，不是建议）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const POC_CATEGORIES = Object.freeze([
  'rce', 'deserialization', 'upload', 'sqli', 'unauth', 'auth-bypass', 'weak-cred',
  'ssrf', 'xxe', 'traversal', 'info-leak', 'privesc', 'tunnel', 'other',
]);

export const KNOWLEDGE_SCHEMA_VERSION = 1;

/** 脱敏审计：知识库是跨战役共享的，任何内网地址/自有基础设施痕迹都是硬违规。 */
export const SENSITIVE_PATTERNS = Object.freeze([
  { name: '内网 IPv4', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g },
  { name: '环回地址', re: /\b127\.0\.0\.1(:\d+)?\b/g },
  { name: '内部域名后缀', re: /\b[a-z0-9-]+\.(?:internal|intranet|lan|corp|local)\b/gi },
  { name: '靶标专属占位未替换', re: /<TARGET>|<VPS_IP>|TARGET_HOST/gi },
]);

/**
 * @returns {{clean:boolean, findings:Array<{name:string, sample:string}>}}
 */
export function auditSanitization(text) {
  const findings = [];
  const s = String(text ?? '');
  for (const { name, re } of SENSITIVE_PATTERNS) {
    const m = s.match(re);
    if (m) findings.push({ name, sample: m.slice(0, 3).join(',') });
  }
  return { clean: findings.length === 0, findings };
}

function openKnowledgeDb(home) {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'knowledge.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS poc (
      code TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL,
      source TEXT, affected_versions TEXT, evidence_ref TEXT,
      sanitized INTEGER NOT NULL DEFAULT 0, sanitization_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS poc_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, engagement_id TEXT NOT NULL,
      asset TEXT, result TEXT, ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_poc_usage_code ON poc_usage(code);
  `);
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run('knowledge_schema_version', String(KNOWLEDGE_SCHEMA_VERSION));
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run('categories', POC_CATEGORIES.join(','));
  return db;
}

export class KnowledgeBase {
  constructor({ home }) {
    this.db = openKnowledgeDb(home);
    this.home = home;
  }

  /**
   * 回填 POC：默认强制脱敏——命中内网/自有痕迹即拒绝；
   * 确需保留时用 allow_unsanitized + 理由（会记入 sanitization_note，可审计）。
   */
  addPoc(fields = {}) {
    const ALLOWED = ['code', 'title', 'category', 'source', 'affected_versions', 'evidence_ref',
      'body', 'allow_unsanitized', 'note'];
    const unknown = Object.keys(fields).filter((k) => !ALLOWED.includes(k));
    if (unknown.length) {
      // 静默丢弃字段 = 静默丢证据：显式拒绝（与配置校验同一哲学）
      throw new Error(`addPoc 收到未知字段：${unknown.join(', ')}（允许：${ALLOWED.join(', ')}）`);
    }
    const { code, title, category, source, affected_versions, evidence_ref,
      body = '', allow_unsanitized = false, note = '' } = fields;
    if (!code || !title) throw new Error('addPoc 需要 code 与 title');
    if (!POC_CATEGORIES.includes(category)) throw new Error(`category 必须是 ${POC_CATEGORIES.join('|')}`);
    const audit = auditSanitization(`${code} ${title} ${source ?? ''} ${affected_versions ?? ''} ${body}`);
    if (!audit.clean && !allow_unsanitized) {
      const e = new Error(`脱敏审计未通过：${audit.findings.map((f) => `${f.name}(${f.sample})`).join('; ')}`);
      e.code = 'E_KB_UNSANITIZED';
      e.findings = audit.findings;
      throw e;
    }
    const ts = new Date().toISOString();
    this.db.prepare(`INSERT INTO poc (code, title, category, source, affected_versions, evidence_ref,
        sanitized, sanitization_note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET title=excluded.title, category=excluded.category, source=excluded.source,
        affected_versions=excluded.affected_versions, evidence_ref=excluded.evidence_ref,
        sanitized=excluded.sanitized, sanitization_note=excluded.sanitization_note, updated_at=excluded.updated_at`).run(
      code, title, category, source ?? null, affected_versions ?? null, evidence_ref ?? null,
      audit.clean ? 1 : 0, audit.clean ? null : `allow_unsanitized: ${note || '未说明'}`, ts, ts);
    return this.getPoc(code);
  }

  getPoc(code) {
    return this.db.prepare('SELECT * FROM poc WHERE code = ?').get(code) ?? null;
  }

  /**
   * 检索（跨战役复用的入口）：默认按**相关度**排序，而不是单纯按时间。
   *
   * 相关度 = 关键词命中（code/title 权重高于 source/body）
   *        + **历史命中率**（打过通的优先——这是知识库真正的价值信号）
   *        + 新鲜度衰减（半衰期 90 天）
   *
   * @param {{q?:string, category?:string, limit?:number, sort?:'relevance'|'recent'|'hits'}} opts
   */
  search({ q, category, limit = 50, sort = 'relevance' } = {}) {
    const where = [];
    const args = [];
    if (q) {
      where.push('(code LIKE ? OR title LIKE ? OR source LIKE ? OR affected_versions LIKE ? OR evidence_ref LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (category) { where.push('category = ?'); args.push(category); }
    const rows = this.db.prepare(`SELECT * FROM poc ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...args);

    // 使用统计（命中率 + 最近使用）
    const stats = this.db.prepare(`
      SELECT code,
             COUNT(*) AS total,
             SUM(CASE WHEN result = 'hit' THEN 1 ELSE 0 END) AS hits,
             MAX(ts) AS last_used
      FROM poc_usage GROUP BY code
    `).all();
    const statByCode = new Map(stats.map((s) => [s.code, s]));

    const nowMs = Date.now();
    const HALF_LIFE_DAYS = 90;
    const scored = rows.map((row) => {
      const st = statByCode.get(row.code) ?? { total: 0, hits: 0, last_used: null };
      const hitRate = st.total > 0 ? st.hits / st.total : 0;
      let keyword = 0;
      if (q) {
        const ql = q.toLowerCase();
        if (row.code.toLowerCase().includes(ql)) keyword += 3;
        if (row.title.toLowerCase().includes(ql)) keyword += 2;
        if ((row.source ?? '').toLowerCase().includes(ql)) keyword += 1;
        if ((row.affected_versions ?? '').toLowerCase().includes(ql)) keyword += 1;
      } else keyword = 1;   // 无关键词：不区分词面，只比历史价值与新鲜度
      const refTs = Date.parse(st.last_used ?? row.updated_at ?? row.created_at ?? '') || 0;
      const ageDays = refTs ? (nowMs - refTs) / 86400000 : 365;
      const freshness = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      return {
        ...row,
        _score: Number((keyword + hitRate * 3 + freshness * 1.5).toFixed(4)),
        _usage: { total: st.total, hits: st.hits, hit_rate: Number(hitRate.toFixed(3)), last_used: st.last_used },
      };
    });

    const order = {
      relevance: (a, b) => b._score - a._score,
      recent: (a, b) => Date.parse(b.updated_at ?? 0) - Date.parse(a.updated_at ?? 0),
      hits: (a, b) => b._usage.hits - a._usage.hits,
    }[sort] ?? ((a, b) => b._score - a._score);

    return scored.sort(order).slice(0, limit)
      .map(({ _score, _usage, ...row }) => ({ ...row, score: _score, usage: _usage }));
  }

  /** 跨战役复用登记：同一 POC 可被多个战役使用，用法与结果留痕。 */
  use(code, { engagement_id, asset, result = 'used' }) {
    if (!engagement_id) throw new Error('use 需要 engagement_id');
    if (!this.getPoc(code)) throw new Error(`POC ${code} 不存在`);
    this.db.prepare('INSERT INTO poc_usage (code, engagement_id, asset, result, ts) VALUES (?, ?, ?, ?, ?)')
      .run(code, engagement_id, asset ?? null, result, new Date().toISOString());
    return { code, engagement_id, asset: asset ?? null, result };
  }

  usage(code) {
    return this.db.prepare('SELECT * FROM poc_usage WHERE code = ? ORDER BY id').all(code);
  }

  /** 某战役用过的 POC（供报告「知识库复用」段）。 */
  usageByEngagement(engagementId) {
    const rows = this.db.prepare(`
      SELECT u.code, u.asset, u.result, u.ts, p.title, p.category
      FROM poc_usage u LEFT JOIN poc p ON p.code = u.code
      WHERE u.engagement_id = ? ORDER BY u.id
    `).all(engagementId);
    const byResult = rows.reduce((acc, r) => {
      acc[r.result] = (acc[r.result] ?? 0) + 1;
      return acc;
    }, {});
    return { rows, total: rows.length, distinct_pocs: new Set(rows.map((r) => r.code)).size, by_result: byResult };
  }

  stats() {
    const byCategory = this.db.prepare('SELECT category, COUNT(*) AS n FROM poc GROUP BY category ORDER BY n DESC').all();
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM poc').get().n;
    const usage = this.db.prepare('SELECT code, COUNT(*) AS n FROM poc_usage GROUP BY code ORDER BY n DESC LIMIT 10').all();
    const crossCampaign = this.db.prepare('SELECT COUNT(DISTINCT engagement_id) AS n FROM poc_usage').get().n;
    return { total, by_category: byCategory, top_used: usage, engagements_using: crossCampaign };
  }

  close() { this.db.close(); }
}
