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
/**
 * @param {{wave:object, defaultBucket?:'A'|'B'|'C'}} p
 *   defaultBucket：未在任务上显式声明 bucket 时使用的默认桶（通常来自家目录配置）
 */
export function planWave({ wave, defaultBucket = 'A' }) {
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
    tasks: wave.tasks.map((t) => {
      const bucket = t.bucket ?? defaultBucket;
      const wire = (t.wire_cost ?? 0) > 0;
      // 出口需求：需要出网的任务在桶 A/C 下必须有活跃 route；桶 B 是直连桶
      const needsEgress = wire || (t.action_class ?? 'readonly') !== 'readonly';
      const egress = !needsEgress ? 'none' : bucket === 'B' ? 'direct' : 'route';
      return {
        id: t.id, role: t.role, intent: t.intent ?? t.role,
        targets: t.targets, depends_on: t.depends_on ?? [],
        action_class: t.action_class ?? 'readonly',
        resource_kinds: (t.resources ?? []).map((r) => (typeof r === 'string' ? r : r.kind)),
        bucket, egress, needs_egress: needsEgress,
      };
    }),
    buckets: (() => {
      const counts = {};
      for (const t of wave.tasks) {
        const b = t.bucket ?? defaultBucket;
        counts[b] = (counts[b] ?? 0) + 1;
      }
      return counts;
    })(),
    default_bucket: defaultBucket,
    meeting_preview: { title: wave.title ?? '链前会议', notes: wave.notes ?? '（未填写纪要）', decisions: wave.decisions ?? [] },
  };
}

export function runWave({ broker, engagementId, wave, dryRun = false }) {
  if (!wave?.tasks?.length) throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'wave.tasks 为空');
  if (dryRun) {
    // 演练：只出计划（含会议预览/并发层/每任务的桶与出口需求），不落库、不派单、不占并发名额
    return {
      dry_run: true,
      plan: planWave({ wave, defaultBucket: wave.default_bucket ?? broker.config?.bucket ?? 'A' }),
    };
  }
  const store = broker._eng(engagementId).store;

  // 桶自洽预检（§4）：需要经 route 出网的任务必须在**开会之前**就有活跃出口，
  // 否则拒绝开工（不留半条会议纪要）；被拒的尝试记 wave_rejected 审计，仍可追溯。
  const defaultBucket = wave.default_bucket ?? broker.config?.bucket ?? 'A';
  const activeRoute = (() => {
    try {
      return store.db.prepare("SELECT * FROM jump_routes WHERE state = 'active' ORDER BY ts").all().at(-1) ?? null;
    } catch { return null; }
  })();
  // 整波算一次计划（含依赖校验；不要逐任务单独算——那样会把依赖当成"引用了不存在的任务"）
  const plannedTasks = planWave({ wave, defaultBucket }).tasks;
  for (const t of plannedTasks) {
    if (t.egress === 'route' && !activeRoute) {
      broker._gate(engagementId, 'wave_rejected', {
        task_id: t.id, bucket: t.bucket, reason: 'no_active_route',
      });
      throw warroomError(ERR.E_FENCE_NO_ROUTE,
        `任务 ${t.id} 需要经 route 出网（桶 ${t.bucket}），但没有活跃跳板路由；`
        + '先 jump acquire，或把该任务显式标为 bucket:"B"（本机直连）');
    }
  }

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

  // 下游“就绪”必须以上游**结项**为准（而非仅已派发）：依赖边意味着下游要消费上游产出的事实，
  // 回执未就绪的上游（异步执行器）不能算满足；否则在节奏档并发 ≥2 时，下游会抢在上游落库前开跑。
  const ready = (t) => (t.depends_on ?? []).every((dep) => results.get(dep)?.settled);
  let guard = 0;
  while (results.size < wave.tasks.length) {
    if (++guard > budget) {
      // 合法 DAG（planWave 已校验无环/无悬空）里走到这里只有一种可能：
      // 在飞任务迟迟不结项，导致下游依赖无法推进——如实报执行器未报终态，而不是误判成环。
      const stuck = inFlight.map((x) => x.id).join(',') || '(无在飞任务)';
      throw warroomError(ERR.E_GATE_CONCURRENCY_LIMIT,
        `波内任务长时间未结项，下游依赖无法推进：${stuck}`
        + '（执行器未报告终态；请 reconcile 或检查执行器）');
    }
    drain();                 // 先收口可结项的在飞任务，让已满足依赖的下游本轮即可交接
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
      results.set(t.id, item);
    }
    if (!progressed && inFlight.length === 0) {
      // 既无可派发任务、也无在飞任务可等——合法 DAG（planWave 已校验）不该出现，防御性报错
      throw warroomError(ERR.E_GATE_MISSING_TUPLE, '依赖无法满足：成环或引用了不存在的任务');
    }
    // 否则：要么本轮已派发，要么在等在飞任务结项以解锁下游——继续循环（由 budget 守卫兜底，避免真卡死）
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
