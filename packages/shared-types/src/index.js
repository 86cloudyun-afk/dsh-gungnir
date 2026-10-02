// WARROOM 共享接口类型 —— 批次 0 · alpha 冻结（ADR-002/003 rev2 的可执行形态）。
// 规则：各包禁止自行解释 ADR；一切以本文件常量与校验函数为准。
// 变更走语义化版本：破坏性 = 升主版本并广播（框架 §11）。

export const VERSION = '0.1.0-alpha.4';

// ── 动作分级（ADR-001 D5）：readonly < active < destructive ─────────────────
export const ACTION_CLASS = Object.freeze(['readonly', 'active', 'destructive']);
const CLASS_RANK = Object.freeze({ readonly: 0, active: 1, destructive: 2 });

// ── 节奏档（框架 §4）：并发任务上限；限流对象 = wire_requests（ADR-002 D10）──
export const RHYTHM = Object.freeze(['open', 'restricted', 'stealth']);
export const RHYTHM_CONCURRENCY = Object.freeze({ open: 3, restricted: 2, stealth: 1 });
/** wire_requests 预算上限（滚动口径：按战役累计，ADR-002 D10）。 */
export const RHYTHM_WIRE_CAP = Object.freeze({ open: 100000, restricted: 1000, stealth: 100 });
/** 两次出网动作之间的最小间隔（框架 §4：仅 stealth 档有节奏要求）。 */
export const RHYTHM_MIN_INTERVAL_MS = Object.freeze({ open: 0, restricted: 0, stealth: 8000 });
/**
 * stealth 档节奏抖动区间（框架 §4「8~25s 抖动」）：实际最小间隔在 [floor, jitterMax] 内随机，
 * 避免固定周期形成流量指纹。
 */
export const RHYTHM_JITTER_MS = Object.freeze({ stealth: Object.freeze([8000, 25000]) });
/** 每小时漂移比例：以小时为种子微调目标间隔（±drift 比例），避免整点对齐形成的长周期指纹。 */
export const RHYTHM_HOURLY_DRIFT = 0.2;

// ── 任务状态机（ADR-003 D2）─────────────────────────────────────────────────
export const TASK_STATES = Object.freeze({
  NON_TERMINAL: Object.freeze(['queued', 'running', 'cancel_requested', 'unknown']),
  SUSPENDED: Object.freeze(['unresolved']),
  TERMINAL: Object.freeze(['done', 'partial', 'failed', 'cancelled', 'confirmed_stopped']),
});
export const ALL_TASK_STATES = Object.freeze([
  ...TASK_STATES.NON_TERMINAL,
  ...TASK_STATES.SUSPENDED,
  ...TASK_STATES.TERMINAL,
]);

/** 合法迁移表：host 独占执行迁移；adapter 只上报事件，不得自行改状态。 */
export const TASK_TRANSITIONS = Object.freeze({
  queued: ['running', 'cancelled', 'unknown'],
  running: ['cancel_requested', 'unknown', 'done', 'partial', 'failed', 'cancelled'],
  cancel_requested: ['confirmed_stopped', 'unresolved', 'cancelled'],
  unknown: ['done', 'partial', 'failed', 'running', 'unresolved'],
  unresolved: ['confirmed_stopped', 'failed', 'partial', 'done', 'running'],
  failed: ['running'], // 人工裁决后的重派（attempt+1）
});

export function canTransition(from, to) {
  return (TASK_TRANSITIONS[from] || []).includes(to);
}
export function isTerminal(state) {
  return TASK_STATES.TERMINAL.includes(state);
}

// ── 资源清单条目（ADR-003 D4：confirmed_stopped 需清单逐项证实）──────────────
export const RESOURCE_KINDS = Object.freeze(['session', 'subtask', 'process', 'port', 'container']);

// ── 错误码（broker/gate/adapter 共用；验收负样本直接断言这些值）──────────────
export const ERR = Object.freeze({
  E_GATE_MISSING_TUPLE: 'E_GATE_MISSING_TUPLE',
  E_GATE_AUTH_EXPIRED: 'E_GATE_AUTH_EXPIRED',
  E_GATE_OUT_OF_SCOPE: 'E_GATE_OUT_OF_SCOPE',
  E_GATE_CLASS_EXCEEDS_LIMIT: 'E_GATE_CLASS_EXCEEDS_LIMIT',
  E_GATE_WINDOW_CLOSED: 'E_GATE_WINDOW_CLOSED',
  E_GATE_DESTRUCTIVE_NEEDS_APPROVAL: 'E_GATE_DESTRUCTIVE_NEEDS_APPROVAL',
  E_GATE_EGRESS_UNVERIFIED: 'E_GATE_EGRESS_UNVERIFIED',
  E_GATE_RATE_LIMIT: 'E_GATE_RATE_LIMIT',
  E_GATE_CONCURRENCY_LIMIT: 'E_GATE_CONCURRENCY_LIMIT',
  E_APPROVAL_NOT_FOUND: 'E_APPROVAL_NOT_FOUND',
  E_APPROVAL_EXPIRED: 'E_APPROVAL_EXPIRED',
  E_APPROVAL_USED: 'E_APPROVAL_USED',
  E_APPROVAL_MISMATCH: 'E_APPROVAL_MISMATCH',
  E_TASK_NOT_RECONCILABLE: 'E_TASK_NOT_RECONCILABLE',
  E_TASK_NOT_REDISPATCHABLE: 'E_TASK_NOT_REDISPATCHABLE',
  E_INVALID_TRANSITION: 'E_INVALID_TRANSITION',
  E_TASK_NOT_FOUND: 'E_TASK_NOT_FOUND',
  E_DISPATCH_LOST_RESPONSE: 'E_DISPATCH_LOST_RESPONSE',
  E_NO_JUMPHOST: 'E_NO_JUMPHOST',
  E_COMPENSATED: 'E_COMPENSATED',
  E_STORE_WRITE_FAILED: 'E_STORE_WRITE_FAILED',
  E_SECRET_NOT_FOUND: 'E_SECRET_NOT_FOUND',
  E_SECRET_NO_GRANT: 'E_SECRET_NO_GRANT',
  E_SECRET_GRANT_EXPIRED: 'E_SECRET_GRANT_EXPIRED',
  E_SECRET_KEY_INVALID: 'E_SECRET_KEY_INVALID',
});

export function warroomError(code, message, detail) {
  const e = new Error(message || code);
  e.code = code;
  if (detail !== undefined) e.detail = detail;
  return e;
}

// ── 四元组（ADR-001 D2）：每个有副作用的执行请求必须完整携带 ─────────────────
export function validateFourTuple(req = {}) {
  const missing = ['engagement_id', 'auth_version', 'task_id', 'action_class'].filter(
    (k) => req[k] === undefined || req[k] === null || req[k] === ''
  );
  if (missing.length) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, `four-tuple missing: ${missing.join(',')}`, { missing });
  }
  if (!ACTION_CLASS.includes(req.action_class)) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, `bad action_class: ${req.action_class}`);
  }
}

// ── contract（dispatch 契约）────────────────────────────────────────────────
export function validateContract(c = {}) {
  if (!Array.isArray(c.targets) || c.targets.length === 0) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'contract.targets required');
  }
  if (!ACTION_CLASS.includes(c.action_class)) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, `bad contract.action_class: ${c.action_class}`);
  }
  if (c.wire_cost !== undefined && !Number.isInteger(c.wire_cost)) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'contract.wire_cost must be integer');
  }
}

// ── receipt（collect 回执）：成员级幂等真源是 source_key + revision_no ───────
export function validateReceipt(r = {}) {
  if (typeof r.receipt_id !== 'string' || !r.receipt_id) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'receipt.receipt_id required');
  }
  if (typeof r.generation !== 'string' || !r.generation) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'receipt.generation required');
  }
  if (!Array.isArray(r.members)) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'receipt.members must be array');
  }
  for (const m of r.members) {
    if (!m.entity_type || !m.source_id || !Number.isInteger(m.revision_no) || !m.content_hash) {
      throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'member requires entity_type/source_id/revision_no/content_hash');
    }
  }
}

// ── source_key / generation（ADR-002 D5、ADR-003 D6）────────────────────────
export function makeSourceKey(adapterInstance, entityType, sourceId) {
  return { adapter_instance: adapterInstance, entity_type: entityType, source_id: sourceId };
}
/** generation 只在同一 task 的执行尝试之间比较（ADR-003 D6）。 */
export function makeGeneration(authVersion, dispatchSeq, attempt = 1) {
  return `${authVersion}:${dispatchSeq}:${attempt}`;
}
export function classExceeds(requested, limit) {
  return CLASS_RANK[requested] > CLASS_RANK[limit];
}
