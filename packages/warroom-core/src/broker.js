// Broker：唯一副作用通道（ADR-001 D1/D2）+ 命令队列 + 撤销级联 + 代际收集（ADR-003）。
import { randomUUID } from 'node:crypto';
import {
  validateFourTuple, validateContract, validateReceipt, RHYTHM_CONCURRENCY, RHYTHM_WIRE_CAP,
  RHYTHM_MIN_INTERVAL_MS, warroomError, ERR, canTransition, isTerminal, makeGeneration,
  ALL_TASK_STATES,
} from '../../shared-types/src/index.js';
import { checkAgainstAuth, buildAuthObject } from './gates.js';
import { join } from 'node:path';
import { openEngagementDb, openGlobalDb } from './db.js';
import { FactStore } from './store.js';
import { FakeAdapter } from './adapters/fake.js';
import { SecretVault } from './secrets.js';
import { KnowledgeBase } from './knowledge.js';
import { redactDeep } from './redactor.js';
import { exportReport as exportReportFile, buildReport, verifyReportAgainstStore } from './report.js';

const now = () => new Date().toISOString();

export class Broker {
  /**
   * @param {{home:string, adapter?:object, nowMs?:()=>number}} opts
   */
  constructor({ home, adapter, nowMs } = {}) {
    this.home = home;
    this.global = openGlobalDb(home);
    this.secrets = new SecretVault({ root: join(home, 'secrets'), db: this.global, nowMs: () => this._nowMs() });
    this.knowledge = new KnowledgeBase({ home });
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

    // 节奏闸（ADR-002 D10 / 框架 §4）：并发 / wire 预算 / 最小间隔
    this._checkRhythm({ engagementId: req.engagement_id, rhythm: row.rhythm, contract: req.contract, store });

    // destructive 的人工裁决：令牌必须是已登记且未过期的批准（可审计），检查其归属与一次性
    if (req.contract.action_class === 'destructive') {
      this._consumeApproval(req.manual_approval_token, req.engagement_id);
    }

    // broker 持有 task_id（四元组在派发前即完整）
    const generation = makeGeneration(row.auth_version, ++this.dispatchCounter, 1);
    const contract = { ...req.contract, task_id, generation, engagement_id: req.engagement_id };

    // 命令先持久化，后派发（ADR-003 D1：派发幂等）
    const existing = this.global
      .prepare('SELECT * FROM command_queue WHERE command_id = ?').get(req.command_id);
    if (existing) {
      return {
        command_id: req.command_id, task_id: existing.task_id, state: existing.state,
        generation: existing.generation, deduped: true,
      };
    }
    this.global.prepare(`INSERT INTO command_queue
      (command_id, engagement_id, task_id, contract, state, generation, attempt, ts)
      VALUES (?, ?, ?, ?, 'queued', ?, 1, ?)`).run(
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

  // ── 取消与证实（ADR-003 D4：资源清单逐项证实，账本不算证明）──────────────────
  cancel(engagement_id, taskIdOrCommandId, reason = 'manual') {
    const cmd = this._findCommand(taskIdOrCommandId);
    if (!cmd) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${taskIdOrCommandId} not found`);
    if (isTerminal(cmd.state)) return { task_id: cmd.task_id, state: cmd.state, terminal: true };

    this.global.prepare('UPDATE command_queue SET state = ? WHERE command_id = ?')
      .run('cancel_requested', cmd.command_id);
    this.adapter.cancel(cmd.task_id, reason);

    const manifest = this.adapter.manifestOf(cmd.task_id) ?? [];
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

  /** 效率聚合：端到端视角（框架 §2 原则 8/§11）——完成时间与有效产出，不含成本门闸。 */
  metrics(engagementId) {
    const rows = this.global.prepare('SELECT * FROM task_metrics WHERE engagement_id = ?').all(engagementId);
    const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    const store = this._eng(engagementId).store;
    const effective = store.effectiveCount();
    const tokens = sum('tokens_in') + sum('tokens_out');
    const wall = sum('wall_time_ms');
    const verified = sum('verified_facts');
    return {
      tasks: rows.length,
      tokens_in: sum('tokens_in'), tokens_out: sum('tokens_out'),
      wall_time_ms: wall,
      verified_facts: verified,
      effective_facts: effective,
      facts_per_1000_tokens: tokens > 0 ? Number(((effective / tokens) * 1000).toFixed(3)) : null,
      ms_per_fact: effective > 0 ? Math.round(wall / effective) : null,
      by_role: rows.reduce((acc, r) => {
        const k = r.role ?? 'unknown';
        acc[k] = acc[k] ?? { tasks: 0, tokens: 0, verified: 0 };
        acc[k].tasks += 1; acc[k].tokens += r.tokens_in + r.tokens_out; acc[k].verified += r.verified_facts;
        return acc;
      }, {}),
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
  sprayRecord(engagementId, args) {
    const store = this._eng(engagementId).store;
    const check = this.sprayCheck(engagementId, args);
    if (check.locked) throw warroomError(ERR.E_GATE_RATE_LIMIT, '该账号已锁定，禁止继续喷洒（防锁死）');
    store.sprayRecord(args);
    return { recorded: true, ...args };
  }

  // ── 报告导出（框架 §5：水位 + IOC 附录 + 脱敏）──────────────────────────────
  buildReport(engagementId) {
    const { row, store } = this._engWithRow(engagementId);
    return buildReport({ store, engagementId, engagementRow: row, vault: this.secrets, globalDb: this.global });
  }

  /** 复现校验：给定报告正文，对照当前库判定是否仍可复现。 */
  verifyReport(engagementId, markdown) {
    const { store } = this._engWithRow(engagementId);
    return verifyReportAgainstStore(markdown, store);
  }

  exportReport(engagementId, { outDir, format = 'md' } = {}) {
    const { row, store } = this._engWithRow(engagementId);
    const dir = outDir ?? join(this.home, 'engagements', engagementId, 'reports');
    return exportReportFile({
      store, engagementId, engagementRow: row, vault: this.secrets, globalDb: this.global, outDir: dir, format,
    });
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
      const used = store.rateTotal('wire');
      const budget = RHYTHM_WIRE_CAP[rhythm] ?? 0;
      if (used + wireCost > budget) {
        throw warroomError(ERR.E_GATE_RATE_LIMIT,
          `wire 预算不足：已用 ${used} + 本次 ${wireCost} > ${budget}（${rhythm}）`);
      }
      const minGap = RHYTHM_MIN_INTERVAL_MS[rhythm] ?? 0;
      if (minGap > 0) {
        const last = store.lastRateTs('wire');
        const gap = last ? this._nowMs() - Date.parse(last) : Infinity;
        if (gap < minGap) {
          const e = warroomError(ERR.E_GATE_RATE_LIMIT,
            `节奏间隔不足：距上次出网 ${Math.round(gap)}ms < ${minGap}ms（${rhythm}）`);
          e.retry_after_ms = minGap - gap;
          throw e;
        }
      }
    }
  }

  // ── 人工批准（destructive 裁决，ADR-001 D5）────────────────────────────────
  /** 操作员侧签发批准令牌（进程内 API；DSH 中对应人工裁决动作）。 */
  createApproval({ engagement_id, reason = '', issued_by = 'operator', ttlSeconds = 3600, single_use = true }) {
    const approval_id = `ap_${randomUUID()}`;
    const expires_at = new Date(this._nowMs() + ttlSeconds * 1000).toISOString();
    this.global.prepare(`INSERT INTO approvals
      (approval_id, engagement_id, action_class, reason, issued_by, expires_at, single_use, ts)
      VALUES (?, ?, 'destructive', ?, ?, ?, ?, ?)`).run(
      approval_id, engagement_id, reason, issued_by, expires_at, single_use ? 1 : 0, now());
    return { approval_id, expires_at };
  }

  _consumeApproval(token, engagementId) {
    if (!token) throw warroomError(ERR.E_GATE_DESTRUCTIVE_NEEDS_APPROVAL, '需要人工批准令牌');
    const row = this.global.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(token);
    if (!row) throw warroomError(ERR.E_APPROVAL_NOT_FOUND, '批准令牌不存在');
    if (row.engagement_id !== engagementId) throw warroomError(ERR.E_APPROVAL_MISMATCH, '批准令牌不属于该战役');
    if (Date.parse(row.expires_at) <= this._nowMs()) throw warroomError(ERR.E_APPROVAL_EXPIRED, `批准已于 ${row.expires_at} 过期`);
    if (row.single_use && row.used_by_command) throw warroomError(ERR.E_APPROVAL_USED, '一次性批准已被使用');
    this.global.prepare('UPDATE approvals SET used_by_command = ? WHERE approval_id = ?')
      .run(`used_at:${now()}`, token);
    return row;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────
  _findCommand(idOrCommand) {
    return this.global.prepare('SELECT * FROM command_queue WHERE task_id = ? OR command_id = ?')
      .get(idOrCommand, idOrCommand);
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
    if (!['failed', 'unresolved'].includes(cmd.state)) {
      throw warroomError(ERR.E_TASK_NOT_REDISPATCHABLE, `状态 ${cmd.state} 不允许重派（先 reconcile）`);
    }
    const row = this._auth(engagementId).row;
    const attempt = cmd.attempt + 1;
    const generation = makeGeneration(row.auth_version, this.dispatchCounter, attempt);
    this._setCommandState(cmd.command_id, 'running');
    this.global.prepare('UPDATE command_queue SET attempt = ?, generation = ? WHERE command_id = ?')
      .run(attempt, generation, cmd.command_id);
    this.adapter.redispatch?.(cmd.command_id, { ...JSON.parse(cmd.contract), generation }, attempt);
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
