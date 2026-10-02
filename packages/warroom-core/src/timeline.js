// 战役时序（框架 §5 数据流的可读形态）：把账本事件排成一条时间线。
// 来源：engagements.created_at + command_queue.ts/state + gate_log（collect/settle/heartbeat/
// shell_proof/shell_verify/preflight/wave_rejected/route_stale/egress_check…）。
// 原则：只呈现**账本里真实存在的事件**，缺失阶段标为 pending，不脑补时间。
const PHASES = ['立项', '派发', '回执', '结项', '控制面', '交付'];

const DECISION_PHASE = {
  preflight: '立项', wave_rejected: '立项', meeting: '立项',
  collect: '回执', settle: '结项', heartbeat: '结项', timeout_to_unknown: '结项',
  reconcile: '结项', redispatch: '派发', cancel_requested: '结项', stop_confirmed: '结项',
  shell_proof: '控制面', shell_verify: '控制面',
  egress_check: '立项', route_stale: '立项', route_heartbeat: '立项',
  report_export: '交付', evidence_export: '交付',
};

/**
 * @param {{store:object, globalDb:object, engagementId:string}} p
 * @returns {{engagement_id:string, events:Array<{ts,phase,kind,detail}>, phases:object, span_ms:number|null}}
 */
export function buildTimeline({ store, globalDb, engagementId }) {
  const events = [];
  const eng = store.db.prepare('SELECT * FROM engagements WHERE id = ?').get(engagementId);
  if (eng) {
    events.push({ ts: eng.created_at, phase: '立项', kind: 'engagement_created',
      detail: `目标 ${eng.target_scope} · 节奏档 ${eng.rhythm} · auth v${eng.auth_version}` });
  }

  const cmds = globalDb.prepare(
    'SELECT command_id, task_id, state, ts, attempt, last_heartbeat_at FROM command_queue WHERE engagement_id = ? ORDER BY ts'
  ).all(engagementId);
  for (const c of cmds) {
    events.push({ ts: c.ts, phase: '派发', kind: 'dispatch',
      detail: `任务 ${c.task_id}（attempt ${c.attempt ?? 1}）` });
    if (c.last_heartbeat_at) {
      events.push({ ts: c.last_heartbeat_at, phase: '结项', kind: 'heartbeat',
        detail: `任务 ${c.task_id} 心跳` });
    }
    events.push({ ts: null, phase: '结项', kind: `ledger_state:${c.state}`,
      detail: `任务 ${c.task_id} 当前账本态 ${c.state}` });
  }

  const logs = store.db.prepare('SELECT id, ts, decision, detail FROM gate_log ORDER BY id').all();
  for (const l of logs) {
    const phase = DECISION_PHASE[l.decision];
    if (!phase) continue;
    events.push({ ts: l.ts, phase, kind: l.decision, detail: l.detail ?? '' });
  }

  events.sort((a, b) => {
    if (a.ts === null && b.ts === null) return 0;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return Date.parse(a.ts) - Date.parse(b.ts);
  });

  const stamped = events.filter((e) => e.ts);
  const span = stamped.length >= 2
    ? Date.parse(stamped.at(-1).ts) - Date.parse(stamped[0].ts)
    : null;

  const phases = Object.fromEntries(PHASES.map((p) => [p, {
    count: events.filter((e) => e.phase === p).length,
  }]));
  for (const p of PHASES) {
    const first = stamped.find((e) => e.phase === p);
    phases[p].first_at = first?.ts ?? null;
  }
  return { engagement_id: engagementId, events, phases, span_ms: span };
}

/** 渲染成等宽文本表（CLI 输出 / 报告附录均可复用）。 */
export function renderTimeline(timeline, { limit = 200 } = {}) {
  const lines = [];
  lines.push(`战役时序：${timeline.engagement_id}`);
  lines.push(`跨度：${timeline.span_ms === null ? '（不足两个带时间戳事件）' : `${Math.round(timeline.span_ms / 1000)}s`}`);
  lines.push('');
  lines.push('  时间(UTC)                 阶段   事件');
  for (const e of timeline.events.slice(0, limit)) {
    const ts = e.ts ? new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19) : '—（无时间戳）      ';
    lines.push(`  ${ts}  ${e.phase.padEnd(6)} ${e.kind}${e.detail ? ` · ${e.detail}` : ''}`);
  }
  if (timeline.events.length > limit) lines.push(`  …另有 ${timeline.events.length - limit} 条`);
  return lines.join('\n');
}
