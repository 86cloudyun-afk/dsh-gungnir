// FactStore：fact.db 的唯一写入口（ADR-002 D2/D5/D4）。
// 成员级幂等：source_key = (adapter_instance, entity_type, source_id)，revision_no 定修订先后。
import { createHash, randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const sha = (s) => createHash('sha256').update(s).digest('hex');

export class FactStore {
  /** @param {InstanceType<typeof DatabaseSync>} db 已应用 DDL 的战役库连接 */
  constructor(db, engagementId) {
    this.db = db;
    this.engagementId = engagementId;
    this.faults = {}; // 测试注入：{ write_fail: true }
  }

  _now() { return now(); }

  seq() {
    const r = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS s FROM fact_seq').get();
    return r.s;
  }

  /** 账务状态：有效事实数 = active 行数（判定引擎与记账只看它，ADR-002 D5）。 */
  effectiveCount() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM fact_members WHERE active = 1').get().c;
  }

  /**
   * 成员级幂等入库：入库 + 记账 + seq 递增在同一 BEGIN IMMEDIATE 事务（ADR-002 D5）。
   * @param {Array<{entity_type:string, source_id:string, revision_no:number, content_hash:string, payload:object}>} members
   */
  ingestMembers({ adapterInstance, members, generation, flags = null }) {
    if (this.faults.write_fail) {
      throw Object.assign(new Error('injected store write failure'), { code: 'E_STORE_WRITE_FAILED' });
    }
    const results = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ins = this.db.prepare(`INSERT INTO fact_members
        (adapter_instance, entity_type, source_id, revision_no, content_hash, payload, generation, active, flags, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const findActive = this.db.prepare(`SELECT id, revision_no, content_hash FROM fact_members
        WHERE adapter_instance = ? AND entity_type = ? AND source_id = ? AND active = 1`);
      for (const m of members) {
        const ts = this._now();
        const active = findActive.get(adapterInstance, m.entity_type, m.source_id);
        let outcome;
        if (!active) {
          const info = ins.run(adapterInstance, m.entity_type, m.source_id, m.revision_no, m.content_hash,
            JSON.stringify(m.payload ?? {}), generation, 1, null, ts);
          outcome = { action: 'inserted', member_row_id: info.lastInsertRowid };
        } else if (m.revision_no > active.revision_no) {
          // 旧行先降级（唯一部分索引约束 active 行唯一），新行后插入，再回填 superseded_by
          this.db.prepare('UPDATE fact_members SET active = 0 WHERE id = ?').run(active.id);
          const info = ins.run(adapterInstance, m.entity_type, m.source_id, m.revision_no, m.content_hash,
            JSON.stringify(m.payload ?? {}), generation, 1, null, ts);
          this.db.prepare('UPDATE fact_members SET superseded_by = ? WHERE id = ?')
            .run(info.lastInsertRowid, active.id);
          outcome = { action: 'superseded', member_row_id: info.lastInsertRowid, superseded: active.id };
        } else if (m.revision_no === active.revision_no) {
          if (m.content_hash === active.content_hash) {
            outcome = { action: 'duplicate_ignored' };
          } else {
            // 同修订号不同内容：冲突入待审，不参与记账（ADR-002 D3）
            const info = ins.run(adapterInstance, m.entity_type, m.source_id, m.revision_no, m.content_hash,
              JSON.stringify(m.payload ?? {}), generation, 0, 'conflict_review', ts);
            outcome = { action: 'conflict_review', member_row_id: info.lastInsertRowid };
          }
        } else {
          // 晚到的旧修订：留历史行，不覆盖、不记账（ADR-002 D5）
          const info = ins.run(adapterInstance, m.entity_type, m.source_id, m.revision_no, m.content_hash,
            JSON.stringify(m.payload ?? {}), generation, 0, 'late_revision', ts);
          outcome = { action: 'late_revision_ignored', member_row_id: info.lastInsertRowid };
        }
        if (flags) outcome.flags = flags;
        results.push({ source_id: m.source_id, ...outcome });
      }
      this.db.prepare('INSERT INTO fact_seq (ts, note) VALUES (?, ?)').run(this._now(), 'ingest');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { seq: this.seq(), results };
  }

  /** 代际隔离：旧代回执进隔离区（不产生 active 行，ADR-003 D6 + ADR-002 D5）。 */
  quarantineStaleGeneration({ adapterInstance, members, generation }) {
    const ts = this._now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ins = this.db.prepare(`INSERT INTO fact_members
        (adapter_instance, entity_type, source_id, revision_no, content_hash, payload, generation, active, flags, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'stale_generation', ?)`);
      for (const m of members) {
        ins.run(adapterInstance, m.entity_type, m.source_id, m.revision_no, m.content_hash,
          JSON.stringify(m.payload ?? {}), generation, ts);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  appendGateLog({ decision, code = null, detail = null, request = null, recovered_at = null }) {
    this.db.prepare(`INSERT INTO gate_log (ts, decision, code, detail, request_json, recovered_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(this._now(), decision, code, detail,
      request ? (typeof request === 'string' ? request : JSON.stringify(request)) : null, recovered_at);
  }

  /** 审计补齐（op_log 补偿期间 fact 不可写，恢复后回填，ADR-002 D6）。 */
  backfillEgressCheck({ jumphost_id, exit_ip, verdict, route_id }) {
    this.db.prepare(`INSERT INTO egress_checks (ts, jumphost_id, exit_ip, verdict, route_id, recovered_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(this._now(), jumphost_id, exit_ip, verdict, route_id, this._now());
  }

  recordRate({ target, kind, amount = 1 }) {
    this.db.prepare(`INSERT INTO rate_ledger (ts, engagement_id, target, kind, amount)
      VALUES (?, ?, ?, ?, ?)`).run(this._now(), this.engagementId, target, kind, amount);
  }

  lastRateTs(kind) {
    const r = this.db.prepare('SELECT ts FROM rate_ledger WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
    return r ? r.ts : null;
  }

  rateTotal(kind) {
    return this.db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM rate_ledger WHERE kind = ?').get(kind).t;
  }

  // ── shell 状态（ADR-002 D8：历史证明 / 当前有效性 / 最后验证时间 三字段分离）─────
  /** 记录历史最高权限证明（不改变当前可控性）。 */
  recordShellProof({ proof, evidence_ref = null }) {
    const cur = this.shellState();
    if (cur) {
      this.db.prepare('UPDATE shell_state SET highest_proof = ? WHERE id = ?').run(proof, cur.id);
    } else {
      this.db.prepare(`INSERT INTO shell_state (engagement_id, highest_proof, current_validity, last_verified_at)
        VALUES (?, ?, 'unknown', NULL)`).run(this.engagementId, proof);
    }
    this.appendGateLog({ decision: 'shell_proof', detail: `highest_proof=${proof}`, request: evidence_ref });
    return this.shellState();
  }

  /**
   * 更新当前有效性：只能由**再验证**驱动（unknown | likely | confirmed_lost），
   * 不允许因为"历史拿过"就默认仍然可控。
   */
  verifyShell({ validity, evidence_ref = null }) {
    const allowed = ['unknown', 'likely', 'confirmed_lost'];
    if (!allowed.includes(validity)) throw new Error(`validity 必须是 ${allowed.join(' | ')}`);
    const cur = this.shellState();
    const ts = this._now();
    if (cur) {
      this.db.prepare('UPDATE shell_state SET current_validity = ?, last_verified_at = ? WHERE id = ?')
        .run(validity, ts, cur.id);
    } else {
      this.db.prepare(`INSERT INTO shell_state (engagement_id, highest_proof, current_validity, last_verified_at)
        VALUES (?, NULL, ?, ?)`).run(this.engagementId, validity, ts);
    }
    this.appendGateLog({ decision: 'shell_verify', detail: `current_validity=${validity}`, request: evidence_ref });
    return this.shellState();
  }

  shellState() {
    return this.db.prepare('SELECT * FROM shell_state WHERE engagement_id = ? ORDER BY id DESC LIMIT 1')
      .get(this.engagementId) ?? null;
  }

  // ── 凭据喷洒：断点与防锁死（宪法反模式 5/6 的库化）──────────────────────────
  /** 记录一次喷洒（无论成败）。 */
  sprayRecord({ credential_ref, service, account, result }) {
    const allowed = ['success', 'fail', 'locked', 'skipped'];
    if (!allowed.includes(result)) throw new Error(`result 必须是 ${allowed.join(' | ')}`);
    this.db.prepare(`INSERT INTO spray_log (ts, credential_ref, service, account, result)
      VALUES (?, ?, ?, ?, ?)`).run(this._now(), credential_ref, service, account, result);
  }

  /** 断点：该 (凭据 × 服务 × 账号) 是否已试过（避免重复爆破）。 */
  sprayTried({ credential_ref, service, account }) {
    return !!this.db.prepare(`SELECT 1 FROM spray_log
      WHERE credential_ref = ? AND service = ? AND account = ? AND result IN ('success','fail','locked','skipped')
      LIMIT 1`).get(credential_ref, service, account);
  }

  /** 防锁死：该 (服务 × 账号) 是否已触发锁定 → 一律停止重试。 */
  sprayLocked({ service, account }) {
    return !!this.db.prepare(`SELECT 1 FROM spray_log
      WHERE service = ? AND account = ? AND result = 'locked' LIMIT 1`).get(service, account);
  }

  spraySummary() {
    return this.db.prepare(`SELECT result, COUNT(*) AS n FROM spray_log GROUP BY result`).all();
  }

  _writeGuard() {
    if (this.faults.write_fail) {
      throw Object.assign(new Error('injected store write failure'), { code: 'E_STORE_WRITE_FAILED' });
    }
  }

  /** 供 host 服务（跳板/隧道）写入战役运行审计；过统一写闸（故障注入可挡）。 */
  recordRoute({ route_id, lease_id, jumphost_id, socks }) {
    this._writeGuard();
    this.db.prepare(`INSERT INTO jump_routes (route_id, lease_id, jumphost_id, socks, state, ts)
      VALUES (?, ?, ?, ?, 'active', ?)`).run(route_id, lease_id, jumphost_id, socks, this._now());
  }

  recordEgressCheck({ jumphost_id, exit_ip, route_id, verdict = 'pass' }) {
    this._writeGuard();
    this.db.prepare(`INSERT INTO egress_checks (ts, jumphost_id, exit_ip, verdict, route_id)
      VALUES (?, ?, ?, ?, ?)`).run(this._now(), jumphost_id, exit_ip, verdict, route_id);
  }

  /** 水位导出：单只读事务快照 + seq；snapshot_id 为内容摘要（ADR-002 D4）。 */
  exportSnapshot() {
    this.db.exec('BEGIN');
    try {
      const seq = this.seq();
      const rows = this.db.prepare('SELECT * FROM fact_members ORDER BY id').all();
      const exported_at = this._now();
      const snapshot_id = sha(JSON.stringify({ seq, rows }));
      this.db.exec('COMMIT');
      return { seq, snapshot_id, exported_at, rows };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  exportReceipt() {
    const snap = this.exportSnapshot();
    return {
      watermark: { seq: snap.seq, snapshot_id: snap.snapshot_id, exported_at: snap.exported_at },
      evidence_digests: { fact_members: sha(JSON.stringify(snap.rows)) },
    };
  }

  newId() { return randomUUID(); }
}
