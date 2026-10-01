// Broker：唯一副作用通道（ADR-001 D1/D2）+ 命令队列 + 撤销级联 + 代际收集（ADR-003）。
import { randomUUID } from 'node:crypto';
import {
  validateFourTuple, validateContract, validateReceipt,
  warroomError, ERR, canTransition, isTerminal, makeGeneration, ALL_TASK_STATES,
} from '../../shared-types/src/index.js';
import { checkAgainstAuth, buildAuthObject } from './gates.js';
import { join } from 'node:path';
import { openEngagementDb, openGlobalDb } from './db.js';
import { FactStore } from './store.js';
import { FakeAdapter } from './adapters/fake.js';
import { SecretVault } from './secrets.js';
import { redactDeep } from './redactor.js';

const now = () => new Date().toISOString();

export class Broker {
  /**
   * @param {{home:string, adapter?:object, nowMs?:()=>number}} opts
   */
  constructor({ home, adapter, nowMs } = {}) {
    this.home = home;
    this.global = openGlobalDb(home);
    this.secrets = new SecretVault({ root: join(home, 'secrets'), db: this.global, nowMs: () => this._nowMs() });
    this.adapter = adapter ?? new FakeAdapter();
    this._nowMs = nowMs ?? (() => Date.now());
    this.engagements = new Map(); // engagement_id -> { db, store }
    this.dispatchCounter = 0;
  }

  // ── 授权（开工指令即授权：宿主冻结对象，ADR-001 D3）─────────────────────────
  createEngagement({ user_message_id, targets, overrides, engagement_id } = {}) {
    const { auth_object, auth_hash } = buildAuthObject({ user_message_id, targets, overrides });
    const id = engagement_id ?? `eng_${randomUUID()}`;
    const dir = `${this.home}/engagements/${id}`;
    const db = openEngagementDb(dir);
    db.prepare(`INSERT INTO engagements
      (id, target_scope, window_start, window_end, allowed_means, action_class_limit, rhythm,
       auth_version, auth_object, auth_hash, user_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(
      id, JSON.stringify(auth_object.scope), auth_object.window_start, auth_object.window_end,
      JSON.stringify(auth_object.allowed_means), auth_object.action_class_limit, auth_object.rhythm,
      JSON.stringify(auth_object), auth_hash, user_message_id, now()
    );
    const store = new FactStore(db, id);
    this.engagements.set(id, { db, store });
    return { engagement_id: id, auth_version: 1, auth_hash, auth_object };
  }

  _eng(engagementId) {
    if (!this.engagements.has(engagementId)) {
      const db = openEngagementDb(`${this.home}/engagements/${engagementId}`);
      this.engagements.set(engagementId, { db, store: new FactStore(db, engagementId) });
    }
    return this.engagements.get(engagementId);
  }

  _auth(engagementId) {
    const row = this._eng(engagementId).db
      .prepare('SELECT * FROM engagements WHERE id = ?').get(engagementId);
    if (!row) throw warroomError(ERR.E_TASK_NOT_FOUND, `engagement ${engagementId} not found`);
    return { row, auth: JSON.parse(row.auth_object) };
  }

  // ── 执行（唯一副作用通道）────────────────────────────────────────────────────
  execute(req = {}) {
    // 契约形态 → broker 预分配 task_id → 四元组全量校验（ADR-001 D2）
    validateContract(req.contract);
    const task_id = req.task_id || `wt_${randomUUID()}`;
    validateFourTuple({
      engagement_id: req.engagement_id, auth_version: req.auth_version,
      task_id, action_class: req.contract?.action_class ?? req.action_class ?? '',
    });
    const { row, auth } = this._auth(req.engagement_id);
    const store = this._eng(req.engagement_id).store;

    // 请求 ⊆ 冻结授权对象（资产/时间窗/手段分级/版本，ADR-001 D3）
    checkAgainstAuth({
      auth: { ...auth, auth_version: row.auth_version },
      auth_version: req.auth_version,
      nowMs: this._nowMs(),
      contract: req.contract,
      manual_approval_token: req.manual_approval_token,
    });

    // broker 持有 task_id（四元组在派发前即完整）
    const generation = makeGeneration(row.auth_version, ++this.dispatchCounter, 1);
    const contract = { ...req.contract, task_id, generation, engagement_id: req.engagement_id };

    // 命令先持久化，后派发（ADR-003 D1：派发幂等）
    const existing = this.global
      .prepare('SELECT * FROM command_queue WHERE command_id = ?').get(req.command_id);
    if (existing) {
      return { command_id: req.command_id, task_id: existing.task_id, state: existing.state, deduped: true };
    }
    this.global.prepare(`INSERT INTO command_queue
      (command_id, engagement_id, task_id, contract, state, generation, ts)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run(
      req.command_id, req.engagement_id, task_id, JSON.stringify(contract), generation, now()
    );
    store.appendGateLog({
      decision: 'allow', code: 'BROKER_EXECUTE',
      detail: `class=${contract.action_class}`,
      request: this.secrets.redact(JSON.stringify({ command_id: req.command_id, task_id })),
    });

    // 计量：tool_calls 每次执行 +1；wire_requests 由契约声明（ADR-002 D10）
    store.recordRate({ target: contract.targets[0], kind: 'tool', amount: 1 });
    if (contract.wire_cost) store.recordRate({ target: contract.targets[0], kind: 'wire', amount: contract.wire_cost });

    try {
      const r = this.adapter.dispatch(req.command_id, contract);
      this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?')
        .run(r.state ?? 'running', req.command_id);
      return { command_id: req.command_id, task_id, state: r.state ?? 'running', generation };
    } catch (e) {
      if (e.code === 'E_DISPATCH_LOST_RESPONSE') {
        // 任务可能已在执行器侧创建：按 command_id 找回，不产生第二个任务（ADR-003 D1）
        const found = this.adapter.lookup(req.command_id);
        const state = 'unknown';
        this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?').run(state, req.command_id);
        return { command_id: req.command_id, task_id: found?.task_id ?? task_id, state, recoverable: true };
      }
      this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?').run('failed', req.command_id);
      store.appendGateLog({ decision: 'deny', code: e.code ?? 'ADAPTER_ERROR', detail: String(e.message) });
      throw e;
    }
  }

  // ── 取消与证实（ADR-003 D4：资源清单逐项证实，账本不算证明）──────────────────
  cancel(engagement_id, taskIdOrCommandId, reason = 'manual') {
    const cmd = this._findCommand(taskIdOrCommandId);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${taskIdOrCommandId} not found`);
    if (isTerminal(cmd.state)) return { task_id: cmd.task_id, state: cmd.state, terminal: true };

    this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?')
      .run('cancel_requested', cmd.command_id);
    this.adapter.cancel(cmd.task_id, reason);

    const manifest = this.adapter.manifestOf(cmd.task_id) ?? [];
    const confirmed = manifest.filter((m) => m.check());
    if (confirmed.length === manifest.length && manifest.length > 0) {
      this._setCommandState(cmd.command_id, 'confirmed_stopped');
      this._gate(engagement_id, 'stop_confirmed', { task_id: cmd.task_id, manifest: manifest.map(m => m.id) });
      return { task_id: cmd.task_id, state: 'confirmed_stopped', manifest: confirmed };
    }
    // 任一资源未证实 → unresolved（人工队列），op_log 记录隔离项
    for (const m of manifest.filter((x) => !x.check())) {
      this.global.prepare(`INSERT INTO op_log (op_id, kind, ref_id, state, detail, ts)
        VALUES (?, 'resource_unconfirmed', ?, 'quarantined', ?, ?)`)
        .run(randomUUID(), m.id, `${m.kind} not confirmed for ${cmd.task_id}`, now());
    }
    this._setCommandState(cmd.command_id, 'unresolved');
    return { task_id: cmd.task_id, state: 'unresolved',
      manifest: manifest.map((m) => ({ id: m.id, kind: m.kind, confirmed: m.check() })) };
  }

  // ── 撤销级联（ADR-001 D4 / ADR-003 D5）───────────────────────────────────────
  revoke(engagement_id, reason = 'revoked') {
    const { db } = this._eng(engagement_id);
    db.prepare('UPDATE engagements SET auth_version = auth_version + 1 WHERE id = ?').run(engagement_id);
    const open = this.global.prepare(`SELECT command_id, task_id FROM command_queue
      WHERE engagement_id = ? AND state IN ('queued','running','cancel_requested','unknown')`)
      .all(engagement_id);
    const results = open.map((c) => this.cancel(engagement_id, c.task_id, reason));
    return { auth_version: this._auth(engagement_id).row.auth_version, cancelled: results };
  }

  // ── 收集（成员级幂等 + 代际隔离，ADR-002 D5 / ADR-003 D6）────────────────────
  collect(engagement_id, task_id, receipt) {
    validateReceipt(receipt);
    const cmd = this._findCommand(task_id);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${task_id} not found`);
    const { store } = this._eng(engagement_id);
    const instance = this.adapter.instanceId ?? 'adapter-1';
    if (receipt.generation !== cmd.generation) {
      store.quarantineStaleGeneration({ adapterInstance: instance, members: receipt.members, generation: receipt.generation });
      return { accepted: false, quarantined: 'generation' };
    }
    const r = store.ingestMembers({ adapterInstance: instance, members: receipt.members, generation: receipt.generation });
    return { accepted: true, seq: r.seq, results: redactDeep(r.results, this.secrets.values()) };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────
  _findCommand(idOrCommand) {
    return this.global.prepare('SELECT * FROM command_queue WHERE task_id = ? OR command_id = ?')
      .get(idOrCommand, idOrCommand);
  }
  _setCommandState(command_id, state) {
    if (!ALL_TASK_STATES.includes(state)) throw new Error(`bad state ${state}`);
    this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?').run(state, command_id);
  }
  _gate(engagement_id, code, detail) {
    try {
      this._eng(engagement_id).store.appendGateLog({
        decision: code, detail: this.secrets.redact(JSON.stringify(detail)),
      });
    } catch { /* fact 不可写时审计走 op_log 补偿路径（ADR-002 D6） */ }
  }
}
