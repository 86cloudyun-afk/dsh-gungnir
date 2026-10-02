// 时序分段视图（报告用）：逐任务的 派发→回执→结项 与耗时，配 ASCII 条。
// 为什么不用 mermaid gantt：报告要**离线可读**（打印/无渲染器环境），ASCII 条在任何终端与纸面上都成立。
const BAR_WIDTH = 24;

/** 时长格式化（ms）。 */
const fmt = (ms) => {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}min`;
  return `${(ms / 3600000).toFixed(1)}h`;
};

const barFor = (ms, scale) => {
  if (!ms || !scale) return '';
  const n = Math.max(1, Math.round((ms / scale) * BAR_WIDTH));
  return '█'.repeat(Math.min(BAR_WIDTH, n));
};

/**
 * @param {{events:Array<{ts:string|null,phase:string,kind:string,detail:string}>}} timeline
 * @returns {{tasks:Array<{task_id,dispatched_at,collected_at,settled_at,handoff_ms,exec_ms,bar_handoff,bar_exec}>,
 *            scale_ms:number, note:string}}
 */
export function buildGantt(timeline) {
  // gate_log 的事件负载是 JSON（collect/settle）；command_queue 派发事件的 detail 是人类可读文本
  // （"任务 wt_xxx（attempt 1）"）——因此两段解析并用：先收 id，再用 id 匹配派发事件。
  const parseJsonId = (d) => {
    const m = /\{"task_id":"([^"]+)"/.exec(d ?? '');
    return m ? m[1] : null;
  };
  const tasks = new Map();
  const ensure = (id) => {
    if (!tasks.has(id)) tasks.set(id, { task_id: id, dispatched_at: null, collected_at: null, settled_at: null });
    return tasks.get(id);
  };

  // 第一遍：从 JSON 事件收集任务 id（权威来源）
  for (const e of timeline.events) {
    if ((e.kind === 'collect' || e.kind === 'settle')) {
      const id = parseJsonId(e.detail);
      if (id) ensure(id);
    }
  }
  // 第二遍：落时间戳（派发事件用已知 id 匹配；孤立的派发任务按 wt_ 形态兜底提取）
  for (const e of timeline.events) {
    if (!e.ts) continue;
    if (e.kind === 'dispatch') {
      const detail = e.detail ?? '';
      const known = [...tasks.keys()].find((id) => detail.includes(id));
      const id = known ?? (/wt_[0-9a-fA-F-]{6,}/.exec(detail) ?? [])[0] ?? null;
      if (id) ensure(id).dispatched_at = e.ts;
    } else if (e.kind === 'collect' || e.kind === 'settle') {
      const id = parseJsonId(e.detail);
      if (!id) continue;
      const t = ensure(id);
      if (e.kind === 'collect' && !t.collected_at) t.collected_at = e.ts;
      if (e.kind === 'settle' && !t.settled_at) t.settled_at = e.ts;
    }
  }

  const rows = [];
  for (const t of tasks.values()) {
    const d = t.dispatched_at ? Date.parse(t.dispatched_at) : null;
    const c = t.collected_at ? Date.parse(t.collected_at) : null;
    const s = t.settled_at ? Date.parse(t.settled_at) : null;
    rows.push({
      ...t,
      handoff_ms: d !== null && c !== null ? Math.max(0, c - d) : null,
      exec_ms: c !== null && s !== null ? Math.max(0, s - c) : null,
    });
  }
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.handoff_ms ?? 0, r.exec_ms ?? 0)));
  for (const r of rows) {
    r.bar_handoff = barFor(r.handoff_ms, scale);
    r.bar_exec = barFor(r.exec_ms, scale);
  }
  return {
    tasks: rows.sort((a, b) => String(a.dispatched_at).localeCompare(String(b.dispatched_at))),
    scale_ms: scale,
    note: `条长按最大分段（${fmt(scale)}）等比缩放；无时间戳的段显示 "—"（账本里没有就不编）`,
  };
}

/** 渲染为 markdown 段（等宽条在 md/HTML/打印里都成立）。 */
export function renderGantt(g) {
  const lines = [];
  lines.push('| 任务 | 派发 | 交接 | 执行 | 条（交接 / 执行） |');
  lines.push('|---|---|---|---|---|');
  for (const t of g.tasks) {
    const short = t.task_id.length > 18 ? `${t.task_id.slice(0, 16)}…` : t.task_id;
    lines.push(`| \`${short}\` | ${t.dispatched_at?.slice(11, 19) ?? '—'} | ${fmt(t.handoff_ms)}`
      + ` | ${fmt(t.exec_ms)} | \`${t.bar_handoff || '—'} / ${t.bar_exec || '—'}\` |`);
  }
  lines.push('');
  lines.push(`> ${g.note}`);
  return lines.join('\n');
}
