// 波次编排（框架 §3.5 运行时语义）：
//   链前会议（纪要落库）→ 按依赖派单 → 独立任务立即并行 → 依赖满足即刻交接下游（无批次屏障）
//   → 回执入库（成员级幂等）→ 未决项如实留在 unresolved/unknown。
import { randomUUID } from 'node:crypto';
import { ERR, RHYTHM_CONCURRENCY, warroomError } from '../../shared-types/src/index.js';

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

  // 节奏档并发上限：波内同时在飞任务不得超过它（否则会撞门闸，报错而非静默排队）
  const rhythm = broker._auth(engagementId).row.rhythm;
  const maxInFlight = wave.max_in_flight ?? RHYTHM_CONCURRENCY[rhythm] ?? 1;

  const results = new Map();   // task.id → {task_id, state, facts}
  const dispatched = new Set();
  const inFlight = [];         // 已派发但尚未结项的任务
  const budget = wave.tasks.length * 4 + 8; // 防死循环（依赖成环时如实报错）

  /** 收执并结项，释放并发名额（无副作用：已完成的任务直接返回）。 */
  const drain = () => {
    for (let i = inFlight.length - 1; i >= 0; i -= 1) {
      const item = inFlight[i];
      try {
        const receipt = broker.adapter.collect(item.task_id);
        const ingested = broker.collect(engagementId, item.task_id, receipt);
        item.facts = ingested.accepted
          ? (ingested.results ?? []).filter((x) => x.action === 'inserted' || x.action === 'superseded').length
          : 0;
        const settled = broker.settle(engagementId, item.task_id).settled;
        if (settled) {
          item.settled = true;
          inFlight.splice(i, 1);
        }
      } catch { /* 回执未就绪：保留在飞状态，交由 reconcile */ }
    }
  };

  const ready = (t) => (t.depends_on ?? []).every((dep) => results.has(dep));
  let guard = 0;
  while (results.size < wave.tasks.length) {
    if (++guard > budget) throw warroomError(ERR.E_GATE_MISSING_TUPLE, '依赖无法满足：疑似成环');
    let progressed = false;
    for (const t of wave.tasks) {
      if (dispatched.has(t.id) || !ready(t)) continue;
      if (inFlight.length >= maxInFlight) {
        drain();                       // 先尝试释放名额（放不下就等下一轮）
        if (inFlight.length >= maxInFlight) continue;
      }
      // 立即派发（不等待同波其它任务）——波内无屏障，但受节奏档并发约束
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
      const item = { id: t.id, role: t.role, task_id: r.task_id, state: r.state, facts: 0, settled: false };
      inFlight.push(item);

      // 回执 → 入库（成员级幂等）→ 结项（执行器报告终态后账本跟进）
      drain();
      if (!item.settled) {
        // 未结项意味着它仍占并发名额：下一轮会继续尝试 drain；若波结束仍未结项则如实报错
        progress_guard: { /* 见循环末尾的收口检查 */ }
      }
      results.set(t.id, item);
    }
    if (!progressed) {
      // 没有任何任务可推进：要么依赖成环，要么并发槽被未结项任务占满
      drain();
      if (inFlight.length >= maxInFlight) {
        throw warroomError(ERR.E_GATE_CONCURRENCY_LIMIT,
          `并发名额被 ${inFlight.length} 个未结项任务占满（上限 ${maxInFlight}，节奏档 ${rhythm}）；`
          + '请检查执行器是否报告终态，或用 reconcile 定论后再继续');
      }
      throw warroomError(ERR.E_GATE_MISSING_TUPLE, '依赖无法满足：成环或引用了不存在的任务');
    }
  }

  // 收口：所有任务都必须结项，否则如实报告（不允许"看起来跑完"）
  const unsettled = [...results.values()].filter((r) => !r.settled);
  if (unsettled.length > 0) {
    throw warroomError(ERR.E_GATE_CONCURRENCY_LIMIT,
      `波结束后仍有 ${unsettled.length} 个任务未结项：${unsettled.map((u) => u.id).join(',')}`
      + '（执行器未报告终态；请 reconcile 或检查执行器）');
  }

  return {
    meeting,
    tasks: [...results.values()],
    order: [...results.keys()],
    facts_inserted: [...results.values()].reduce((a, r) => a + (r.facts ?? 0), 0),
    max_in_flight: maxInFlight,
    rhythm,
  };
}
