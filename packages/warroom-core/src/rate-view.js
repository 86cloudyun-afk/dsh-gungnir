// 速率与预算视图（框架 §4：节奏档限流对象 = wire_requests）——"油表"。
// 只读：把 wire 用量/预算/当前最小间隔（含抖动与漂移）/喷洒台账概况摊在一处。
import { RHYTHM_CONCURRENCY, RHYTHM_JITTER_MS, RHYTHM_MIN_INTERVAL_MS, RHYTHM_WIRE_CAP } from '../../shared-types/src/index.js';

/**
 * @param {{broker:object, engagementId:string}} p
 */
export function buildRateView({ broker, engagementId }) {
  const store = broker._eng(engagementId).store;
  const row = store.db.prepare('SELECT rhythm FROM engagements WHERE id = ?').get(engagementId);
  const rhythm = row?.rhythm ?? broker.config?.rhythm ?? 'restricted';
  const cap = RHYTHM_WIRE_CAP[rhythm] ?? 0;
  const used = store.rateTotal('wire');
  const lastTs = store.lastRateTs('wire');
  const requiredGapMs = broker._requiredGap(rhythm);
  const elapsed = lastTs ? Date.now() - Date.parse(lastTs) : null;

  const byTarget = store.db.prepare(
    "SELECT target, SUM(amount) AS n, COUNT(*) AS requests FROM rate_ledger WHERE kind = 'wire' GROUP BY target ORDER BY n DESC"
  ).all();
  const spray = store.spraySummary();
  const sprayTotal = spray.reduce((a, b) => a + b.n, 0);
  const locked = spray.find((s) => s.result === 'locked')?.n ?? 0;

  const next_allowed_in_ms = requiredGapMs > 0 && elapsed !== null && elapsed < requiredGapMs
    ? requiredGapMs - elapsed
    : 0;

  return {
    engagement_id: engagementId,
    rhythm,
    wire: {
      used,
      cap,
      remaining: cap > 0 ? Math.max(0, cap - used) : null,
      exhausted: cap > 0 && used >= cap,
      by_target: byTarget,
    },
    pacing: {
      min_interval_ms: requiredGapMs,
      base_ms: RHYTHM_MIN_INTERVAL_MS[rhythm] ?? 0,
      jitter: RHYTHM_JITTER_MS[rhythm] ?? null,
      last_wire_at: lastTs,
      elapsed_ms: elapsed,
      next_allowed_in_ms,
    },
    concurrency: { cap: RHYTHM_CONCURRENCY[rhythm] ?? 1 },
    spray: { total: sprayTotal, by_result: spray, locked },
    policy: '预算不是成本门闸，但**节奏档的 wire 上限与最小间隔是硬门闸**（框架 §4）；本视图只读',
  };
}

export function renderRateView(v) {
  const lines = [];
  const ms = (x) => (x === null || x === undefined ? '—' : `${Math.round(x)}ms`);
  lines.push(`速率与预算：${v.engagement_id}（节奏档 ${v.rhythm}）`);
  lines.push('');
  lines.push(`wire 用量：${v.wire.used}${v.wire.cap > 0 ? ` / ${v.wire.cap}（剩余 ${v.wire.remaining}）` : '（该档无上限）'}`
    + `${v.wire.exhausted ? ' ⚠️ 已用尽' : ''}`);
  for (const t of v.wire.by_target) lines.push(`  ${t.target}：${t.n}（${t.requests} 次请求）`);
  lines.push('');
  lines.push(`节奏：基础 ${ms(v.pacing.base_ms)} · 本次要求 ${ms(v.pacing.min_interval_ms)}`
    + `${v.pacing.jitter ? `（抖动区间 ${v.pacing.jitter[0]}~${v.pacing.jitter[1]}ms）` : ''}`);
  lines.push(`距上次出网：${ms(v.pacing.elapsed_ms)}${v.pacing.next_allowed_in_ms > 0 ? ` · 还需等待 ${ms(v.pacing.next_allowed_in_ms)}` : ' · 可立即出网'}`);
  lines.push(`并发上限：${v.concurrency.cap}`);
  lines.push('');
  lines.push(`喷洒台账：共 ${v.spray.total} 次` + (v.spray.by_result.length ? `（${v.spray.by_result.map((s) => `${s.result}=${s.n}`).join(' ')}）` : '')
    + `${v.spray.locked > 0 ? ` ⚠️ 已锁定 ${v.spray.locked} 次` : ''}`);
  return lines.join('\n');
}
