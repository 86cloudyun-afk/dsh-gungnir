// 多战役周报：指挥层视角的"这一周干了什么"。
// 数据来自各战役库（只读）+ 备份目录；每行一个战役：起止、事实、控制面、交付门禁、报告新鲜度。
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {{broker:object, days?:number, now?:number}} p
 * @returns {{window:{from:string,to:string,days:number}, rows:Array, totals:object}}
 */
export function buildWeekly({ broker, days = 7, now = Date.now() }) {
  const fromMs = now - days * 86400000;
  const ids = broker.listEngagements();
  const rows = [];
  for (const id of ids) {
    let store;
    try { store = broker._eng(id).store; } catch { continue; }
    const eng = store.db.prepare('SELECT * FROM engagements WHERE id = ?').get(id);
    const createdMs = eng?.created_at ? Date.parse(eng.created_at) : null;
    const facts = store.db.prepare(
      'SELECT entity_type, COUNT(*) AS n FROM fact_members WHERE active = 1 GROUP BY entity_type'
    ).all();
    const factTotal = facts.reduce((a, b) => a + b.n, 0);
    const gates = store.db.prepare('SELECT COUNT(*) AS n FROM gate_log').get().n;
    const shell = store.shellState();

    // 报告新鲜度（最近一份报告 + 是否仍与库一致）
    const reportsDir = join(broker.home, 'engagements', id, 'reports');
    const reports = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((f) => f.endsWith('.md'))
        .map((f) => ({ f, m: statSync(join(reportsDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)
      : [];
    const reportsInWindow = reports.filter((r) => r.m >= fromMs).length;

    const checklist = (() => {
      try { return broker.checklist(id); } catch { return null; }
    })();

    // 窗口过滤：窗口内**有活动**（新建、报告、或事实时间戳在窗口内）才算进周报
    const factsInWindow = store.db.prepare(
      'SELECT COUNT(*) AS n FROM fact_members WHERE active = 1 AND ts >= ?'
    ).get(new Date(fromMs).toISOString()).n;
    const active = (createdMs !== null && createdMs >= fromMs) || reportsInWindow > 0 || factsInWindow > 0;
    if (!active) continue;

    rows.push({
      engagement_id: id,
      created_at: eng?.created_at ?? null,
      rhythm: eng?.rhythm ?? null,
      target_scope: eng?.target_scope ?? null,
      facts: factTotal,
      facts_in_window: factsInWindow,
      by_type: Object.fromEntries(facts.map((f) => [f.entity_type, f.n])),
      gate_entries: gates,
      shell: shell ? { highest_proof: shell.highest_proof, current_validity: shell.current_validity } : null,
      reports: reports.length,
      reports_in_window: reportsInWindow,
      last_report_at: reports[0] ? new Date(reports[0].m).toISOString() : null,
      delivery: checklist ? { deliverable: checklist.deliverable, blocked: checklist.blocked.length } : null,
    });
  }

  rows.sort((a, b) => (Date.parse(b.created_at ?? 0) || 0) - (Date.parse(a.created_at ?? 0) || 0));
  const totals = {
    engagements: rows.length,
    facts: rows.reduce((a, r) => a + r.facts, 0),
    facts_in_window: rows.reduce((a, r) => a + r.facts_in_window, 0),
    reports_in_window: rows.reduce((a, r) => a + r.reports_in_window, 0),
    deliverable: rows.filter((r) => r.delivery?.deliverable).length,
    shells: rows.filter((r) => r.shell?.highest_proof).length,
  };
  return {
    window: { from: new Date(fromMs).toISOString(), to: new Date(now).toISOString(), days },
    rows, totals,
    note: '只统计窗口内有活动的战役（新建/新事实/新报告）；判定依据为账本与文件，未含人工结论',
  };
}

/** ISO 周标签（YYYY-Www），用于归档文件名。 */
export function isoWeekLabel(ms = Date.now()) {
  const d = new Date(ms);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;          // 周一=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3);  // 移到本周周四
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * 归档周报：写到 `<home>/reports/weekly/<ISO 周>.md`（同周重复执行即覆盖，保持最新）。
 * @returns {{path:string, label:string, existing:string[]}}
 */
export function archiveWeekly({ broker, days = 7, now = Date.now() }) {
  const w = buildWeekly({ broker, days, now });
  const dir = join(broker.home, 'reports', 'weekly');
  mkdirSync(dir, { recursive: true });
  const label = isoWeekLabel(now);
  const path = join(dir, `${label}.md`);
  writeFileSync(path, `${renderWeekly(w)}\n`, 'utf8');
  const existing = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse();
  return { path, label, existing, totals: w.totals };
}

export function renderWeekly(w) {
  const lines = [];
  lines.push(`# 战役周报（近 ${w.window.days} 天）`);
  lines.push('');
  lines.push(`窗口：${w.window.from} → ${w.window.to}`);
  lines.push('');
  lines.push(`- 活跃战役：**${w.totals.engagements}** 个（其中交付门禁通过 ${w.totals.deliverable} 个）`);
  lines.push(`- 事实：新增 ${w.totals.facts_in_window} 条 / 累计 ${w.totals.facts} 条`);
  lines.push(`- 报告：本窗口出 ${w.totals.reports_in_window} 份 · 有控制面证明的战役 ${w.totals.shells} 个`);
  lines.push('');
  lines.push('| 战役 | 目标 | 节奏 | 窗口内事实 | 累计事实 | 报告(窗口内) | 交付门禁 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of w.rows) {
    lines.push(`| \`${r.engagement_id.slice(0, 18)}…\` | ${r.target_scope ?? '—'} | ${r.rhythm ?? '—'}`
      + ` | ${r.facts_in_window} | ${r.facts} | ${r.reports_in_window}/${r.reports}`
      + ` | ${r.delivery ? (r.delivery.deliverable ? '✅ 可交付' : `⬜ 未过 ${r.delivery.blocked} 项`) : '—'} |`);
  }
  lines.push('');
  lines.push(`> ${w.note}`);
  return lines.join('\n');
}
