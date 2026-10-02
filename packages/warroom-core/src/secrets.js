// 秘密边界（ADR-001 D7）：at-rest 加密 + 权限化 resolve + TTL 授权 + 全出口脱敏。
// 原则：agent 只见 secret_ref；明文只在 host 服务内部短暂存在；任何回显/日志/报告过 redactor。
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ERR, warroomError } from '../../shared-types/src/index.js';
import { redact as redactText } from './redactor.js';

const KEY_FILE = 'key.bin';
const KEYS_DIR = 'keys';
const keyIdOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

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

/** 历史密钥（轮换留档）：keys/<key_id>.bin，权限 600。 */
function loadArchivedKey(root, keyId) {
  const p = join(root, KEYS_DIR, `${keyId}.bin`);
  if (!existsSync(p)) throw warroomError(ERR.E_SECRET_KEY_INVALID, `缺少历史密钥 ${keyId}（${p}）——无法解密该条秘密`);
  chmodSync(p, 0o600);
  return readFileSync(p);
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
    this.keyId = keyIdOf(this.key);
    this.now = nowMs ?? (() => Date.now());
  }

  put(plaintext, { label = 'secret' } = {}) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw warroomError(ERR.E_SECRET_NOT_FOUND, 'plaintext 必须是非空字符串');
    }
    const secret_ref = `sec_${randomUUID()}`;
    const { ct, iv, tag } = encrypt(this.key, plaintext);
    this.db.prepare(`INSERT INTO secret_store (secret_ref, label, ciphertext, iv, tag, created_at, key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(secret_ref, label, ct, iv, tag, new Date(this.now()).toISOString(), this.keyId);
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
    return { value: decrypt(this._keyFor(row), row), label: row.label };
  }

  /** 取某条秘密对应的密钥：当前密钥，或轮换前的历史密钥。 */
  _keyFor(row) {
    if (!row.key_id || row.key_id === this.keyId) return this.key;
    return loadArchivedKey(this.root, row.key_id);
  }

  /** 注册表：所有明文（仅供 host 侧 redactor 构建，绝不回传 agent）。 */
  values() {
    return this.db.prepare('SELECT * FROM secret_store').all()
      .map((r) => ({ secret_ref: r.secret_ref, label: r.label, value: decrypt(this._keyFor(r), r) }));
  }

  /**
   * 密钥轮换（ADR-001 D7 高级秘密管理）：
   * 1) 当前密钥归档到 keys/<key_id>.bin（600）；
   * 2) 生成新密钥并就地写入 key.bin（600）；
   * 3) 用新密钥**重新加密全部秘密**并更新 key_id（单事务）；
   * 轮换后旧秘密照常可解（历史密钥仍在），新登记使用新密钥。
   */
  rotateKey() {
    const oldKeyId = this.keyId;
    const archived = join(this.root, KEYS_DIR, `${oldKeyId}.bin`);
    mkdirSync(join(this.root, KEYS_DIR), { recursive: true, mode: 0o700 });
    if (!existsSync(archived)) {
      writeFileSync(archived, this.key, { mode: 0o600 });
    }
    chmodSync(archived, 0o600);

    const newKey = randomBytes(32);
    const newKeyId = keyIdOf(newKey);
    const rows = this.db.prepare('SELECT * FROM secret_store').all();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upd = this.db.prepare('UPDATE secret_store SET ciphertext = ?, iv = ?, tag = ?, key_id = ? WHERE secret_ref = ?');
      let reencrypted = 0;
      for (const r of rows) {
        const plain = decrypt(this._keyForFrom(r, oldKeyId), r);
        const { ct, iv, tag } = encrypt(newKey, plain);
        upd.run(ct, iv, tag, newKeyId, r.secret_ref);
        reencrypted += 1;
      }
      this.db.exec('COMMIT');
      this._reencrypted = reencrypted;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    // 库写入成功后再换盘上密钥，避免"库已换、盘未换"的不可用窗口
    writeFileSync(join(this.root, KEY_FILE), newKey, { mode: 0o600 });
    chmodSync(join(this.root, KEY_FILE), 0o600);
    this.key = newKey;
    this.keyId = newKeyId;
    this.db.prepare(`INSERT INTO op_log (op_id, kind, ref_id, state, detail, ts)
      VALUES (?, 'secret_key_rotate', NULL, 'activated', ?, ?)`).run(
      randomUUID(), `old=${oldKeyId} new=${newKeyId} rows=${rows.length}`, new Date(this.now()).toISOString());
    return { old_key_id: oldKeyId, new_key_id: newKeyId, reencrypted: rows.length, archived_key: archived };
  }

  /** 轮换过程中用指定历史密钥解密（用于读取尚未更新 key_id 的行）。 */
  _keyForFrom(row, fallbackKeyId) {
    const id = row.key_id ?? fallbackKeyId;
    if (id === this.keyId) return this.key;
    return loadArchivedKey(this.root, id);
  }

  /** 全出口脱敏：已知明文精确替换 + 常见密钥形态正则。 */
  redact(text) {
    if (text === undefined || text === null) return text;
    return redactText(String(text), this.values());
  }
}
