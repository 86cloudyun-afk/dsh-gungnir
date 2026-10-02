// 波次编排（框架 §3.5 运行时语义）：
//   链前会议（纪要落库）→ 按依赖派单 → 独立任务立即并行 → 依赖满足即刻交接下游（无批次屏障）
//   → 回执入库（成员级幂等）→ 未决项如实留在 unresolved/unknown。
import { randomUUID } from 'node:crypto';
import { ERR, warroomError } from '../../shared-types/src/index.js';

/** 会议纪要：会不开，波不发。 */
export function recordMeeting({ store, engagementId, title, notes, decisions = [] }) {
  if (!title || !notes) throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'recordMeeting 需要 title 与 notes');
  const meeting_id = `mt_${randomUUID()}`;
  store.db.prepare(`INSERT INTO meetings (meeting_id, engagement_id, title, notes, decisions, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    meeting_id, engagementId, title, notes, JSON.stringify(decisions), new Date().toISOString());
  store.appendGateLog({ decision: 'meeting', detail: title, request: meeting_id });
  return { meeting_id, title, decisions };
}

export function listMeetings({ store }) {
  return store.db.prepare('SELECT * FROM meetings ORDER BY created_at DESC').all();
}

/**
 * 执行一波：任务图按依赖立即交接。
 * @param {{broker:object, engagementId:string, wave:{title:string, notes:string,
 *   tasks:Array<{id:string, role:string, targets:string[], intent?:string,
 *                action_class?:string, depends_on?:string[], resources?:any[], members?:object[]}>}}} p
 */
/**
 * 拓扑排序（不执行）：返回可派发顺序；成环/悬空依赖抛出与执行路径一致的错误。
 * 用于演练（dry-run）与实际派单共用同一依赖判定，避免"演练能过、真跑挂"。
 */
export function planWave({ wave }) {
  if (!wave?.tasks?.length) throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'wave.tasks 为空');
  const byId = new Map(wave.tasks.map((t) => [t.id, t]));
  for (const t of wave.tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!byId.has(dep)) throw warroomError(ERR.E_GATE_MISSING_TUPLE, `依赖无法满足：任务 ${t.id} 依赖不存在的 ${dep}`);
    }
  }
  const order = [];
  const done = new Set();
  let guard = 0;
  while (order.length < wave.tasks.length) {
    if (++guard > wave.tasks.length * 4 + 8) {
      throw warroomError(ERR.E_GATE_MISSING_TUPLE, '依赖无法满足：疑似成环');
    }
    for (const t of wave.tasks) {
      if (done.has(t.id)) continue;
      if ((t.depends_on ?? []).every((d) => done.has(d))) {
        done.add(t.id);
        order.push(t);
      }
    }
  }
  return {
    order: order.map((t) => t.id),
    // 波内可并行的层：同一层内任务互不依赖（便于预测并发占用）
    layers: (() => {
      const layers = [];
      const placed = new Set();
      while (placed.size < wave.tasks.length) {
        const layer = order.filter((t) => !placed.has(t.id) && (t.depends_on ?? []).every((d) => placed.has(d)));
        if (layer.length === 0) break;
        layer.forEach((t) => placed.add(t.id));
        layers.push(layer.map((t) => t.id));
      }
      return layers;
    })(),
    tasks: wave.tasks.map((t) => ({
      id: t.id, role: t.role, intent: t.intent ?? t.role,
      targets: t.targets, depends_on: t.depends_on ?? [],
      action_class: t.action_class ?? 'readonly',
      resource_kinds: (t.resources ?? []).map((r) => (typeof r === 'string' ? r : r.kind)),
    })),
    meeting_preview: { title: wave.title ?? '链前会议', notes: wave.notes ?? '（未填写纪要）', decisions: wave.decisions ?? [] },
  };
}

export function runWave({ broker, engagementId, wave, dryRun = false }) {
  if (!wave?.tasks?.length) throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'wave.tasks 为空');
  if (dryRun) {
    // 演练：只出计划（含会议预览与并发层），不落库、不派单、不消耗并发名额
    return { dry_run: true, plan: planWave({ wave }) };
  }
  const store = broker._eng(engagementId).store;
  const meeting = recordMeeting({
    store, engagementId, title: wave.title ?? '链前会议',
    notes: wave.notes ?? '（未填写纪要）', decisions: wave.decisions ?? [],
  });

  const results = new Map();   // task.id → {task_id, state, facts}
  const dispatched = new Set();
  const budget = wave.tasks.length * 4 + 8; // 防死循环（依赖成环时如实报错）

  const ready = (t) => (t.depends_on ?? []).every((dep) => results.has(dep));
  let guard = 0;
  while (results.size < wave.tasks.length) {
    if (++guard > budget) throw warroomError(ERR.E_GATE_MISSING_TUPLE, '依赖无法满足：疑似成环');
    let progressed = false;
    for (const t of wave.tasks) {
      if (dispatched.has(t.id) || !ready(t)) continue;
      // 立即派发（不等待同波其它任务）——波内无屏障
      const r = broker.execute({
        command_id: `wave-${meeting.meeting_id}-${t.id}`,
        engagement_id: engagementId,
        auth_version: broker._auth(engagementId).row.auth_version,
        contract: {
          targets: t.targets,
          action_class: t.action_class ?? 'readonly',
          resources: t.resources ?? [],
          intent: t.intent ?? t.role,
          wire_cost: 0,
          fake_members: t.members ?? [{
            entity_type: 'asset', source_id: `${t.id}-fact`, revision_no: 1,
            content_hash: `h-${t.id}`, payload: { role: t.role, task: t.id },
          }],
        },
      });
      dispatched.add(t.id);
      progressed = true;

      // 回执 → 入库（成员级幂等）→ 结项（执行器报告终态后账本跟进）
      let facts = 0;
      let settled = false;
      try {
        const receipt = broker.adapter.collect(r.task_id);
        const ingested = broker.collect(engagementId, r.task_id, receipt);
        facts = ingested.accepted ? (ingested.results ?? []).filter((x) => x.action === 'inserted' || x.action === 'superseded').length : 0;
        settled = broker.settle(engagementId, r.task_id).settled;
      } catch { /* 回执未就绪：任务保留在账本中，交由 reconcile */ }
      if (!settled) {
        // 未结项意味着它仍占并发名额：诚实报错，交由调用方降节奏/换 adapter，而不是死等
        throw warroomError(ERR.E_GATE_CONCURRENCY_LIMIT,
          `任务 ${t.id} 未结项（执行器未报告终态），仍占用并发名额；请降低波内并发或检查执行器`);
      }
      results.set(t.id, { id: t.id, role: t.role, task_id: r.task_id, state: r.state, facts });
    }
    if (!progressed) throw warroomError(ERR.E_GATE_MISSING_TUPLE, '依赖无法满足：成环或引用了不存在的任务');
  }

  return {
    meeting,
    tasks: [...results.values()],
    order: [...results.keys()],
    facts_inserted: [...results.values()].reduce((a, r) => a + r.facts, 0),
  };
}
