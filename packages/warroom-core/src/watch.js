// 巡检统一视图：把"现在有什么需要我处理的"答在一屏。
// 汇聚：活跃/失效路由、在飞与未决任务、心跳龄期、出口验证、壳状态、备份新鲜度、报告漂移。
// 只读：全部来自账本与库，不触发任何动作。
const IN_FLIGHT = ['queued', 'running', 'cancel_requested', 'unknown'];

/**
 * @param {{broker:object, engagementId:string, timeoutMin?:number}} p
 */
export function buildWatch({ broker, engagementId, timeoutMin = null }) {
  const store = broker._eng(engagementId).store;
  const nowMs = Date.now();
  const timeout = (timeoutMin ?? broker.config?.timeoutMin ?? 30) * 60_000;

  const routes = (() => {
    try { return store.db.prepare('SELECT * FROM jump_routes ORDER BY ts').all(); } catch { return []; }
  })();
  const cmds = broker.global.prepare(
    'SELECT command_id, task_id, state, ts, attempt, last_heartbeat_at FROM command_queue WHERE engagement_id = ? ORDER BY ts'
  ).all(engagementId);
  const inFlight = cmds.filter((c) => IN_FLIGHT.includes(c.state)).map((c) => {
    const baseline = Date.parse(c.last_heartbeat_at ?? c.ts);
    const ageMs = nowMs - baseline;
    return {
      task_id: c.task_id, state: c.state, attempt: c.attempt ?? 1,
      age_min: Math.round(ageMs / 60000),
      since: c.last_heartbeat_at ? 'heartbeat' : 'dispatch',
      overdue: ageMs > timeout,
    };
  });
  const egress = broker.egressStatus(engagementId);
  const shell = store.shellState() ?? null;
  // 油表摘要（值班一屏：告警与用量看一次就够，不必再跑第二条命令）
  const rate = broker.rateView(engagementId);

  const warnings = [];
  const staleRoutes = routes.filter((r) => r.state === 'stale');
  if (staleRoutes.length > 0) warnings.push(`${staleRoutes.length} 条路由已失效（stale）——围栏不会再取它们作出口`);
  const activeRoutes = routes.filter((r) => r.state === 'active');
  if (activeRoutes.length === 0) warnings.push('没有活跃跳板路由：需要出网的动作会被拒（先 jump acquire）');
  if (broker.config?.requireEgressCheck && !egress.valid) warnings.push('出口验证无效：出网动作会被拒绝（先跑 egress-check）');
  const overdue = inFlight.filter((t) => t.overdue);
  if (overdue.length > 0) warnings.push(`${overdue.length} 个任务超过超时阈值（${Math.round(timeout / 60000)} 分钟）——sweep 会转 unknown`);
  const unresolved = cmds.filter((c) => c.state === 'unresolved');
  if (unresolved.length > 0) warnings.push(`${unresolved.length} 个任务停在 unresolved：需人工处理残留资源后 reconcile`);
  if (rate.wire.exhausted) warnings.push('wire 预算已用尽：出网动作会被节奏闸拒绝（换档或等新窗口）');
  if (rate.spray.locked > 0) warnings.push(`喷洒台账已有 ${rate.spray.locked} 次锁定：同（服务×账号）一律停止重试`);

  return {
    engagement_id: engagementId,
    generated_at: new Date(nowMs).toISOString(),
    routes: {
      active: activeRoutes.map((r) => ({ route_id: r.route_id, jumphost_id: r.jumphost_id, socks: r.socks })),
      stale: staleRoutes.map((r) => ({ route_id: r.route_id, jumphost_id: r.jumphost_id })),
      other: routes.filter((r) => !['active', 'stale'].includes(r.state)).map((r) => ({ route_id: r.route_id, state: r.state })),
    },
    tasks: {
      total: cmds.length,
      by_state: cmds.reduce((acc, c) => { acc[c.state] = (acc[c.state] ?? 0) + 1; return acc; }, {}),
      in_flight: inFlight,
    },
    egress: { valid: egress.valid, last: egress.last, max_age_min: egress.max_age_min },
    rate: {
      rhythm: rate.rhythm,
      wire_used: rate.wire.used, wire_cap: rate.wire.cap, wire_remaining: rate.wire.remaining,
      wire_exhausted: rate.wire.exhausted,
      next_allowed_in_ms: rate.pacing.next_allowed_in_ms,
      min_interval_ms: rate.pacing.min_interval_ms,
      concurrency_cap: rate.concurrency.cap,
      spray_total: rate.spray.total, spray_locked: rate.spray.locked,
    },
    shell,
    warnings,
  };
}

/**
 * 舰队视图（指挥层）：所有战役的巡检汇总——哪些有事、哪些可交付。
 * 只读；每行给出最关键的四个数（在飞 / 告警 / 活跃路由 / 交付门禁）。
 */
export function buildFleetWatch({ broker, timeoutMin = null }) {
  const ids = broker.listEngagements();
  const rows = [];
  for (const id of ids) {
    try {
      const v = buildWatch({ broker, engagementId: id, timeoutMin });
      const checklist = (() => { try { return broker.checklist(id); } catch { return null; } })();
      rows.push({
        engagement_id: id,
        in_flight: v.tasks.in_flight.length,
        overdue: v.tasks.in_flight.filter((t) => t.overdue).length,
        active_routes: v.routes.active.length,
        stale_routes: v.routes.stale.length,
        warnings: v.warnings.length,
        warning_list: v.warnings,
        egress_valid: v.egress.valid,
        shell_proof: v.shell?.highest_proof ?? null,
        deliverable: checklist ? checklist.deliverable : null,
        blocked: checklist ? checklist.blocked.length : null,
      });
    } catch (e) {
      rows.push({ engagement_id: id, error: e.message, warnings: 1, warning_list: [e.message] });
    }
  }
  // 有事在前（告警数降序 → 在飞降序）
  rows.sort((a, b) => (b.warnings - a.warnings) || (b.in_flight - a.in_flight) || a.engagement_id.localeCompare(b.engagement_id));
  const withIssues = rows.filter((r) => r.warnings > 0);
  return {
    generated_at: new Date().toISOString(),
    totals: {
      engagements: rows.length,
      with_issues: withIssues.length,
      in_flight: rows.reduce((a, r) => a + (r.in_flight ?? 0), 0),
      overdue: rows.reduce((a, r) => a + (r.overdue ?? 0), 0),
      deliverable: rows.filter((r) => r.deliverable === true).length,
    },
    rows,
    no_issues: withIssues.length === 0,
  };
}

export function renderFleetWatch(f) {
  const lines = [];
  lines.push(`舰队视图（${f.generated_at}）`);
  lines.push('');
  lines.push(`战役 ${f.totals.engagements} 个 · 有事 ${f.totals.with_issues} 个 · 在飞任务 ${f.totals.in_flight}`
    + `（超阈值 ${f.totals.overdue}） · 可交付 ${f.totals.deliverable} 个`);
  lines.push('');
  if (f.totals.engagements === 0) {
    lines.push('（尚无战役）');
    return lines.join('\n');
  }
  lines.push('  战役                        在飞 超阈 路由 告警 交付   控制面');
  for (const r of f.rows) {
    if (r.error) {
      lines.push(`  ${r.engagement_id.slice(0, 26).padEnd(26)}  —    —    —    !  —     读取失败：${r.error}`);
      continue;
    }
    const id = r.engagement_id.length > 26 ? `${r.engagement_id.slice(0, 24)}…` : r.engagement_id.padEnd(26);
    lines.push(`  ${id} ${String(r.in_flight).padStart(3)} ${String(r.overdue).padStart(4)}`
      + ` ${String(r.active_routes).padStart(4)} ${String(r.warnings).padStart(4)}`
      + `  ${r.deliverable === true ? '✅' : r.deliverable === false ? `⬜${r.blocked}` : '—'}`.padEnd(20)
      + ` ${r.shell_proof ?? '—'}`);
  }
  if (!f.no_issues) {
    lines.push('');
    lines.push('需要处理：');
    for (const r of f.rows.filter((x) => x.warnings > 0)) {
      lines.push(`  ${r.engagement_id}：`);
      for (const w of r.warning_list ?? []) lines.push(`    - ${w}`);
    }
  }
  return lines.join('\n');
}

/** 等宽文本渲染（CLI）。 */
export function renderWatch(view) {
  const lines = [];
  lines.push(`巡检视图：${view.engagement_id}`);
  lines.push(`时间：${view.generated_at}`);
  lines.push('');
  lines.push(`路由：活跃 ${view.routes.active.length} · 失效 ${view.routes.stale.length} · 其它 ${view.routes.other.length}`);
  for (const r of view.routes.active) lines.push(`  [活跃] ${r.route_id} → 跳板 ${r.jumphost_id}（${r.socks}）`);
  for (const r of view.routes.stale) lines.push(`  [失效] ${r.route_id} → 跳板 ${r.jumphost_id}`);
  lines.push('');
  lines.push(`任务：共 ${view.tasks.total}；` + Object.entries(view.tasks.by_state).map(([k, v]) => `${k}=${v}`).join(' '));
  for (const t of view.tasks.in_flight) {
    lines.push(`  [在飞] ${t.task_id} ${t.state} · ${t.since} 后 ${t.age_min} 分钟`
      + `${t.overdue ? ' ⚠️ 超阈值' : ''}${t.attempt > 1 ? ` · attempt ${t.attempt}` : ''}`);
  }
  lines.push('');
  lines.push(`出口验证：${view.egress.valid ? '有效' : '无效/未做'}`
    + `${view.egress.last ? `（最近 ${view.egress.last.verdict}，${view.egress.last.exit_ip}）` : ''}`);
  const r = view.rate;
  const ms = (x) => (x === null || x === undefined ? '—' : `${Math.round(x)}ms`);
  lines.push(`油表（${r.rhythm}）：wire ${r.wire_used}${r.wire_cap > 0 ? `/${r.wire_cap}（剩 ${r.wire_remaining}）` : ''}`
    + `${r.wire_exhausted ? ' ⚠️ 已用尽' : ''} · 并发上限 ${r.concurrency_cap}`
    + ` · 本次要求间隔 ${ms(r.min_interval_ms)}`
    + `${r.next_allowed_in_ms > 0 ? `（还需等 ${ms(r.next_allowed_in_ms)}）` : '（可立即出网）'}`);
  if (r.spray_total > 0) {
    lines.push(`喷洒台账：${r.spray_total} 次${r.spray_locked > 0 ? ` · ⚠️ 锁定 ${r.spray_locked}` : ''}`);
  }
  lines.push(`壳状态：最高证明 ${view.shell?.highest_proof ?? '—'} · 当前有效性 ${view.shell?.current_validity ?? 'unknown'}`);
  if (view.warnings.length > 0) {
    lines.push('');
    lines.push('需要注意：');
    for (const w of view.warnings) lines.push(`  - ${w}`);
  } else {
    lines.push('');
    lines.push('需要注意：无');
  }
  return lines.join('\n');
}
