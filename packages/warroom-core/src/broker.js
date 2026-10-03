// Broker：唯一副作用通道（ADR-001 D1/D2）+ 命令队列 + 撤销级联 + 代际收集（ADR-003）。
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import {
  validateFourTuple, validateContract, validateReceipt, RHYTHM_CONCURRENCY, RHYTHM_WIRE_CAP,
  RHYTHM_MIN_INTERVAL_MS, RHYTHM_JITTER_MS, RHYTHM_HOURLY_DRIFT,
  warroomError, ERR, canTransition, isTerminal, makeGeneration,
  ALL_TASK_STATES, ACTION_CLASS,
} from '../../shared-types/src/index.js';
import { checkAgainstAuth, buildAuthObject, approvalFingerprint, contractFingerprint, contractAddressKeys, addressKey } from './gates.js';
import { join } from 'node:path';
import { assertSafeSegment, resolveUnder } from './paths.js';
import { openEngagementDb, openGlobalDb } from './db.js';
import { FactStore } from './store.js';
import { FakeAdapter } from './adapters/fake.js';
import { SecretVault } from './secrets.js';
import { KnowledgeBase } from './knowledge.js';
import { loadConfig } from './config.js';
import { preflight } from './preflight.js';
import { buildTimeline } from './timeline.js';
import { buildWatch, buildFleetWatch } from './watch.js';
import { buildRateView } from './rate-view.js';
import { buildChecklist, renderChecklist, recordConfirmation } from './checklist.js';
import { buildWeekly, archiveWeekly } from './weekly.js';
import { backupHome } from './maintenance.js';
import { redactDeep } from './redactor.js';
import { exportReport as exportReportFile, buildReport, verifyReportAgainstStore } from './report.js';
import { exportEvidence } from './evidence.js';
import { validateParent } from './task-ledger.js';

const now = () => new Date().toISOString();

export class Broker {
  /**
   * @param {{home:string, adapter?:object, nowMs?:()=>number}} opts
   */
  constructor({ home, adapter, nowMs, rng } = {}) {
    this.home = home;
    this.global = openGlobalDb(home);
    this.secrets = new SecretVault({ root: join(home, 'secrets'), db: this.global, nowMs: () => this._nowMs() });
    this.knowledge = new KnowledgeBase({ home });
    this.adapter = adapter ?? new FakeAdapter();
    this._nowMs = nowMs ?? (() => Date.now());
    this._rng = rng ?? Math.random;   // 可注入：测试需要确定性抖动
    // 家目录配置：默认节奏档/超时等（非法配置直接抛错，不静默忽略）
    this.config = loadConfig(home);
    this.engagements = new Map(); // engagement_id -> { db, store }
    this.dispatchCounter = 0;
  }

  // ── 授权（开工指令即授权：宿主冻结对象，ADR-001 D3）─────────────────────────
  createEngagement({ user_message_id, targets, overrides, engagement_id } = {}) {
    const mergedOverrides = { rhythm: this.config.rhythm, ...(overrides ?? {}) };
    const { auth_object, auth_hash } = buildAuthObject({ user_message_id, targets, overrides: mergedOverrides });
    const id = assertSafeSegment(engagement_id ?? `eng_${randomUUID()}`, 'engagement_id');
    const dir = resolveUnder(this.home, 'engagements', id);
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
    const id = assertSafeSegment(engagementId, 'engagement_id');
    if (!this.engagements.has(id)) {
      const db = openEngagementDb(resolveUnder(this.home, 'engagements', id));
      this.engagements.set(id, { db, store: new FactStore(db, id) });
    }
    return this.engagements.get(id);
  }

  _auth(engagementId) {
    const row = this._eng(engagementId).db
      .prepare('SELECT * FROM engagements WHERE id = ?').get(engagementId);
    if (!row) throw warroomError(ERR.E_TASK_NOT_FOUND, `engagement ${engagementId} not found`);
    return { row, auth: JSON.parse(row.auth_object) };
  }

  // ── 执行（唯一副作用通道）────────────────────────────────────────────────────
  execute(req = {}, { deferDispatch = false, parent } = {}) {
    if (deferDispatch) {
      validateParent(parent);
      // Deferred work has no public collect fallback: refuse before any durable registration or reservation.
      if (typeof this.adapter.observe !== 'function' || this.adapter.supportsBackgroundObservation === false) {
        throw Object.assign(new Error('adapter does not support host background observation'),
          { code: 'E_HOST_OBSERVATION_UNSUPPORTED' });
      }
    }
    // 契约形态 → broker 预分配 task_id → 四元组全量校验（ADR-001 D2）
    validateContract(req.contract);
    // command_id 是派发幂等键（ADR-003 D1）：先持久化后派发、可按 ID 找回。
    // broker 是服务端唯一副作用通道，必须在此自证，而非依赖 agent 侧工具 schema。
    // 缺失 → 后续 command_queue 绑定抛不透明错误；空串 → 不同命令误判去重为同一任务。
    if (typeof req.command_id !== 'string' || req.command_id === '') {
      throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'command_id required (dispatch idempotency key, ADR-003 D1)');
    }
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

    // An idempotent request consumes no second reservation or approval.
    const existing = this.global.prepare('SELECT * FROM command_queue WHERE command_id = ?').get(req.command_id);
    if (existing) {
      return this._acknowledgeCommand(existing, req, { deferDispatch, parent });
    }

    // 命令先持久化，后派发（ADR-003 D1：派发幂等）
    let generation, contract, approval = null;
    this.global.exec('BEGIN IMMEDIATE');
    try {
    // A second Broker may have committed while the initial read was in flight.
    // Recheck under SQLite's writer lock; same-command retries remain idempotent.
    const raced = this.global.prepare('SELECT * FROM command_queue WHERE command_id = ?').get(req.command_id);
    if (raced) {
      const result = this._acknowledgeCommand(raced, req, { deferDispatch, parent });
      this.global.exec('COMMIT');
      return result;
    }
    // Resolve the common task/command namespace only after same-command retries,
    // under this writer lock, before any approval, rate reservation or dispatch.
    const racedAlias = this.global.prepare(`SELECT command_id FROM command_queue
      WHERE task_id = ? OR command_id = ? OR task_id = ? LIMIT 1`)
      .get(task_id, task_id, req.command_id);
    if (racedAlias) throw warroomError(ERR.E_APPROVAL_MISMATCH, 'task or command identity is already bound');

    // 节奏闸（ADR-002 D10 / 框架 §4）：并发 / wire 预算 / 最小间隔
    this._checkRhythm({ engagementId: req.engagement_id, rhythm: row.rhythm, contract: req.contract, store });

    // Approval consumption and identity registration share the same transaction.
    generation = makeGeneration(row.auth_version, this.dispatchCounter + 1, 1);
    contract = { ...req.contract, task_id, generation, engagement_id: req.engagement_id };
    if (req.contract.action_class === 'destructive') {
      approval = this._consumeApproval(req.manual_approval_token, req.engagement_id, contract, req.command_id);
    }
    ++this.dispatchCounter;
    this.global.prepare(`INSERT INTO command_queue
      (command_id, engagement_id, task_id, contract, state, generation, attempt, ts)
      VALUES (?, ?, ?, ?, 'queued', ?, 1, ?)`).run(
      req.command_id, req.engagement_id, task_id, JSON.stringify(contract), generation, now()
    );
    if (deferDispatch) {
      this.global.prepare(`INSERT INTO task_owners
        (command_id, parent_session_id, parent_created_at, auth_version, approval_id)
        VALUES (?, ?, ?, ?, ?)`).run(req.command_id, parent.session_id, parent.created_at,
          req.auth_version, req.manual_approval_token ?? null);
    }
    this.global.exec('COMMIT');
    } catch (e) { this.global.exec('ROLLBACK'); throw e; }
    store.appendGateLog({
      decision: 'allow', code: 'BROKER_EXECUTE',
      detail: `class=${contract.action_class} action=${contract.action ?? '(未声明)'}`
        + (approval ? ` approval=${approval.approval_id} bound=${String(approval.contract_hash).slice(0, 12)}` : ''),
      request: this.secrets.redact(JSON.stringify({ command_id: req.command_id, task_id })),
    });

    // 计量：tool_calls 每次执行 +1；wire_requests 由契约声明（ADR-002 D10）
    store.recordRate({ target: contract.targets[0], kind: 'tool', amount: 1 });
    if (contract.wire_cost) store.recordRate({ target: contract.targets[0], kind: 'wire', amount: contract.wire_cost });

    if (deferDispatch) {
      this.global.prepare('UPDATE task_owners SET registration_ready = 1 WHERE command_id = ?').run(req.command_id);
      return { command_id: req.command_id, task_id, generation, state: 'queued' };
    }

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
        return {
          command_id: req.command_id, task_id: found?.task_id ?? task_id, state,
          generation, recoverable: true,
        };
      }
      this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?').run('failed', req.command_id);
      store.appendGateLog({ decision: 'deny', code: e.code ?? 'ADAPTER_ERROR', detail: String(e.message) });
      throw e;
    }
  }

  /** Host scheduler's first dispatch only. A lost attempt is never retried. */
  dispatchQueued(command_id) {
    const cmd = this._findCommand(command_id);
    const owner = this.global.prepare('SELECT * FROM task_owners WHERE command_id = ?').get(command_id);
    if (!cmd || !owner || cmd.state !== 'queued' || owner.cancel_requested) return;
    if (owner.dispatch_attempted || !owner.registration_ready) {
      this._setCommandState(command_id, 'unknown');
      return;
    }
    const contract = JSON.parse(cmd.contract);
    try {
      this.assertHostAuthorization(cmd, owner);
      if ((contract.wire_cost ?? 0) > 0) this.assertEgressVerified(cmd.engagement_id);
    } catch (e) {
      // Leave a durable nonterminal cancellation for the host's atomic stop/outbox path.
      this.cancel(cmd.engagement_id, cmd.task_id, 'dispatch gate invalid');
      this._gate(cmd.engagement_id, 'dispatch_revoked', { task_id: cmd.task_id, code: e.code });
      return;
    }
    this.global.prepare('UPDATE task_owners SET dispatch_attempted = 1 WHERE command_id = ?').run(command_id);
    try {
      const r = this.adapter.dispatch(command_id, contract);
      const state = r?.state === 'running' ? 'running' : 'queued';
      this._setCommandState(command_id, state);
    } catch (e) {
      this._setCommandState(command_id, 'unknown');
      this._gate(cmd.engagement_id, 'dispatch_unknown', { task_id: cmd.task_id, code: e.code ?? 'ADAPTER_ERROR' });
    }
  }

  assertHostAuthorization(cmd, owner) {
    const { row, auth } = this._auth(cmd.engagement_id);
    if (!ACTION_CLASS.includes(auth.action_class_limit)) {
      throw warroomError(ERR.E_GATE_CLASS_EXCEEDS_LIMIT, 'authorization action_class_limit invalid');
    }
    const nowMs = this._nowMs();
    const start = Date.parse(auth.window_start), end = Date.parse(auth.window_end);
    if (![nowMs, start, end].every(Number.isFinite) || start > end) {
      throw warroomError(ERR.E_GATE_WINDOW_CLOSED, 'authorization window or clock invalid');
    }
    checkAgainstAuth({ auth: { ...auth, auth_version: row.auth_version }, auth_version: owner.auth_version,
      nowMs, contract: JSON.parse(cmd.contract), manual_approval_token: owner.approval_id });
    if (JSON.parse(cmd.contract).action_class === 'destructive') {
      const approval = this.global.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(owner.approval_id);
      if (!approval || approval.engagement_id !== cmd.engagement_id || Date.parse(approval.expires_at) <= this._nowMs()) {
        throw warroomError(ERR.E_APPROVAL_EXPIRED, 'queued host approval expired or unavailable');
      }
      // 复核：这张批准必须正是**为这条命令、这个动作**签发的（防"批条被换给别的命令"）
      if (!approval.contract_hash || approval.contract_hash !== contractFingerprint(JSON.parse(cmd.contract))) {
        throw warroomError(ERR.E_APPROVAL_MISMATCH, 'queued host approval does not match this command');
      }
      if (approval.used_by_command !== cmd.command_id) {
        throw warroomError(ERR.E_APPROVAL_MISMATCH, 'queued host approval was consumed by another command');
      }
    }
  }

  /**
   * 资源收口实测（ADR-003 D4 / ADR-009）：清单里仍**未被证实停止**的资源 id。
   *
   * `observable:false` = 观测不到清单（适配器不认识这个任务）——此时不据此声称已收口，
   * 但也不把"观测不到"当成"未收口"去阻塞既有语义。
   */
  _liveResources(cmd) {
    if (typeof this.adapter.manifestOf !== 'function') return { observable: false, total: 0, live: [] };
    if (typeof this.adapter.hydrate === 'function' && typeof this.adapter.lookup === 'function' && !this.adapter.lookup(cmd.command_id)) {
      // 宿主重启后适配器可能没装载这个任务：先按持久化契据补水，再探
      try { this.adapter.hydrate(cmd.command_id, JSON.parse(cmd.contract), cmd.state); } catch { return { observable: false, total: 0, live: [] }; }
    }
    let manifest;
    try { manifest = this.adapter.manifestOf(cmd.task_id, { generation: cmd.generation }); } catch { return { observable: false, total: 0, live: [] }; }
    if (!Array.isArray(manifest)) return { observable: false, total: 0, live: [] };
    const live = [];
    for (const m of manifest) {
      let stopped = false;
      try { stopped = m.check() === true; } catch { stopped = false; }
      if (!stopped) live.push(m.id);
    }
    return { observable: true, total: manifest.length, live };
  }

  // ── 取消与证实（ADR-003 D4：资源清单逐项证实，账本不算证明）──────────────────
  cancel(engagement_id, taskIdOrCommandId, reason = 'manual') {
    const cmd = this._findCommand(taskIdOrCommandId);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${taskIdOrCommandId} not found`);
    if (cmd.engagement_id !== engagement_id) throw warroomError(ERR.E_APPROVAL_MISMATCH, 'task belongs to another engagement');
    if (isTerminal(cmd.state)) {
      // 终态 ≠ 资源已收口（ADR-009）：清单里还有活着的资源时，取消请求必须把停止动作真的发下去，
      // 否则"任务已完成"会永久盖住仍在跑的后台子进程（症状：取消直接回"已结束"，谁也没去停它）。
      const liveness = this._liveResources(cmd);
      if (!liveness.observable || liveness.live.length === 0) {
        return { task_id: cmd.task_id, state: cmd.state, terminal: true, live: [] };
      }
      this._gate(engagement_id, 'cancel_after_terminal',
        { task_id: cmd.task_id, state: cmd.state, live: liveness.live });
      // 落到下面的取消流程收口：host 任务重新打开 cancel_requested 交宿主 tick 逐项证实；
      // 非 host 任务就地探针收口。收口结果按 ADR-003：全证实 → confirmed_stopped，否则 unresolved。
    }

    const owner = this.global.prepare('SELECT * FROM task_owners WHERE command_id = ?').get(cmd.command_id);
    if (owner) {
      this.global.exec('BEGIN IMMEDIATE');
      try {
        this.global.prepare('INSERT OR IGNORE INTO task_cancellations (command_id, generation, request_id) VALUES (?, ?, ?)')
          .run(cmd.command_id, cmd.generation, randomUUID());
        this.global.prepare('UPDATE task_owners SET cancel_requested = 1 WHERE command_id = ?').run(cmd.command_id);
        this.global.prepare("UPDATE command_queue SET state = 'cancel_requested' WHERE command_id = ?").run(cmd.command_id);
        this.global.exec('COMMIT');
      } catch (e) { this.global.exec('ROLLBACK'); throw e; }
      return { task_id: cmd.task_id, state: 'cancel_requested' };
    }

    this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?')
      .run('cancel_requested', cmd.command_id);
    // 停止身份（ADR-009）：同步路径也必须带可核对的 request_id，否则应答器无法把"停止"证实成
    // confirmed_stopped（只能落 unresolved）。以前不给 id，落证据这一步永远欠着一口气。
    const stopRequestId = randomUUID();
    this.adapter.cancel(cmd.task_id, reason, { request_id: stopRequestId });

    const manifest = this.adapter.manifestOf(cmd.task_id,
      { stopping: true, stop_request_id: stopRequestId, generation: cmd.generation }) ?? [];
    // 每个资源条目只探针一次（ADR-003 D4）：check() 是对运行资源的实测（PID/端口/容器 inspect），
    // 重复探针既浪费又会造成 TOCTOU 不一致（同一次取消内资源状态变化导致记账与返回自相矛盾）。
    const probed = manifest.map((m) => ({ id: m.id, kind: m.kind, confirmed: m.check() }));
    const allConfirmed = probed.length > 0 && probed.every((m) => m.confirmed);
    if (allConfirmed) {
      this._setCommandState(cmd.command_id, 'confirmed_stopped');
      this._gate(engagement_id, 'stop_confirmed', { task_id: cmd.task_id, manifest: probed.map((m) => m.id) });
      return { task_id: cmd.task_id, state: 'confirmed_stopped', manifest: probed.filter((m) => m.confirmed) };
    }
    // 任一资源未证实 → unresolved（人工队列），op_log 记录隔离项
    for (const m of probed.filter((x) => !x.confirmed)) {
      this.global.prepare(`INSERT INTO op_log (op_id, kind, ref_id, state, detail, ts)
        VALUES (?, 'resource_unconfirmed', ?, 'quarantined', ?, ?)`)
        .run(randomUUID(), m.id, `${m.kind} not confirmed for ${cmd.task_id}`, now());
    }
    this._setCommandState(cmd.command_id, 'unresolved');
    return { task_id: cmd.task_id, state: 'unresolved', manifest: probed };
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
    return this.#collect(engagement_id, task_id, receipt);
  }

  /** Host-only ingestion; this method has no model-visible tool or trusted argument. */
  collectHostObservation(engagement_id, task_id, event) {
    return this.#collect(engagement_id, task_id, event.receipt, event);
  }

  #collect(engagement_id, task_id, receipt, event = null) {
    validateReceipt(receipt);
    const cmd = this._findCommand(task_id);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${task_id} not found`);
    if (cmd.engagement_id !== engagement_id) throw warroomError(ERR.E_APPROVAL_MISMATCH, 'task belongs to another engagement');
    const { store } = this._eng(engagement_id);
    const instance = this.adapter.instanceId ?? 'adapter-1';
    const owner = this.global.prepare('SELECT * FROM task_owners WHERE command_id = ?').get(cmd.command_id);
    if (owner) {
      if (!event || !owner.registration_ready || !owner.dispatch_attempted || isTerminal(cmd.state) ||
          !['done', 'partial'].includes(event.state) || event.generation !== cmd.generation ||
          !Number.isSafeInteger(event.event_seq) || event.event_seq <= owner.last_event_seq) {
        return { accepted: false, quarantined: 'host_observation' };
      }
      let authorized = !owner.cancel_requested;
      try { this.assertHostAuthorization(cmd, owner); } catch { authorized = false; }
      if (!authorized) return { accepted: false, quarantined: 'authorization' };
    }
    if (receipt.generation !== cmd.generation) {
      store.quarantineStaleGeneration({ adapterInstance: instance, members: receipt.members, generation: receipt.generation });
      this._gate(engagement_id, 'collect', { task_id: cmd.task_id, accepted: false, quarantined: 'generation' });
      return { accepted: false, quarantined: 'generation' };
    }
    const r = store.ingestMembers({ adapterInstance: instance, members: receipt.members, generation: receipt.generation });
    // 留时间戳：效率四段观测（§11）需要"交接/执行"分段的实测边界
    this._gate(engagement_id, 'collect', { task_id: cmd.task_id, accepted: true, seq: r.seq });
    return { accepted: true, seq: r.seq, results: redactDeep(r.results, this.secrets.values()) };
  }

  // ── 效率遥测（ADR-002 D10：预算不是门闸，效率才是目标）──────────────────────
  recordMetrics(engagementId, commandId, { tokens_in = 0, tokens_out = 0, wall_time_ms = 0, verified_facts = 0, role = null, model_tier = null } = {}) {
    const cmd = this.global.prepare('SELECT * FROM command_queue WHERE command_id = ?').get(commandId);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `command ${commandId} not found`);
    if (cmd.engagement_id !== engagementId) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH, 'command 不属于该战役');
    }
    this.global.prepare(`INSERT INTO task_metrics
      (command_id, engagement_id, task_id, role, model_tier, tokens_in, tokens_out, wall_time_ms, verified_facts, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(command_id) DO UPDATE SET
        tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
        wall_time_ms = excluded.wall_time_ms, verified_facts = excluded.verified_facts,
        role = excluded.role, model_tier = excluded.model_tier, ts = excluded.ts`).run(
      commandId, engagementId, cmd.task_id, role, model_tier, tokens_in, tokens_out, wall_time_ms, verified_facts, now());
    return this.metrics(engagementId);
  }

  /**
   * 效率聚合（ADR-002 D10 / 框架 §2 原则 8、§11）：
   * 主指标是**端到端可验收完成时间**与**返工率**，不是成本比；按角色与模型档位分桶，
   * 供"谁干得快、哪个档位划算"的编制决策使用（无成本门闸）。
   */
  metrics(engagementId) {
    const rows = this.global.prepare('SELECT * FROM task_metrics WHERE engagement_id = ?').all(engagementId);
    const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    const store = this._eng(engagementId).store;
    const effective = store.effectiveCount();
    const tokens = sum('tokens_in') + sum('tokens_out');
    const wall = sum('wall_time_ms');
    const verified = sum('verified_facts');

    // 返工：同一任务被重派（attempt > 1）即计一次返工
    const cmds = this.global.prepare(
      'SELECT command_id, task_id, attempt, state, ts FROM command_queue WHERE engagement_id = ?'
    ).all(engagementId);   // ts 必须取：四段观测的"派发时刻"基准
    const reworked = cmds.filter((c) => (c.attempt ?? 1) > 1);
    const unresolved = cmds.filter((c) => c.state === 'unresolved');
    const unknown = cmds.filter((c) => c.state === 'unknown');

    const byRole = {};
    const byTier = {};
    const bucket = (acc, key) => {
      acc[key] = acc[key] ?? { tasks: 0, tokens: 0, verified: 0, wall_time_ms: 0 };
      return acc[key];
    };
    for (const r of rows) {
      const role = bucket(byRole, r.role ?? 'unknown');
      role.tasks += 1; role.tokens += r.tokens_in + r.tokens_out;
      role.verified += r.verified_facts; role.wall_time_ms += r.wall_time_ms;
      const tier = bucket(byTier, r.model_tier ?? 'untagged');
      tier.tasks += 1; tier.tokens += r.tokens_in + r.tokens_out;
      tier.verified += r.verified_facts; tier.wall_time_ms += r.wall_time_ms;
    }
    for (const bucketMap of [byRole, byTier]) {
      for (const v of Object.values(bucketMap)) {
        v.facts_per_1000_tokens = v.tokens > 0 ? Number(((v.verified / v.tokens) * 1000).toFixed(3)) : null;
        v.ms_per_verified_fact = v.verified > 0 ? Math.round(v.wall_time_ms / v.verified) : null;
      }
    }

    return {
      // 端到端视角
      segments: this._segments(engagementId, cmds, store),
      tasks: rows.length,
      commands: cmds.length,
      tokens_in: sum('tokens_in'), tokens_out: sum('tokens_out'),
      wall_time_ms: wall,
      verified_facts: verified,
      effective_facts: effective,
      facts_per_1000_tokens: tokens > 0 ? Number(((effective / tokens) * 1000).toFixed(3)) : null,
      ms_per_fact: effective > 0 ? Math.round(wall / effective) : null,
      // 返工与未决（效率的真实敌人）
      rework: {
        tasks_with_retry: reworked.length,
        retry_rate: cmds.length > 0 ? Number((reworked.length / cmds.length).toFixed(3)) : null,
        unresolved: unresolved.length,
        unknown: unknown.length,
      },
      by_role: byRole,
      by_tier: byTier,
    };
  }

  // ── shell 状态与喷洒（战役内，经 store；agent 侧只经工具调用）────────────────
  shell(engagementId) {
    return this._eng(engagementId).store.shellState();
  }
  recordShellProof(engagementId, { proof, evidence_ref }) {
    return this._eng(engagementId).store.recordShellProof({ proof, evidence_ref });
  }
  verifyShell(engagementId, { validity, evidence_ref }) {
    return this._eng(engagementId).store.verifyShell({ validity, evidence_ref });
  }
  sprayCheck(engagementId, { credential_ref, service, account }) {
    const store = this._eng(engagementId).store;
    return {
      locked: store.sprayLocked({ service, account }),
      tried: store.sprayTried({ credential_ref, service, account }),
    };
  }
  /**
   * 喷洒矩阵（框架 §5.1）：把「凭据 × 服务 × 账号」展开成可执行的格子，
   * 每格带断点与锁定状态——已试过/已锁定的格子不出现在 plan.ready 中（防重复、防锁死）。
   * @param {{credentials:string[], services:string[], accounts:string[]}} p
   */
  sprayMatrix(engagementId, { credentials = [], services = [], accounts = ['default'] } = {}) {
    const store = this._eng(engagementId).store;
    const cells = [];
    for (const credential_ref of credentials) {
      for (const service of services) {
        for (const account of accounts) {
          const tried = store.sprayTried({ credential_ref, service, account });
          const locked = store.sprayLocked({ service, account });
          cells.push({
            credential_ref, service, account,
            tried, locked,
            action: locked ? 'skip-locked' : tried ? 'skip-tried' : 'run',
          });
        }
      }
    }
    const ready = cells.filter((c) => c.action === 'run');
    return {
      cells,
      ready,
      summary: {
        cells: cells.length,
        run: ready.length,
        skip_tried: cells.filter((c) => c.action === 'skip-tried').length,
        skip_locked: cells.filter((c) => c.action === 'skip-locked').length,
      },
    };
  }

  /**
   * 批量登记矩阵执行结果：只接受 ready 格子（未试过、未锁定）；
   * locked 结果会立即把该(服务×账号)的后续格子转为跳过（防锁死扩散）。
   */
  sprayApply(engagementId, results = []) {
    const applied = [];
    const skipped = [];
    for (const r of results) {
      const check = this.sprayCheck(engagementId, r);
      if (check.locked) { skipped.push({ ...r, reason: 'locked' }); continue; }
      if (check.tried && r.result !== 'locked') { skipped.push({ ...r, reason: 'already-tried' }); continue; }
      this._eng(engagementId).store.sprayRecord({
        credential_ref: r.credential_ref, service: r.service, account: r.account, result: r.result,
      });
      applied.push({ ...r });
    }
    return { applied, skipped, summary: { applied: applied.length, skipped: skipped.length } };
  }

  sprayRecord(engagementId, args) {
    const store = this._eng(engagementId).store;
    const check = this.sprayCheck(engagementId, args);
    if (check.locked) throw warroomError(ERR.E_GATE_RATE_LIMIT, '该账号已锁定，禁止继续喷洒（防锁死）');
    store.sprayRecord(args);
    return { recorded: true, ...args };
  }

  // ── 报告导出（框架 §5：水位 + IOC 附录 + 脱敏）──────────────────────────────
  buildReport(engagementId, { maxFactsPerType = 50, audience = 'full' } = {}) {
    const { row, store } = this._engWithRow(engagementId);
    return buildReport({ store, engagementId, engagementRow: row, vault: this.secrets, globalDb: this.global,
      home: this.home, maxFactsPerType, audience, metrics: this.metrics(engagementId) });
  }

  /** 复现校验：给定报告正文，对照当前库判定是否仍可复现。 */
  verifyReport(engagementId, markdown) {
    const { store } = this._engWithRow(engagementId);
    return verifyReportAgainstStore(markdown, store);
  }

  exportReport(engagementId, { outDir, format = 'md', maxFactsPerType = 50, audience = 'full' } = {}) {
    const { row, store } = this._engWithRow(engagementId);
    const dir = outDir ?? resolveUnder(this.home, 'engagements', engagementId, 'reports');
    return exportReportFile({
      store, engagementId, engagementRow: row, vault: this.secrets, globalDb: this.global, home: this.home,
      outDir: dir, format, maxFactsPerType, audience, metrics: this.metrics(engagementId),
    });
  }

  /**
   * 交付前一体化：导出报告后立刻用**同一判定**复核可复现性，把结论一并返回。
   * 动机：交付流程里"导出→校验"两步常被漏掉；合成一步，漏不掉。
   */
  exportReportVerified(engagementId, opts = {}) {
    const exported = this.exportReport(engagementId, opts);
    const markdown = readFileSync(exported.paths.markdown ?? exported.path, 'utf8');
    const { store } = this._eng(engagementId);
    const verdict = verifyReportAgainstStore(markdown, store);
    return {
      ...exported,
      verify: {
        reproducible: verdict.reproducible,
        report_seq: verdict.report.seq,
        current_seq: verdict.current.seq,
        drift_seq: verdict.drift.seq,
        checked_at: new Date().toISOString(),
      },
    };
  }

  /** 证据落盘：报告 + 水位 + 三段式 EVIDENCE_INDEX（明文秘密永不落盘）。 */
  exportEvidence(engagementId, { outDir, target = null, audiences = ['client', 'blue'], checklist = true } = {}) {
    const dir = outDir ?? resolveUnder(this.home, 'engagements', engagementId, 'evidence');
    return exportEvidence({ broker: this, engagementId, outDir: dir, target, audiences, checklist });
  }

  /**
   * 开工前预检（环境/配置/战役/出口/备份/秘密）——结论三态：ready|degraded|blocked。
   * @param {{meeting?:object, record?:boolean}} opts
   *   record=true 时把本次预检结论**写入审计**（谁在什么时候判定可开工/被阻塞，可追溯）
   */
  preflight(engagementId, { meeting = null, record = false } = {}) {
    const result = preflight({ broker: this, engagementId, home: this.home, meeting });
    let recorded = null;
    if (record) {
      this._gate(engagementId, 'preflight', {
        verdict: result.verdict,
        blockers: result.blockers,
        warnings_count: result.warnings.length,
        with_plan: !!meeting,
        bucket: this.config?.bucket ?? null,
      });
      recorded = { engagement_id: engagementId, verdict: result.verdict };
    }
    return { ...result, recorded };
  }

  /** 多战役周报（指挥层视角，只读）。 */
  weekly({ days = 7, now = null } = {}) {
    return buildWeekly({ broker: this, days, now: now ?? Date.now() });
  }

  /** 归档周报（按 ISO 周落盘，重复执行即覆盖为最新）。 */
  archiveWeekly({ days = 7, now = null } = {}) {
    return archiveWeekly({ broker: this, days, now: now ?? Date.now() });
  }

  /**
   * 一键交付：报告（md+json+html，含受众视图）→ 证据包（含交付清单）→ 备份 → **交付门禁判定**。
   * 返回一次跑完的产物路径 + 门禁结论；不做任何隐藏动作（每步都是前面已存在的公开接口）。
   */
  deliver(engagementId, { outDir = null, keep = 7, backup = true } = {}) {
    const base = outDir ?? resolveUnder(this.home, 'engagements', engagementId, 'evidence');
    const report = this.exportReportVerified(engagementId, { outDir: join(base, 'reports'), format: 'all' });
    const pack = this.exportEvidence(engagementId, { outDir: base, audiences: ['client', 'blue'], checklist: true });
    let backupResult = null;
    if (backup) backupResult = backupHome({ home: this.home, keep });
    // 清单必须看**交付包实际位置**（自定义 --out 时也要一致）
    const checklist = this.checklist(engagementId, {
      profile: 'delivery', reportsDir: join(base, 'reports'), evidenceDir: base,
    });
    return {
      engagement_id: engagementId,
      package_dir: base,
      reports: { markdown: report.paths.markdown, json: report.paths.json, html: report.paths.html },
      verify: report.verify,
      audience_files: pack.audience_files.map((a) => ({ audience: a.audience, markdown: a.markdown })),
      index: pack.files.index,
      checklist_file: pack.files.checklist,
      watermark: report.watermark,
      backup: backupResult ? { dest: backupResult.dest, ok: backupResult.ok, total: backupResult.total, pruned: backupResult.pruned } : null,
      gate: { profile: checklist.profile, deliverable: checklist.deliverable, blocked: checklist.blocked, done: checklist.done, total: checklist.total, manual: checklist.manual },
    };
  }

  /** 记录人工确认（谁/何时/结论）；只写审计，不改自动判定。 */
  confirmChecklistItem(engagementId, { itemId, by = null, note = '' }) {
    const { store } = this._eng(engagementId);
    const rec = recordConfirmation({ store, itemId, by, note });
    return { ...rec, engagement_id: engagementId };
  }

  /** 交付清单（验收项自动判定 + 人工确认项，只读）。 */
  checklist(engagementId, { profile = 'delivery', reportsDir = null, evidenceDir = null } = {}) {
    return buildChecklist({ broker: this, engagementId, profile, reportsDir, evidenceDir });
  }

  /** 交付清单落盘为交付附件（写进证据目录）。 */
  exportChecklist(engagementId, { outDir = null } = {}) {
    const c = this.checklist(engagementId);
    const dir = outDir ?? resolveUnder(this.home, 'engagements', engagementId, 'evidence');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'DELIVERY_CHECKLIST.md');
    writeFileSync(path, renderChecklist(c) + '\n', 'utf8');
    return { path, done: c.done, total: c.total, manual: c.manual };
  }

  /** 舰队视图（所有战役的巡检汇总，只读）。 */
  fleetWatch({ timeoutMin = null } = {}) {
    return buildFleetWatch({ broker: this, timeoutMin });
  }

  /** 速率与预算视图（wire 用量/预算/最小间隔/喷洒台账，只读）。 */
  rateView(engagementId) {
    return buildRateView({ broker: this, engagementId });
  }

  /** 巡检统一视图（路由/任务/出口/壳/告警，只读）。 */
  watch(engagementId, { timeoutMin = null } = {}) {
    return buildWatch({ broker: this, engagementId, timeoutMin });
  }

  /** 战役时序（账本事件的只读视图）。 */
  timeline(engagementId) {
    const { store } = this._eng(engagementId);
    return buildTimeline({ store, globalDb: this.global, engagementId });
  }

  /** 枚举家目录下的战役 id（用于跨战役巡检；库缺失即跳过）。 */
  listEngagements() {
    const dir = join(this.home, 'engagements');
    try {
      return readdirSync(dir).filter((n) => existsSync(join(dir, n, 'fact.db')));
    } catch { return []; }
  }

  _engWithRow(engagementId) {
    const eng = this._eng(engagementId);
    const row = eng.db.prepare('SELECT * FROM engagements WHERE id = ?').get(engagementId);
    return { row, store: eng.store };
  }

  // ── 节奏控制（ADR-002 D10）─────────────────────────────────────────────────
  _checkRhythm({ engagementId, rhythm, contract, store }) {
    const runningStates = "('queued','running','cancel_requested','unknown')";
    const running = this.global.prepare(
      `SELECT COUNT(*) AS c FROM command_queue WHERE engagement_id = ? AND state IN ${runningStates}`
    ).get(engagementId).c;
    const cap = RHYTHM_CONCURRENCY[rhythm] ?? 1;
    if (running >= cap) {
      throw warroomError(ERR.E_GATE_CONCURRENCY_LIMIT, `并发已达节奏档上限 (${running}/${cap}, ${rhythm})`);
    }
    const wireCost = contract.wire_cost ?? 0;
    if (wireCost > 0) {
      // 出口验证门闸（框架 §11）：默认关闭；开启后出网前必须有有效期内的通过记录
      this.assertEgressVerified(engagementId);
      const used = store.rateTotal('wire');
      const budget = RHYTHM_WIRE_CAP[rhythm] ?? 0;
      if (used + wireCost > budget) {
        throw warroomError(ERR.E_GATE_RATE_LIMIT,
          `wire 预算不足：已用 ${used} + 本次 ${wireCost} > ${budget}（${rhythm}）`);
      }
      const minGap = this._requiredGap(rhythm);
      if (minGap > 0) {
        const last = store.lastRateTs('wire');
        const gap = last ? this._nowMs() - Date.parse(last) : Infinity;
        if (gap < minGap) {
          const e = warroomError(ERR.E_GATE_RATE_LIMIT,
            `节奏间隔不足：距上次出网 ${Math.round(gap)}ms < ${Math.round(minGap)}ms（${rhythm}）`);
          e.retry_after_ms = minGap - gap;
          throw e;
        }
      }
    }
  }

  /**
   * 本次出网要求的最小间隔（框架 §4）：
   *   基础值（RHYTHM_MIN_INTERVAL_MS）→ stealth 档在 [floor, jitterMax] 内**随机**抖动
   *   → 再按小时做 ±RHYTHM_HOURLY_DRIFT 漂移（同一小时内稳定，跨小时变化）。
   * 目的：不让固定周期成为流量指纹。
   */
  _requiredGap(rhythm, atMs = null) {
    const base = RHYTHM_MIN_INTERVAL_MS[rhythm] ?? 0;
    if (base <= 0) return 0;
    const jitter = RHYTHM_JITTER_MS[rhythm];
    let gap = base;
    if (Array.isArray(jitter) && jitter[1] > jitter[0]) {
      const [lo, hi] = jitter;
      gap = lo + Math.floor(this._rng() * (hi - lo));   // 抖动
    }
    if (RHYTHM_HOURLY_DRIFT > 0) {
      const at = atMs ?? this._nowMs();
      const hourKey = Math.floor(at / 3_600_000);
      const drift = ((hourKey % 7) - 3) / 7 * 2 * RHYTHM_HOURLY_DRIFT;  // 同一小时稳定、跨小时变化
      gap = Math.round(gap * (1 + drift));
    }
    return Math.max(base, gap);   // 漂移不得低于基础地板
  }

  // ── 人工批准（destructive 裁决，ADR-001 D5 / ADR-007 绑定）──────────────────
  /**
   * 操作员侧签发批准令牌（进程内 API；操作员 CLI = `warroom approve`）。
   *
   * **必须给 `bound`**：批准绑定到「动作 + 可寻址集合」的指纹，不签发"万能令牌"。
   * 无绑定的批准（或旧库里的裸批准）在消费时一律拒收——`reason` 只是备注，不参与校验。
   */
  createApproval({ engagement_id, reason = '', issued_by = 'operator', ttlSeconds = 3600, bound = null }) {
    if (!bound || typeof bound.action !== 'string' || bound.action.trim() === '') {
      throw warroomError(ERR.E_APPROVAL_MISMATCH,
        'createApproval 需要 bound.action（配 bound.targets / bound.url）：批准必须绑定到具体动作与靶标，裸批准一律拒收');
    }
    const action = bound.action.trim().toLowerCase();   // 与执行层/手段闸同一口径（EXEC == exec）
    const targets = Array.isArray(bound.targets) ? bound.targets.filter((t) => String(t ?? '').trim() !== '') : [];
    const tokens = [...targets, ...(bound.url ? [bound.url] : [])].map(addressKey).filter(Boolean);
    if (tokens.length === 0) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH,
        '批准必须至少绑定一个可寻址对象：给 bound.targets 或 bound.url（空白/解析不出主机的批条等于死令牌）');
    }
    // 战役必须存在（否则签发出来的是一张永远消费不掉的幽灵令牌）
    this._auth(engagement_id);
    const contract_hash = approvalFingerprint({ action, action_class: 'destructive', targets, url: bound.url ?? null });
    const scope = [...new Set(tokens)].sort();
    const approval_id = `ap_${randomUUID()}`;
    const expires_at = new Date(this._nowMs() + ttlSeconds * 1000).toISOString();
    // 批准一律**一次性**：多用令牌等于可复制的不记名批条，且"这条令牌放行了什么"会失去归属
    // （需要多次就签多张，或把 TTL 缩短）。
    this.global.prepare(`INSERT INTO approvals
      (approval_id, engagement_id, action_class, reason, issued_by, expires_at, single_use, contract_hash, bound_action, bound_scope, ts)
      VALUES (?, ?, 'destructive', ?, ?, ?, 1, ?, ?, ?, ?)`).run(
      approval_id, engagement_id, reason, issued_by, expires_at, contract_hash, action, JSON.stringify(scope), now());
    return { approval_id, expires_at, contract_hash, bound_action: action, bound_scope: scope, single_use: true };
  }

  /**
   * 批准台账（只读）：签发时间/绑定动作与靶标/是否用过/是否过期——人读，不参与任何裁决。
   */
  listApprovals(engagementId) {
    return this.global.prepare(`SELECT approval_id, action_class, bound_action, bound_scope, reason, issued_by,
      expires_at, single_use, used_by_command, ts FROM approvals WHERE engagement_id = ? ORDER BY ts DESC, approval_id`)
      .all(engagementId)
      .map((r) => ({
        approval_id: r.approval_id, bound_action: r.bound_action,
        bound_scope: r.bound_scope ? JSON.parse(r.bound_scope) : [],
        reason: r.reason, issued_by: r.issued_by, ts: r.ts, expires_at: r.expires_at,
        single_use: true, used_by_command: r.used_by_command,
        used: !!r.used_by_command, expired: Date.parse(r.expires_at) <= this._nowMs(),
      }));
  }

  /**
   * 消费批准：必须**属于本战役 + 未过期 + 指纹与本条契约一致**；一次性批准用
   * compare-and-set 落定并记下**真实 command_id**（调用方必须在同一事务内调用）。
   */
  _consumeApproval(token, engagementId, contract, commandId) {
    if (!token) throw warroomError(ERR.E_GATE_DESTRUCTIVE_NEEDS_APPROVAL, '需要人工批准令牌');
    const row = this.global.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(token);
    if (!row) throw warroomError(ERR.E_APPROVAL_NOT_FOUND, '批准令牌不存在');
    if (row.engagement_id !== engagementId) throw warroomError(ERR.E_APPROVAL_MISMATCH, '批准令牌不属于该战役');
    if (Date.parse(row.expires_at) <= this._nowMs()) throw warroomError(ERR.E_APPROVAL_EXPIRED, `批准已于 ${row.expires_at} 过期`);
    if (!row.contract_hash) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH,
        '该批准未绑定动作（裸批准）：请用 `warroom approve --action <动作> --targets <靶标>` 重新签发');
    }
    const want = contractFingerprint(contract);
    if (row.contract_hash !== want) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH,
        `批准绑定的是 ${row.bound_action} @ ${row.bound_scope}（指纹 ${String(row.contract_hash).slice(0, 12)}），`
        + `与本次动作 ${String(contract?.action ?? '(未声明)').trim().toLowerCase()} @ ${JSON.stringify(contractAddressKeys(contract))}`
        + `（指纹 ${want.slice(0, 12)}）不符：动作/靶标/端口/路径任一不同都要重新签发批准`);
    }
    if (row.used_by_command) throw warroomError(ERR.E_APPROVAL_USED, '批准已被使用（一律一次性）');
    const r = this.global.prepare('UPDATE approvals SET used_by_command = ? WHERE approval_id = ? AND used_by_command IS NULL')
      .run(commandId, token);
    if (Number(r.changes) !== 1) throw warroomError(ERR.E_APPROVAL_USED, '批准已被使用（并发竞争）');
    return row;
  }

  /**
   * 结项：把执行器报告的终态同步进账本（账本状态机独占推进，ADR-003 D2）。
   * 执行器仍在运行 → 不结项（返回 settled:false），由调用方决定等待或换策略。
   */
  settle(engagementId, taskIdOrCommandId) {
    const cmd = this._findCommand(taskIdOrCommandId);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${taskIdOrCommandId} not found`);
    if (this.global.prepare('SELECT command_id FROM task_owners WHERE command_id = ?').get(cmd.command_id)) {
      return { settled: isTerminal(cmd.state), task_id: cmd.task_id, ledger_state: cmd.state, host_observed: true };
    }
    const runtime = this.adapter.status(cmd.task_id);
    const terminal = ['done', 'partial', 'failed', 'cancelled', 'confirmed_stopped'];
    if (!runtime || !terminal.includes(runtime.state)) {
      return { settled: false, task_id: cmd.task_id, ledger_state: cmd.state, runtime_state: runtime?.state ?? null };
    }
    // `done` 的语义是"派下去的活干完了"，**从来不等于**它留下的资源都停了（ADR-003 D4）。
    // 但也不许悄悄过去：完成时清单里还有活资源 → 留一条 resources_outstanding 审计信号
    // （取消请求仍能把它们停掉并逐项证实，见 ADR-009）。
    let live = [];
    if (runtime.state === 'done') {
      const liveness = this._liveResources(cmd);
      if (liveness.observable && liveness.live.length > 0) live = liveness.live;
    }
    if (cmd.state !== runtime.state) this._setCommandState(cmd.command_id, runtime.state);
    // 结项信号保持原样（效率四段/时序归集都认它）；资源未收口另加一条，不改既有语义
    this._gate(engagementId, 'settle', { task_id: cmd.task_id, state: runtime.state });
    if (live.length) this._gate(engagementId, 'resources_outstanding', { task_id: cmd.task_id, state: runtime.state, live });
    return { settled: true, task_id: cmd.task_id, ledger_state: runtime.state,
      runtime_state: runtime.state, ...(live.length ? { live } : {}) };
  }

  /**
   * 超时治理（ADR-003 D3）：派发时间超过阈值仍在运行的任务 → `unknown`，
   * **绝不自动重试**（重做渗透动作的代价是重复告警/账号锁死）；由 reconcile 依证据定论。
   * @param {{timeoutMs?:number}} opts 默认 30 分钟（框架 config taskTimeoutMin）
   */
  /**
   * 长时任务心跳：执行器仍在干活（长跑扫描/爆破/下载）时上报进度，
   * 使 `sweepTimeouts` 以**最近心跳**而非派发时刻为基准——正常的长任务不再被误判超时。
   */
  heartbeat(engagementId, taskIdOrCommandId, { note = null } = {}) {
    const cmd = this._findCommand(taskIdOrCommandId);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${taskIdOrCommandId} not found`);
    if (isTerminal(cmd.state)) {
      throw warroomError(ERR.E_INVALID_TRANSITION,
        `任务已处于终态 ${cmd.state}，无需心跳`);
    }
    const at = new Date(this._nowMs()).toISOString();
    this.global.prepare('UPDATE command_queue SET last_heartbeat_at = ? WHERE command_id = ?').run(at, cmd.command_id);
    this._gate(engagementId, 'heartbeat', { task_id: cmd.task_id, note, at });
    return { task_id: cmd.task_id, ledger_state: cmd.state, heartbeat_at: at };
  }

  sweepTimeouts(engagementId, { timeoutMs = null } = {}) {
    timeoutMs = timeoutMs ?? (this.config.timeoutMin ?? 30) * 60 * 1000;
    const nowMs = this._nowMs();
    const rows = this.global.prepare(
      `SELECT command_id, task_id, state, ts, last_heartbeat_at FROM command_queue
       WHERE engagement_id = ? AND state IN ('queued','running','cancel_requested')`
    ).all(engagementId);
    const swept = [];
    for (const r of rows) {
      // 基准 = 最近心跳（有则用），否则派发时刻
      const baseline = Date.parse(r.last_heartbeat_at ?? r.ts);
      const age = nowMs - baseline;
      if (age <= timeoutMs) continue;
      this._setCommandState(r.command_id, 'unknown');
      this._gate(engagementId, 'timeout_to_unknown', {
        task_id: r.task_id, age_ms: age, timeout_ms: timeoutMs,
        since: r.last_heartbeat_at ? 'heartbeat' : 'dispatch',
      });
      swept.push({ task_id: r.task_id, previous: r.state, age_ms: age, since: r.last_heartbeat_at ? 'heartbeat' : 'dispatch' });
    }
    return { swept, timeout_ms: timeoutMs, scanned: rows.length };
  }

  // ── 出口验证（框架 §11「出口验证」门闸）────────────────────────────────────
  /**
   * 记录一次出口验证结果（跳板出口或操作节点自身出口），并留痕 gate_log。
   * verdict: 'pass' | 'fail'。fail 会被后续强制门闸拒绝。
   */
  recordEgressCheck(engagementId, { jumphost_id, exit_ip, route_id = null, verdict = 'pass', observed_at = null }) {
    const store = this._eng(engagementId).store;
    store.recordEgressCheck({ jumphost_id, exit_ip, route_id, verdict });
    this._gate(engagementId, 'egress_check', {
      jumphost_id, exit_ip, route_id, verdict, observed_at: observed_at ?? new Date(this._nowMs()).toISOString(),
    });
    return { jumphost_id, exit_ip, route_id, verdict, checked_at: new Date(this._nowMs()).toISOString() };
  }

  /** 出口验证状态：最近一次结果 + 是否在有效期内。 */
  egressStatus(engagementId, { maxAgeMin = null } = {}) {
    const store = this._eng(engagementId).store;
    const maxAge = maxAgeMin ?? this.config.egressMaxAgeMin ?? 60;
    const last = store.db.prepare('SELECT * FROM egress_checks ORDER BY ts DESC LIMIT 1').get() ?? null;
    const ageMs = last ? this._nowMs() - Date.parse(last.ts) : null;
    return {
      last,
      age_min: ageMs === null ? null : Math.round(ageMs / 60000),
      max_age_min: maxAge,
      valid: !!last && last.verdict === 'pass' && ageMs <= maxAge * 60000,
      require_check: !!this.config.requireEgressCheck,
    };
  }

  /** 强制出口验证门闸：开启 requireEgressCheck 且无有效通过记录时拒绝。 */
  assertEgressVerified(engagementId) {
    if (!this.config.requireEgressCheck) return { enforced: false };
    const st = this.egressStatus(engagementId);
    if (!st.valid) {
      throw warroomError(ERR.E_GATE_EGRESS_UNVERIFIED,
        st.last
          ? `出口验证已失效：上次结果 ${st.last.verdict}（${st.age_min} 分钟前，上限 ${st.max_age_min} 分钟）`
          : '尚未做过出口验证（requireEgressCheck=true）：请先 warroom egress record');
    }
    return { enforced: true, last: st.last };
  }

  /**
   * 效率四段观测（框架 §11）：排队 / 交接 / 执行 / 失败与返工。
   * 全部由**已有时间戳**算：command_queue.ts（派发）、gate_log.collect（首次回执）、
   * gate_log.settle（结项）、engagements.created_at（立项）。无数据一律 null，不编造。
   */
  _segments(engagementId, cmds, store) {
    const eng = store.db.prepare('SELECT created_at FROM engagements WHERE id = ?').get(engagementId);
    const logs = store.db.prepare(
      "SELECT decision, ts, detail, request_json FROM gate_log WHERE decision IN ('collect','settle','redispatch') ORDER BY id"
    ).all();
    const firstByTask = (decision) => {
      const map = new Map();
      for (const l of logs) {
        if (l.decision !== decision) continue;
        // gate_log 把事件负载写在 detail（JSON 字符串），旧行可能在 request_json
        const raw = l.request_json ?? l.detail ?? '{}';
        let req = {};
        try { req = JSON.parse(raw); } catch { /* 忽略坏行 */ }
        const tid = req.task_id;
        if (tid && !map.has(tid)) map.set(tid, Date.parse(l.ts));
      }
      return map;
    };
    const collects = firstByTask('collect');
    const settles = firstByTask('settle');

    const handoffs = [];
    const execs = [];
    let reworkMs = 0;
    let reworked = 0;
    for (const c of cmds) {
      const dispatchTs = Date.parse(c.ts);
      const collectTs = collects.get(c.task_id) ?? null;
      const settleTs = settles.get(c.task_id) ?? null;
      if (collectTs) handoffs.push(Math.max(0, collectTs - dispatchTs));
      if (collectTs && settleTs) execs.push(Math.max(0, settleTs - collectTs));
      if ((c.attempt ?? 1) > 1) {
        reworked += 1;
        if (settleTs) reworkMs += Math.max(0, settleTs - dispatchTs);
      }
    }
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    const firstDispatch = cmds.length ? Math.min(...cmds.map((c) => Date.parse(c.ts))) : null;
    const created = eng?.created_at ? Date.parse(eng.created_at) : null;

    return {
      queue_ms: (created !== null && firstDispatch !== null) ? Math.max(0, firstDispatch - created) : null,
      handoff_ms: avg(handoffs),
      exec_ms: avg(execs),
      samples: { handoff: handoffs.length, exec: execs.length },
      rework: { tasks: reworked, wall_ms: reworked > 0 ? reworkMs : null },
      basis: 'command_queue.ts → gate_log.collect → gate_log.settle（无对应事件则为 null）',
    };
  }

  // ── 审计（一切动作可追溯：门闸每次判定都留痕，这里给出查询与导出）────────────
  /**
   * @param {{decision?:string, since?:string, limit?:number}} opts
   */
  audit(engagementId, { decision = null, since = null, limit = 200, offset = 0, order = 'desc' } = {}) {
    const store = this._eng(engagementId).store;
    const where = [];
    const args = [];
    if (decision) { where.push('decision = ?'); args.push(decision); }
    if (since) { where.push('ts >= ?'); args.push(since); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const dir = order === 'asc' ? 'ASC' : 'DESC';
    const rows = store.db.prepare(`SELECT id, ts, decision, code, detail, recovered_at FROM gate_log
      ${whereSql} ORDER BY id ${dir} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const matched = store.db.prepare(`SELECT COUNT(*) AS n FROM gate_log ${whereSql}`).get(...args).n;
    const byDecision = store.db.prepare(`SELECT decision, COUNT(*) AS n FROM gate_log ${whereSql} GROUP BY decision ORDER BY n DESC`).all(...args);
    return {
      rows,
      page: { limit, offset, matched, has_more: offset + rows.length < matched },
      total: store.db.prepare('SELECT COUNT(*) AS n FROM gate_log').get().n,
      by_decision: byDecision,
    };
  }

  /** 审计导出 CSV（给不读 JSON 的人）；字段转义按 RFC4180。 */
  auditExportCsv(engagementId, { outDir, decision = null, since = null } = {}) {
    const store = this._eng(engagementId).store;
    const dir = outDir ?? resolveUnder(this.home, 'engagements', engagementId, 'audit');
    mkdirSync(dir, { recursive: true });
    const where = [];
    const args = [];
    if (decision) { where.push('decision = ?'); args.push(decision); }
    if (since) { where.push('ts >= ?'); args.push(since); }
    const rows = store.db.prepare(`SELECT id, ts, decision, code, detail, recovered_at FROM gate_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`).all(...args);
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'id,ts,decision,code,detail,recovered_at';
    const body = rows.map((r) => [r.id, r.ts, r.decision, r.code, r.detail, r.recovered_at].map(esc).join(','));
    const path = join(dir, 'audit-log.csv');
    writeFileSync(path, [header, ...body].join('\n') + '\n', 'utf8');
    return { path, lines: rows.length, format: 'csv' };
  }

  /** 导出审计日志（JSONL）；行数与查询一致，内容已脱敏（写入时即脱敏）。 */
  auditExport(engagementId, { outDir } = {}) {
    const store = this._eng(engagementId).store;
    const dir = outDir ?? resolveUnder(this.home, 'engagements', engagementId, 'audit');
    mkdirSync(dir, { recursive: true });
    const rows = store.db.prepare('SELECT id, ts, decision, code, detail, request_json, recovered_at FROM gate_log ORDER BY id').all();
    const path = join(dir, `audit-log.jsonl`);
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return {
      path,
      lines: rows.length,
      summary: store.db.prepare('SELECT decision, COUNT(*) AS n FROM gate_log GROUP BY decision ORDER BY n DESC').all(),
      watermark: { seq: store.seq() },
    };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────
  _acknowledgeCommand(existing, req, { deferDispatch, parent }) {
    if (existing.engagement_id !== req.engagement_id) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH, 'command belongs to another engagement');
    }
    if (req.task_id && req.task_id !== existing.task_id) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH, 'command already has a different task identity');
    }
    this._findCommand(existing.command_id);
    const owner = this.global.prepare('SELECT * FROM task_owners WHERE command_id = ?').get(existing.command_id);
    if ((deferDispatch && (!owner || owner.parent_session_id !== parent.session_id ||
        owner.parent_created_at !== parent.created_at)) || (!deferDispatch && owner)) {
      throw Object.assign(new Error('command belongs to another parent dispatch path'), { code: 'E_PARENT_IDENTITY' });
    }
    if (owner && !owner.registration_ready) {
      throw Object.assign(new Error(`registration incomplete for ${existing.command_id}; host review required`),
        { code: 'E_REGISTRATION_INCOMPLETE', task_id: existing.task_id, generation: existing.generation });
    }
    return { command_id: req.command_id, task_id: existing.task_id, state: existing.state,
      generation: existing.generation, deduped: true };
  }

  _findCommand(idOrCommand) {
    const rows = this.global.prepare('SELECT * FROM command_queue WHERE task_id = ? OR command_id = ? LIMIT 2')
      .all(idOrCommand, idOrCommand);
    const cmd = rows[0];
    if (!cmd) return undefined;
    // Even an exact command lookup must reject a duplicated task alias: downstream
    // adapters resolve by task_id. Preserve old rows for review rather than guessing.
    const aliases = this.global.prepare(`SELECT command_id FROM command_queue
      WHERE task_id IN (?, ?) OR command_id IN (?, ?) LIMIT 2`)
      .all(cmd.task_id, cmd.command_id, cmd.task_id, cmd.command_id);
    if (rows.length > 1 || aliases.length > 1) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH, 'ambiguous task or command identity; host review required');
    }
    return cmd;
  }
  _setCommandState(command_id, state) {
    if (!ALL_TASK_STATES.includes(state)) throw new Error(`bad state ${state}`);
    const cur = this.global.prepare('SELECT state FROM command_queue WHERE command_id = ?').get(command_id);
    if (cur && cur.state !== state && !canTransition(cur.state, state)) {
      throw warroomError(ERR.E_INVALID_TRANSITION, `${cur.state} → ${state} 不是合法迁移`);
    }
    this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?').run(state, command_id);
  }

  /** 任务全景：账本状态 + 运行态 + 资源清单 + 尝试次数。 */
  status(engagementId, taskIdOrCommand) {
    const cmd = this._findCommand(taskIdOrCommand);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${taskIdOrCommand} not found`);
    if (cmd.engagement_id !== engagementId) throw warroomError(ERR.E_APPROVAL_MISMATCH, 'task belongs to another engagement');
    if (this.global.prepare('SELECT command_id FROM task_owners WHERE command_id = ?').get(cmd.command_id)) {
      // The durable ledger remains authoritative before dispatch and after terminal reload.
      const resources = this.global.prepare('SELECT resource_id, kind FROM task_resources WHERE command_id = ? AND generation = ?')
        .all(cmd.command_id, cmd.generation);
      return { task_id: cmd.task_id, command_id: cmd.command_id, engagement_id: cmd.engagement_id,
        ledger_state: cmd.state, attempt: cmd.attempt, generation: cmd.generation,
        runtime_state: null, manifest: resources.map((r) => ({ id: r.resource_id, kind: r.kind, confirmed_stopped: null })) };
    }
    const runtime = this.adapter.status(cmd.task_id);
    const manifest = (this.adapter.manifestOf(cmd.task_id) ?? [])
      .map((m) => ({ id: m.id, kind: m.kind, confirmed_stopped: m.check() }));
    return {
      task_id: cmd.task_id, command_id: cmd.command_id, engagement_id: cmd.engagement_id,
      ledger_state: cmd.state, attempt: cmd.attempt, generation: cmd.generation,
      runtime_state: runtime?.state ?? null, manifest,
    };
  }

  /**
   * 对账：只处理 unknown / unresolved（ADR-003 D3）——以证据定论，绝不默认失败重做。
   * 定论依据优先级：执行器回执 > 只读再探测 > 人工（本 API 对应前两者）。
   */
  reconcile(engagementId, taskIdOrCommand) {
    const cmd = this._findCommand(taskIdOrCommand);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${taskIdOrCommand} not found`);
    if (this.global.prepare('SELECT command_id FROM task_owners WHERE command_id = ?').get(cmd.command_id)) {
      return { task_id: cmd.task_id, state: cmd.state, host_observed: true };
    }
    if (!['unknown', 'unresolved'].includes(cmd.state)) {
      throw warroomError(ERR.E_TASK_NOT_RECONCILABLE, `状态 ${cmd.state} 无需对账`);
    }
    const manifest = this.adapter.manifestOf(cmd.task_id) ?? [];
    const residual = manifest.filter((m) => !m.check());
    const verdict = this.adapter.reconcile(cmd.task_id); // 探针定论
    let next = verdict.state;
    if (residual.length > 0) next = 'unresolved';       // 资源残留 → 维持挂起
    this._setCommandState(cmd.command_id, next === cmd.state ? cmd.state : next);
    this._gate(engagementId, 'reconcile', {
      task_id: cmd.task_id, verdict: next, probes: manifest.length, residual: residual.map((m) => m.id),
    });
    return { task_id: cmd.task_id, state: next, residual: residual.map((m) => m.id) };
  }

  /**
   * 重派：仅 failed / unresolved（人工裁决后）——升 attempt、换 generation；
   * 旧 attempt 回执按代际隔离（ADR-003 D6）。
   */
  redispatch(engagementId, taskIdOrCommand, reason = 'manual') {
    const cmd = this._findCommand(taskIdOrCommand);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${taskIdOrCommand} not found`);
    if (cmd.engagement_id !== engagementId) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH, 'command 不属于该战役');
    }
    if (this.global.prepare('SELECT command_id FROM task_owners WHERE command_id = ?').get(cmd.command_id)) {
      throw warroomError(ERR.E_TASK_NOT_REDISPATCHABLE, 'host-owned task requires a fresh authorized command, never automatic redispatch');
    }
    if (!['failed', 'unresolved'].includes(cmd.state)) {
      throw warroomError(ERR.E_TASK_NOT_REDISPATCHABLE, `状态 ${cmd.state} 不允许重派（先 reconcile）`);
    }
    let contract;
    try { contract = JSON.parse(cmd.contract); }
    catch { throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'persisted contract is invalid JSON'); }
    validateContract(contract ?? {});
    if (contract.engagement_id !== cmd.engagement_id || contract.task_id !== cmd.task_id) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH, 'persisted contract 不属于该任务');
    }
    // 原契约与队列都必须保留原授权版本；不能将历史越权重派洗成当前授权。
    const [original, current] = [contract.generation, cmd.generation].map((value) => {
      const match = typeof value === 'string' && /^[0-9]+:[0-9]+:[0-9]+$/.exec(value);
      const parts = match && match[0] === value ? value.split(':').map(Number) : [];
      if (parts.length !== 3 || parts.some((n) => !Number.isSafeInteger(n)) ||
          parts[0] < 1 || parts[1] < 0 || parts[2] < 1) {
        throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'persisted generation required');
      }
      return parts;
    });
    if (current[2] !== cmd.attempt || !Number.isSafeInteger(cmd.attempt + 1)) {
      throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'persisted attempt inconsistent or exhausted');
    }
    if (original[0] !== current[0]) {
      throw warroomError(ERR.E_GATE_AUTH_EXPIRED, 'original authorization version was changed');
    }
    validateFourTuple({ engagement_id: engagementId, auth_version: original[0],
      task_id: cmd.task_id, action_class: contract.action_class });
    const { row, auth } = this._auth(engagementId);
    if (!ACTION_CLASS.includes(auth.action_class_limit)) {
      throw warroomError(ERR.E_GATE_CLASS_EXCEEDS_LIMIT, 'authorization action_class_limit invalid');
    }
    const nowMs = this._nowMs();
    const start = Date.parse(auth.window_start), end = Date.parse(auth.window_end);
    if (![nowMs, start, end].every(Number.isFinite) || start > end) {
      throw warroomError(ERR.E_GATE_WINDOW_CLOSED, 'authorization window or clock invalid');
    }
    checkAgainstAuth({ auth: { ...auth, auth_version: row.auth_version },
      auth_version: original[0], nowMs, contract });
    // 重派接口没有新人工批准；destructive 不继承已消费的令牌。
    // 不支持重派的 adapter 不得因 optional call 而假报 running。
    if (typeof this.adapter.redispatch !== 'function') {
      throw warroomError(ERR.E_TASK_NOT_REDISPATCHABLE, 'adapter does not support redispatch');
    }
    const attempt = cmd.attempt + 1;
    const generation = makeGeneration(original[0], current[1], attempt);
    this._setCommandState(cmd.command_id, 'running');
    this.global.prepare('UPDATE command_queue SET attempt = ?, generation = ? WHERE command_id = ?')
      .run(attempt, generation, cmd.command_id);
    this.adapter.redispatch(cmd.command_id, { ...contract, generation }, attempt);
    this._gate(engagementId, 'redispatch', { task_id: cmd.task_id, attempt, reason });
    return { task_id: cmd.task_id, attempt, generation, state: 'running' };
  }
  _gate(engagement_id, code, detail) {
    try {
      this._eng(engagement_id).store.appendGateLog({
        decision: code, detail: this.secrets.redact(JSON.stringify(detail)),
      });
    } catch { /* fact 不可写时审计走 op_log 补偿路径（ADR-002 D6） */ }
  }
}
