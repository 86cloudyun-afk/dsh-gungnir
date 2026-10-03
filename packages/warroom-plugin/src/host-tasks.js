// Service-owned scheduler. Tool executions register durable work and own no tail Promise.
import { createHash, randomUUID } from 'node:crypto';
import { isTerminal, canTransition, validateReceipt } from '../../shared-types/src/index.js';

/**
 * 派发宽限：dispatch 已尝试、适配器尚未上报 running 的连续 tick 数。
 * background 派发后命令仍是 queued（等首次 observe），立刻标 unknown 会造成
 * queued→unknown→running 的状态抖动；daemon 侧 50ms 观察者会看到瞬时 unknown。
 * 连续 UNKNOWN_GRACE_TICKS 个 tick（默认 100ms tick ≈ 500ms）仍无进展才标 unknown。
 */
const UNKNOWN_GRACE_TICKS = 5;

export class HostTaskRunner {
  constructor({ broker, delivery, intervalMs = 100 }) {
    this.broker = broker;
    this.delivery = delivery;
    this.intervalMs = intervalMs;
    this.closed = false;
    this.active = null;
    this.timer = null;
    this._unknownGrace = new Map(); // command_id -> 连续 grace tick 计数（内存态，重启即重置为重新宽限）
  }

  start() {
    if (this.closed || this.timer) return;
    const schedule = (delay) => {
      this.timer = setTimeout(async () => {
        this.timer = null;
        try { await this.tick(); } catch (e) { this._error(e); }
        if (!this.closed) schedule(this.intervalMs);
      }, delay);
      this.timer.unref?.();
    };
    schedule(0);
  }

  tick() {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = Promise.resolve().then(() => this._tick()).finally(() => { this.active = null; });
    return this.active;
  }

  async dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  _error(e) {
    this.broker.global.prepare(`INSERT INTO op_log (op_id, kind, state, detail, ts)
      VALUES (?, 'host_task_error', 'unresolved', ?, ?)`).run(randomUUID(), e.code ?? 'HOST_OBSERVER_ERROR', new Date().toISOString());
  }

  _owner(command_id) {
    return this.broker.global.prepare(`SELECT o.*, r.request_id AS stop_request_id FROM task_owners o
      JOIN command_queue c USING(command_id)
      LEFT JOIN task_cancellations r ON r.command_id = o.command_id AND r.generation = c.generation
      WHERE o.command_id = ?`).get(command_id);
  }

  _authorized(cmd, owner) {
    try {
      this.broker.assertHostAuthorization(cmd, owner);
      return true;
    } catch { return false; }
  }

  _attach(cmd) {
    if (this.broker.adapter.lookup(cmd.command_id)) return true;
    return !!this.broker.adapter.hydrate?.(cmd.command_id, JSON.parse(cmd.contract), cmd.state);
  }

  _notice(cmd, state, event_seq) {
    const id = createHash('sha256').update(JSON.stringify([cmd.command_id, cmd.generation, event_seq, state])).digest('hex');
    this.broker.global.prepare(`INSERT OR IGNORE INTO task_notifications
      (notice_id, command_id, generation, event_seq, state, ts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`warroom-${id}`, cmd.command_id, cmd.generation, event_seq, state, new Date().toISOString());
  }

  _manifest(cmd, { available = true, stopping = false, stop_request_id } = {}) {
    const db = this.broker.global;
    const current = available ? this.broker.adapter.manifestOf(cmd.task_id,
      { stopping, stop_request_id, generation: cmd.generation }) ?? [] : [];
    for (const resource of current) {
      if (typeof resource.id !== 'string' || !resource.id || typeof resource.kind !== 'string' || !resource.kind) {
        throw Object.assign(new Error('resource identity missing'), { code: 'E_RESOURCE_IDENTITY' });
      }
      db.prepare('INSERT OR IGNORE INTO task_resources (command_id, generation, resource_id, kind) VALUES (?, ?, ?, ?)')
        .run(cmd.command_id, cmd.generation, resource.id, resource.kind);
    }
    return db.prepare('SELECT resource_id, kind FROM task_resources WHERE command_id = ? AND generation = ?')
      .all(cmd.command_id, cmd.generation).map((r) => ({ id: r.resource_id, kind: r.kind,
        check: current.find((m) => m.id === r.resource_id && m.kind === r.kind)?.check ?? (() => false) }));
  }

  _stateNotice(cmd, state, event_seq) {
    const db = this.broker.global;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.broker._setCommandState(cmd.command_id, state);
      this._notice(cmd, state, event_seq);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  _stop(cmd, owner) {
    if (!owner.dispatch_attempted) {
      this._stateNotice(cmd, 'cancelled', 0);
      return;
    }
    let attached = false;
    try { attached = this._attach(cmd); } catch (e) { this._error(e); }
    // Capture known identities before propagating stop invalidates older evidence.
    try { this._manifest(cmd, { available: attached }); } catch (e) { this._error(e); }
    if (attached && !owner.stop_attempted) {
      // Persist before propagation; a restart only observes, never repeats a stop action.
      this.broker.global.prepare('UPDATE task_owners SET stop_attempted = 1 WHERE command_id = ?').run(cmd.command_id);
      try { this.broker.adapter.cancel(cmd.task_id, 'host cancel requested', { request_id: owner.stop_request_id }); }
      catch (e) { this._error(e); }
    }
    let manifest = [];
    try { manifest = this._manifest(cmd, { available: attached, stopping: true, stop_request_id: owner.stop_request_id }); }
    catch (e) { this._error(e); }
    const proven = manifest.map((m) => {
      let stopped = false;
      try { stopped = m.check() === true; } catch (e) { this._error(e); }
      return { id: m.id, kind: m.kind, stopped };
    });
    const next = proven.length > 0 && proven.every((m) => m.stopped) ? 'confirmed_stopped' : 'unresolved';
    if (cmd.state !== next) this.broker._gate(cmd.engagement_id, 'host_stop_proof', { task_id: cmd.task_id, state: next, manifest: proven });
    this._stateNotice(cmd, next, next === 'unresolved' ? 0 : -1);
  }

  _observe(cmd, owner) {
    const event = this.broker.adapter.observe?.(cmd.task_id);
    if (!event || typeof event.generation !== 'string' || event.generation !== cmd.generation ||
        !Number.isSafeInteger(event.event_seq) || event.event_seq <= owner.last_event_seq) return;
    // Cancellation cannot be converted to success by a late runtime event.
    if (owner.cancel_requested || isTerminal(cmd.state)) return;
    if (!['running', 'unknown', 'done', 'partial', 'failed'].includes(event.state)) return;
    if (['done', 'partial'].includes(event.state)) {
      if (event.receipt?.generation !== event.generation) return;
      validateReceipt(event.receipt);
      const collected = this.broker.collectHostObservation(cmd.engagement_id, cmd.task_id, event);
      if (!collected.accepted) return;
    }
    const db = this.broker.global;
    db.exec('BEGIN IMMEDIATE');
    try {
      // A missed running event can leave queued at terminal observation.
      if (cmd.state === 'queued' && ['done', 'partial', 'failed'].includes(event.state)) {
        this.broker._setCommandState(cmd.command_id, 'running');
      }
      if (event.state !== this.broker._findCommand(cmd.task_id).state &&
          !canTransition(this.broker._findCommand(cmd.task_id).state, event.state)) {
        db.exec('ROLLBACK'); return;
      }
      this.broker._setCommandState(cmd.command_id, event.state);
      db.prepare('UPDATE task_owners SET last_event_seq = ? WHERE command_id = ?').run(event.event_seq, cmd.command_id);
      if (isTerminal(event.state)) this._notice(cmd, event.state, event.event_seq);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  async _tick() {
    const db = this.broker.global;
    const rows = db.prepare('SELECT c.* FROM command_queue c JOIN task_owners o USING(command_id)').all();
    for (let cmd of rows) {
      if (this.closed) return;
      try {
        let owner = this._owner(cmd.command_id);
        if (isTerminal(cmd.state)) { this._unknownGrace.delete(cmd.command_id); continue; }
        // Legacy aliases must fail closed before authorization, cancellation or adapter access.
        cmd = this.broker._findCommand(cmd.command_id);
        if (!this._authorized(cmd, owner) && !owner.cancel_requested) {
          this.broker.cancel(cmd.engagement_id, cmd.task_id, 'authorization revoked or expired');
          owner = this._owner(cmd.command_id); cmd = this.broker._findCommand(cmd.task_id);
        }
        if (owner.cancel_requested) { this._unknownGrace.delete(cmd.command_id); this._stop(cmd, owner); continue; }
        if (cmd.state === 'queued' && !owner.dispatch_attempted) {
          this.broker.dispatchQueued(cmd.command_id);
          this._unknownGrace.delete(cmd.command_id);
        } else if (cmd.state === 'queued') {
          // 派发已尝试但适配器尚未上报 running：给宽限，连续多个 tick 仍无进展才标 unknown，
          // 并打 dispatch_unknown 门闸日志（与 broker.dispatchQueued 异常路径的 code 对齐）。
          const n = (this._unknownGrace.get(cmd.command_id) ?? 0) + 1;
          if (n >= UNKNOWN_GRACE_TICKS) {
            this._unknownGrace.delete(cmd.command_id);
            this.broker._setCommandState(cmd.command_id, 'unknown');
            this.broker._gate(cmd.engagement_id, 'dispatch_unknown',
              { task_id: cmd.task_id, reason: 'no adapter progress within grace period after dispatch' });
          } else {
            this._unknownGrace.set(cmd.command_id, n);
          }
        } else {
          this._unknownGrace.delete(cmd.command_id);
        }
        cmd = this.broker._findCommand(cmd.task_id);
        owner = this._owner(cmd.command_id);
        if (owner.dispatch_attempted && !isTerminal(cmd.state) && this._attach(cmd)) {
          this._manifest(cmd);
          this._observe(cmd, owner);
        }
      } catch (e) { this._error(e); }
    }
    const pending = db.prepare("SELECT * FROM task_notifications WHERE delivery_state = 'pending' ORDER BY rowid").all();
    for (const notice of pending) {
      if (this.closed) return;
      try {
        const cmd = this.broker._findCommand(notice.command_id);
        const owner = this._owner(notice.command_id);
        const valid = () => {
          const current = this.broker._findCommand(notice.command_id);
          const own = this._owner(notice.command_id);
          return !this.closed && current.generation === notice.generation &&
            (!['done', 'partial', 'failed'].includes(notice.state) ||
              (!own.cancel_requested && this._authorized(current, own)));
        };
        if (!valid()) {
          db.prepare("UPDATE task_notifications SET delivery_state = 'blocked', detail = 'generation or authorization changed' WHERE notice_id = ?").run(notice.notice_id);
          continue;
        }
        const result = await this.delivery.deliver(owner, { ...notice, task_id: cmd.task_id }, valid);
        if (this.closed) return;
        if (result?.status === 'delivered' || result?.status === 'blocked') {
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('UPDATE task_notifications SET delivery_state = ? WHERE notice_id = ?').run(result.status, notice.notice_id);
            // A pending notice may already be accepted. Keep its replay evidence until all acknowledgements settle.
            if (result.status === 'delivered') db.prepare(`UPDATE task_owners SET delivery_cursor = ? WHERE command_id = ?
              AND NOT EXISTS (SELECT 1 FROM task_notifications WHERE command_id = ? AND delivery_state = 'pending')`)
              .run(result.cursor ?? owner.delivery_cursor, notice.command_id, notice.command_id);
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
        }
      } catch (e) { this._error(e); }
    }
  }
}
