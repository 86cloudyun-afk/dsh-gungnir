// 效率数据导出（CSV/JSON 表格）：把 metrics() 的分桶与分段摊平成行，供表格工具消费。
// 用途：复盘"哪条线/哪个档位划算"、给编制决策留数；本框架自身不做成本门闸。
const csvEsc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * @returns {{csv:string, rows:Array<object>}} 行格式：section,key,metric,value
 */
export function metricsToRows(metrics) {
  const rows = [];
  const push = (section, key, metric, value) => rows.push({ section, key, metric, value });

  push('total', 'all', 'tasks', metrics.tasks);
  push('total', 'all', 'commands', metrics.commands);
  push('total', 'all', 'tokens_in', metrics.tokens_in);
  push('total', 'all', 'tokens_out', metrics.tokens_out);
  push('total', 'all', 'wall_time_ms', metrics.wall_time_ms);
  push('total', 'all', 'verified_facts', metrics.verified_facts);
  push('total', 'all', 'effective_facts', metrics.effective_facts);
  push('total', 'all', 'facts_per_1000_tokens', metrics.facts_per_1000_tokens);
  push('total', 'all', 'ms_per_fact', metrics.ms_per_fact);

  const seg = metrics.segments ?? {};
  push('segment', 'queue', 'ms', seg.queue_ms);
  push('segment', 'handoff', 'ms', seg.handoff_ms);
  push('segment', 'exec', 'ms', seg.exec_ms);
  push('segment', 'handoff', 'samples', seg.samples?.handoff ?? null);
  push('segment', 'exec', 'samples', seg.samples?.exec ?? null);
  push('rework', 'all', 'tasks', seg.rework?.tasks ?? null);
  push('rework', 'all', 'wall_ms', seg.rework?.wall_ms ?? null);

  for (const [role, v] of Object.entries(metrics.by_role ?? {})) {
    push('by_role', role, 'tasks', v.tasks);
    push('by_role', role, 'tokens', v.tokens);
    push('by_role', role, 'verified', v.verified);
    push('by_role', role, 'wall_time_ms', v.wall_time_ms);
    push('by_role', role, 'facts_per_1000_tokens', v.facts_per_1000_tokens);
    push('by_role', role, 'ms_per_verified_fact', v.ms_per_verified_fact);
  }
  for (const [tier, v] of Object.entries(metrics.by_tier ?? {})) {
    push('by_tier', tier, 'tasks', v.tasks);
    push('by_tier', tier, 'tokens', v.tokens);
    push('by_tier', tier, 'verified', v.verified);
    push('by_tier', tier, 'wall_time_ms', v.wall_time_ms);
    push('by_tier', tier, 'facts_per_1000_tokens', v.facts_per_1000_tokens);
    push('by_tier', tier, 'ms_per_verified_fact', v.ms_per_verified_fact);
  }
  push('retry', 'all', 'tasks_with_retry', metrics.rework?.tasks_with_retry ?? null);
  push('retry', 'all', 'retry_rate', metrics.rework?.retry_rate ?? null);
  push('retry', 'all', 'unresolved', metrics.rework?.unresolved ?? null);
  push('retry', 'all', 'unknown', metrics.rework?.unknown ?? null);

  const header = 'section,key,metric,value';
  const body = rows.map((r) => [r.section, r.key, r.metric, r.value].map(csvEsc).join(','));
  return { rows, csv: [header, ...body].join('\n') + '\n' };
}
