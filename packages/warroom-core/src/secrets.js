// 秘密边界（ADR-001 D7）：at-rest 加密 + 权限化 resolve + TTL 授权 + 全出口脱敏。
// 原则：agent 只见 secret_ref；明文只在 host 服务内部短暂存在；任何回显/日志/报告过 redactor。
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ERR, warroomError } from '../../shared-types/src/index.js';
import { redact as redactText } from './redactor.js';

const KEY_FILE = 'key.bin';

function ensureDir(path, mode) {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function loadOrCreateKey(root) {
  const path = join(root, KEY_FILE);
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32), { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32) throw warroomError(ERR.E_SECRET_KEY_INVALID, 'key.bin 必须是 32 字节');
  return key;
}

function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ct, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

function decrypt(key, { ciphertext, iv, tag }) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export class SecretVault {
  /**
   * @param {{root:string, db:object, nowMs?:()=>number}} opts
   *   root 默认 $DSH_HOME/warroom/secrets（700）；db = global.db（secret_store/secret_grants 两表）
   */
  constructor({ root, db, nowMs }) {
    ensureDir(root, 0o700);
    this.root = root;
    this.db = db;
    this.key = loadOrCreateKey(root);
    this.now = nowMs ?? (() => Date.now());
  }

  put(plaintext, { label = 'secret' } = {}) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw warroomError(ERR.E_SECRET_NOT_FOUND, 'plaintext 必须是非空字符串');
    }
    const secret_ref = `sec_${randomUUID()}`;
    const { ct, iv, tag } = encrypt(this.key, plaintext);
    this.db.prepare(`INSERT INTO secret_store (secret_ref, label, ciphertext, iv, tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(secret_ref, label, ct, iv, tag, new Date(this.now()).toISOString());
    return { secret_ref, label };
  }

  _row(secret_ref) {
    const row = this.db.prepare('SELECT * FROM secret_store WHERE secret_ref = ?').get(secret_ref);
    if (!row) throw warroomError(ERR.E_SECRET_NOT_FOUND, `secret ${secret_ref} 不存在`);
    return row;
  }

  /** 授权：绑定（secret_ref × engagement × task × purpose）与 TTL。host 侧调用。 */
  grant(secret_ref, { engagement_id, task_id, purpose, ttlSeconds = 300 } = {}) {
    this._row(secret_ref);
    if (!task_id || !purpose) throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'grant 需要 task_id 与 purpose');
    const grant_id = `gr_${randomUUID()}`;
    const expires_at = new Date(this.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`INSERT INTO secret_grants
      (grant_id, secret_ref, engagement_id, task_id, purpose, expires_at, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      grant_id, secret_ref, engagement_id ?? null, task_id, purpose, expires_at,
      new Date(this.now()).toISOString());
    return { grant_id, expires_at };
  }

  /** 解析：必须有未过期且匹配（task_id × purpose）的授权；每次调用留审计。 */
  resolve(secret_ref, { task_id, purpose } = {}) {
    const g = this.db.prepare(`SELECT * FROM secret_grants
      WHERE secret_ref = ? AND task_id = ? AND purpose = ?
      ORDER BY expires_at DESC LIMIT 1`).get(secret_ref, task_id, purpose);
    if (!g) throw warroomError(ERR.E_SECRET_NO_GRANT, `无授权：${secret_ref} × ${task_id} × ${purpose}`);
    if (Date.parse(g.expires_at) <= this.now()) {
      throw warroomError(ERR.E_SECRET_GRANT_EXPIRED, `授权已过期（${g.expires_at}）`);
    }
    const row = this._row(secret_ref);
    this.db.prepare(`INSERT INTO op_log (op_id, kind, ref_id, state, detail, ts)
      VALUES (?, 'secret_resolve', ?, 'activated', ?, ?)`).run(
      randomUUID(), secret_ref, `task=${task_id} purpose=${purpose}`, new Date(this.now()).toISOString());
    return { value: decrypt(this.key, row), label: row.label };
  }

  /** 注册表：所有明文（仅供 host 侧 redactor 构建，绝不回传 agent）。 */
  values() {
    return this.db.prepare('SELECT secret_ref, label, ciphertext, iv, tag FROM secret_store').all()
      .map((r) => ({ secret_ref: r.secret_ref, label: r.label, value: decrypt(this.key, r) }));
  }

  /** 全出口脱敏：已知明文精确替换 + 常见密钥形态正则。 */
  redact(text) {
    if (text === undefined || text === null) return text;
    return redactText(String(text), this.values());
  }
}
