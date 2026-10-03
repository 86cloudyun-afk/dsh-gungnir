// 报告导出器（框架 §5）：水位绑定 + 事实视图 + IOC/清理附录（半自动初稿）+ 脱敏双保险。
// 报告双属性：给客户的可复现攻击报告 = 给蓝队的 IOC 排查清单（同一份证据的两个视图）。
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { KnowledgeBase } from './knowledge.js';
import { renderHtml } from './html.js';
import { buildRemediation } from './remediation.js';
import { buildTimeline } from './timeline.js';
import { buildGantt, renderGantt } from './gantt.js';
import { buildImpact, renderImpact } from './impact.js';
import { dirname, join } from 'node:path';
import { redactDeep } from './redactor.js';
import { aggregateIoc } from './ioc.js';
import { buildTopology, toMermaidGrouped } from './topology.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * 蓝队口径：把 IOC 段整体前移到「水位」之后（排查清单先看到要拉黑的指标）。
 * 只做整段搬迁，不改段内容——排版顺序是视图差异，不是事实差异。
 */
function prioritizeSections(lines, keyword) {
  const head = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      cur = { title: line, body: [line] };
      sections.push(cur);
    } else if (cur) cur.body.push(line);
    else head.push(line);
  }
  const idx = sections.findIndex((sec) => sec.title.includes(keyword));
  if (idx < 0) return lines;
  const [ioc] = sections.splice(idx, 1);
  const anchor = sections.findIndex((sec) => sec.title.includes('水位'));
  const at = anchor >= 0 ? anchor + 1 : 0;
  sections.splice(at, 0, ioc);
  return [...head, ...sections.flatMap((sec) => sec.body)];
}

/** 知识库用量（读不到就当作空：报告不因知识库缺失而失败）。 */
function readKbUsage(home, engagementId) {
  if (!home) return { rows: [], total: 0, distinct_pocs: 0, by_result: {} };
  try { return new KnowledgeBase({ home }).usageByEngagement(engagementId); }
  catch { return { rows: [], total: 0, distinct_pocs: 0, by_result: {} }; }
}

const ENTITY_ORDER = ['asset', 'domain', 'vuln', 'credential', 'session', 'chain', 'shell', 'persistence'];

function groupBy(rows, keyFn) {
  const out = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/** IOC / 清理候选（自动聚合，见 ioc.js）：带置信度与证据引用，人工确认后交付。 */
export function buildIocDraft({ store, engagementId, globalDb }) {
  return aggregateIoc({ store, globalDb, engagementId });
}

/** 结构化报告（机器可读）：与 markdown 报告同水位、同证据摘要。 */
export function buildReportJson({ store, engagementId, engagementRow, vault, globalDb, home = null, metrics = null }) {
  const snap = store.exportSnapshot();
  // 完整快照用于历史与水位；派生结论只消费有效修订（ADR-002 D5）。
  const activeRows = snap.rows.filter((r) => r.active === 1);
  const R = (v) => (vault ? redactDeep(v, vault.values()) : v);
  const facts = snap.rows.map((r) => {
    const { payload, ...rest } = r;
    let parsed = {};
    try { parsed = JSON.parse(payload ?? '{}'); } catch { parsed = { raw: payload }; }
    return { ...rest, payload: R(parsed) };
  });
  const effectiveFacts = facts.filter((f) => f.active === 1);
  // 审计摘要（门闸判定分布）与跳板台账（隧道收口清单）
  const auditSummary = (() => {
    try { return store.db.prepare('SELECT decision, COUNT(*) AS n FROM gate_log GROUP BY decision ORDER BY n DESC').all(); }
    catch { return []; }
  })();
  const routes = (() => {
    try { return store.db.prepare('SELECT * FROM jump_routes ORDER BY ts').all(); }
    catch { return []; }
  })();

  // 攻击路径拓扑（只按 payload 里明写的引用画边，不猜）
  const topology = buildTopology(activeRows);
  const remediation = buildRemediation(effectiveFacts);
  // 时序分段（逐任务 派发→回执→结项）：账本里没有的事件不出现，段缺时间戳就显示 —
  const timeline = buildTimeline({ store, globalDb, engagementId });
  const gantt = buildGantt(timeline);

  // 影响面摘要（与 md 版同源同算法）
  const impact = buildImpact(effectiveFacts, store.shellState());

  // 知识库复用（POC 跨战役复用是本框架的长期价值所在：这次用了什么、成没成）
  const kbUsage = readKbUsage(home, engagementId);

  const ioc = buildIocDraft({ store, engagementId, globalDb });
  const meetings = (() => {
    try {
      return store.db.prepare('SELECT * FROM meetings ORDER BY created_at').all()
        .map((m) => ({ ...m, decisions: (() => { try { return JSON.parse(m.decisions ?? '[]'); } catch { return []; } })() }));
    } catch { return []; }
  })();
  const digest = sha(JSON.stringify(snap.rows));
  return {
    schema: 'gungnir-report/1',
    engagement: {
      id: engagementId,
      auth_version: engagementRow?.auth_version ?? null,
      auth_hash: engagementRow?.auth_hash ?? null,
      rhythm: engagementRow?.rhythm ?? null,
      window: { start: engagementRow?.window_start ?? null, end: engagementRow?.window_end ?? null },
    },
    watermark: { seq: snap.seq, snapshot_id: snap.snapshot_id, exported_at: snap.exported_at },
    evidence_digests: { fact_members: digest },
    shell: store.shellState() ?? { highest_proof: null, current_validity: 'unknown', last_verified_at: null },
    meetings: R(meetings),
    audit_summary: auditSummary,
    jump_routes: routes,
    kb_usage: kbUsage,
    topology: R(topology),
    remediation: R(remediation),
    impact: R(impact),
    timing: {
      tasks: gantt.tasks.map((t) => ({
        task_id: t.task_id, dispatched_at: t.dispatched_at,
        collected_at: t.collected_at, settled_at: t.settled_at,
        handoff_ms: t.handoff_ms, exec_ms: t.exec_ms,
      })),
      phases: timeline.phases,
      span_ms: timeline.span_ms,
    },
    efficiency: metrics ? {
      queue_ms: metrics.segments?.queue_ms ?? null,
      handoff_ms: metrics.segments?.handoff_ms ?? null,
      exec_ms: metrics.segments?.exec_ms ?? null,
      rework: metrics.segments?.rework ?? null,
      by_role: metrics.by_role ?? {},
      by_tier: metrics.by_tier ?? {},
    } : null,
    facts: { effective: effectiveFacts, quarantined: facts.filter((f) => f.active !== 1) },
    ioc: ioc.items,
    ioc_summary: ioc.summary,
  };
}

/**
 * 生成报告 markdown（含水位）；所有文本过 redactor。
 * @param {{maxFactsPerType?:number}} opts.maxFactsPerType 每类事实最多列出多少条（默认 50），
 *   超出部分只给计数与摘要——避免大 N 下报告被事实流水账淹没（全量在 JSON 视图里）。
 */
/**
 * @param {'client'|'blue'|'full'} opts.audience 报告受众：
 *   client —— 客户版：攻击路径 + 影响面 + 修复建议（不铺审计明细与知识库内部记账）
 *   blue   —— 蓝队版：IOC 清单优先 + 审计摘要 + 事实证据引用（排查口径）
 *   full   —— 全量（默认，内部归档/交叉复核用）
 */
export function buildReport({ store, engagementId, engagementRow, vault, globalDb, home = null, maxFactsPerType = 50, audience = 'full', metrics = null }) {
  const snap = store.exportSnapshot();
  const activeRows = snap.rows.filter((r) => r.active === 1);
  const values = vault ? vault.values() : [];
  const R = (s) => (vault ? vault.redact(s) : String(s));
  const facts = snap.rows.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload || '{}'),
  }));

  const effective = facts.filter((f) => f.active === 1);
  const effectiveFacts = vault
    ? effective.map((f) => ({ ...f, payload: redactDeep(f.payload, values) }))
    : effective;
  const quarantined = facts.filter((f) => f.active !== 1);
  const grouped = groupBy(effective, (f) => f.entity_type);
  // 影响面摘要（客户视角）：只依据已落库证据，未评估的写"未评估"
  const impact = buildImpact(effectiveFacts, store.shellState());

  const lines = [];
  lines.push(`# GUNGNIR 战役报告 · ${engagementId}`);
  lines.push('');
  lines.push('> 100% 红队工具产出；仅限授权范围内使用。IOC 附录可供蓝队排查，与攻击报告同源同水位。');
  lines.push('');
  lines.push('## 水位（复现锚点）');
  lines.push('');
  lines.push(`- seq: \`${snap.seq}\``);
  lines.push(`- snapshot_id: \`${snap.snapshot_id}\``);
  lines.push(`- exported_at: \`${snap.exported_at}\``);
  lines.push('- 复现方式：以同一 fact.db + 上述水位重新导出，内容应与本报告一致（ADR-002 D4）。');
  lines.push('');
  lines.push('## 证据摘要（sha256，供复现校验）');
  lines.push('');
  lines.push(`- fact_members: \`${sha(JSON.stringify(snap.rows))}\``);
  for (const [type, rows] of grouped) {
    lines.push(`- ${type}: \`${sha(JSON.stringify(rows.map((r) => [r.id, r.revision_no, r.content_hash]))).slice(0, 16)}\``);
  }
  lines.push('');
  // 链前会议纪要（有则收录：波次与报告的追溯链）
  const meetings = (() => {
    try { return store.db.prepare('SELECT * FROM meetings ORDER BY created_at').all(); } catch { return []; }
  })();
  if (meetings.length > 0) {
    lines.push('## 链前会议纪要');
    lines.push('');
    for (const m of meetings) {
      const decisions = (() => { try { return JSON.parse(m.decisions ?? '[]'); } catch { return []; } })();
      lines.push(`### ${m.title} · ${m.created_at}`);
      lines.push('');
      lines.push(`- 纪要：${R(m.notes)}`);
      if (decisions.length) lines.push(`- 决议：${decisions.map((d) => `\`${R(d)}\``).join('、')}`);
      lines.push('');
    }
  }

  if (audience !== 'full') {
    lines.push(`> 视图：**${audience === 'client' ? '客户版（攻击路径与修复建议）' : '蓝队版（IOC 排查清单）'}**`);
    lines.push('');
  }

  lines.push('## 战役元信息');
  lines.push('');
  lines.push(`- 授权对象哈希: \`${engagementRow?.auth_hash ?? '-'}\``);
  lines.push(`- 授权版本: ${engagementRow?.auth_version ?? '-'}（撤销/变更后自增）`);
  lines.push(`- 节奏档: ${engagementRow?.rhythm ?? '-'}`);
  lines.push(`- 时间窗: ${engagementRow?.window_start ?? '-'} → ${engagementRow?.window_end ?? '-'}`);
  lines.push('');
  // 影响面摘要：客户最关心的一段，放在最前（工程视图可跳过）
  lines.push('## 影响面摘要');
  lines.push('');
  lines.push(renderImpact(impact));
  lines.push('');

  lines.push('## shell 状态');
  lines.push('');
  const shells = store.db.prepare('SELECT * FROM shell_state').all();
  if (shells.length === 0) {
    lines.push('- current_validity: `unknown`（尚无验证过的可控性证明）');
  } else {
    for (const s of shells) {
      lines.push(`- highest_proof: ${R(s.highest_proof ?? '无')} / current_validity: \`${s.current_validity}\` / last_verified_at: ${s.last_verified_at ?? '-'}`);
    }
  }
  lines.push('');
  if (audience === 'client') {
    lines.push('## 事实摘要（有效修订）');
    lines.push('');
    lines.push('- 说明：客户版只给事实的**分类统计**与攻击路径；逐条证据与原始载荷见内部全量版');
    lines.push('');
  } else {
    lines.push('## 事实（有效修订）');
  }
  lines.push('');
  if (effective.length === 0) lines.push('- （无）');
  for (const type of ENTITY_ORDER.concat([...grouped.keys()].filter((k) => !ENTITY_ORDER.includes(k)))) {
    const rows = grouped.get(type);
    if (!rows) continue;
    lines.push(`### ${type}（${rows.length}）`);
    lines.push('');
    const effectiveLimit = audience === 'client' ? 0 : maxFactsPerType;   // 客户版不铺逐条流水
    const shown = rows.slice(0, effectiveLimit);
    for (const r of shown) {
      const rev = `r${r.revision_no}`;
      lines.push(`- [${r.adapter_instance}] ${r.source_id} @${rev} · ${R(JSON.stringify(r.payload)).slice(0, 300)}`);
    }
    if (rows.length > shown.length) {
      const why = audience === 'client'
        ? '客户版只给统计，逐条证据见内部全量版'
        : `md 上限 ${maxFactsPerType}/类；全量见 JSON 报告 \`--format json|both\``;
      lines.push(`- …另有 **${rows.length - shown.length}** 条同类事实未逐条列出（${why}）`);
    }
    lines.push('');
  }
  if (quarantined.length > 0) {
    lines.push('## 未采用记录（隔离/历史/待审）');
    lines.push('');
    for (const q of quarantined) {
      lines.push(`- ${q.entity_type}/${q.source_id} r${q.revision_no} · flags=${q.flags ?? 'superseded'}（不参与记账与判定）`);
    }
    lines.push('');
  }

  // 审计摘要（门闸判定分布）与跳板台账（隧道收口清单）
  const auditSummary = (() => {
    try { return store.db.prepare('SELECT decision, COUNT(*) AS n FROM gate_log GROUP BY decision ORDER BY n DESC').all(); }
    catch { return []; }
  })();
  const routes = (() => {
    try { return store.db.prepare('SELECT * FROM jump_routes ORDER BY ts').all(); }
    catch { return []; }
  })();

  // 攻击路径拓扑（只按 payload 里明写的引用画边，不猜）
  const topology = buildTopology(activeRows);
  const remediation = buildRemediation(effectiveFacts);
  // 时序分段（逐任务 派发→回执→结项）：账本里没有的事件不出现，段缺时间戳就显示 —
  const timeline = buildTimeline({ store, globalDb, engagementId });
  const gantt = buildGantt(timeline);

  // 知识库复用（POC 跨战役复用是本框架的长期价值所在：这次用了什么、成没成）
  const kbUsage = readKbUsage(home, engagementId);

  const ioc = buildIocDraft({ store, engagementId, globalDb });
  lines.push(`## IOC / 清理附录（自动聚合 ${ioc.summary.total} 项，人工确认后交付）`);
  lines.push('');
  lines.push(`- 摘要：\`${JSON.stringify(ioc.summary.by_kind)}\`，需人工确认 ${ioc.summary.manual_confirm_required} 项`);
  lines.push(`- 清单摘要：\`${ioc.summary.digest.slice(0, 16)}\``);
  lines.push('');
  if (ioc.items.length === 0) lines.push('- （无候选）');
  for (const i of ioc.items) {
    lines.push(`- [${i.manual_confirm ? ' ' : 'x'}] **${i.kind}** \`${i.ref}\`（${i.confidence}，证据 ${i.evidence_ref}）— ${R(i.note)}`);
  }
  lines.push('');
  if (gantt.tasks.length > 0) {
    lines.push('## 时序与分段');
    lines.push('');
    lines.push(renderGantt(gantt));
    lines.push('');
  }

  if (remediation.items.length > 0) {
    lines.push('## 修复建议');
    lines.push('');
    if (remediation.generic_count > 0) {
      lines.push(`> 其中 **${remediation.generic_count}** 条为**按类型给出的通用建议**（事实里未附带逐条修复说明）；`
        + '请结合资产实际处置，勿当逐条结论照抄。');
      lines.push('');
    }
    for (const item of remediation.items) {
      lines.push(`- \`${item.ref}\` — ${R(item.advice)}（来源：${item.source}）`);
    }
    lines.push('');
  }

  if (topology.edges.length > 0) {
    const viz = toMermaidGrouped(topology);
    lines.push('## 攻击路径拓扑');
    lines.push('');
    lines.push(viz.mermaid);
    lines.push('');
    lines.push(`- 节点 ${topology.nodes.length} · 边 ${topology.edges.length}`
      + `（边来源：${topology.derived_from}）`);
    lines.push('- 图例：**粗箭头 `==>` = 通向控制面（session/shell/persistence）的关键跳**；'
      + '普通箭头 = 支撑关系；标「推断」= 由引用字段推断，未在链路步骤中显式声明');
    if (viz.critical.length > 0) {
      lines.push('- 关键跳清单：');
      for (const c of viz.critical) lines.push(`  - ${c.from} --(${c.via})--> **${c.to}**`);
    }
    if (topology.unexplained > 0) {
      lines.push(`- ⚠️ 有 **${topology.unexplained}** 条事实（弱点/链路/控制面）**未给出引用关系**，`
        + '因此图上没有边——请补记 `payload.steps` 或 `payload.path` 后再出图');
    }
    lines.push('');
  }

  if (audience !== 'client' && kbUsage.total > 0) {
    lines.push('## 知识库复用（POC 使用记录）');
    lines.push('');
    for (const r of kbUsage.rows) {
      lines.push(`- \`${r.code}\` ${R(r.title ?? '')} · 资产 ${R(r.asset ?? '-')} · 结果 \`${r.result}\` · ${r.ts}`);
    }
    lines.push('');
    lines.push(`- 合计：${kbUsage.total} 次使用、${kbUsage.distinct_pocs} 个不同 POC`
      + `（${Object.entries(kbUsage.by_result).map(([k, v]) => `${k}=${v}`).join('、')}）`);
    lines.push('- 全库统计：`warroom_poc_stats` / `poc_search`');
    lines.push('');
  }

  // 效率四段（§11）：客户版只给一行总览，其它视图给完整分解
  if (metrics?.segments) {
    const seg = metrics.segments;
    const fmt = (ms) => (ms === null || ms === undefined ? '—' : `${Math.round(ms / 1000)}s`);
    lines.push('## 效率观测（四段）');
    lines.push('');
    if (audience === 'client') {
      lines.push(`- 端到端：排队 ${fmt(seg.queue_ms)} · 交接 ${fmt(seg.handoff_ms)} · 执行 ${fmt(seg.exec_ms)}`
        + `（样本：交接 ${seg.samples?.handoff ?? 0} / 执行 ${seg.samples?.exec ?? 0}）`);
    } else {
      lines.push(`- 排队（立项→首派）：${fmt(seg.queue_ms)}`);
      lines.push(`- 交接（派发→首回执）：${fmt(seg.handoff_ms)}（样本 ${seg.samples?.handoff ?? 0}）`);
      lines.push(`- 执行（首回执→结项）：${fmt(seg.exec_ms)}（样本 ${seg.samples?.exec ?? 0}）`);
      lines.push(`- 返工：${seg.rework?.tasks ?? 0} 个任务（墙钟 ${fmt(seg.rework?.wall_ms)}）`);
      lines.push(`- 口径：${seg.basis}`);
    }
    lines.push('');
  }

  if (audience !== 'client' && auditSummary.length > 0) {
    lines.push('## 审计摘要（门闸判定分布）');
    lines.push('');
    for (const a of auditSummary) lines.push(`- \`${a.decision}\`：${a.n}`);
    lines.push('- 明细导出：`warroom audit --engagement <id> --export <dir>`（JSONL）');
    lines.push('');
  }
  if (audience !== 'client' && routes.length > 0) {
    lines.push('## 跳板与隧道台账');
    lines.push('');
    for (const r of routes) {
      lines.push(`- \`${r.route_id}\` 跳板 ${r.jumphost_id} · ${r.socks} · 状态 ${r.state} · ${r.ts}`);
    }
    lines.push('- 收口：`warroom jump release --lease <lease_id>` / `jump sweep`（未证实释放进隔离）');
    lines.push('');
  }

  lines.push('## 声明');
  lines.push('');
  lines.push('- 本报告由 WARROOM/GUNGNIR 生成；无漏洞利用代码，无明文凭据（凭据仅以引用形式出现）。');
  lines.push('- IOC 附录为半自动初稿：自动聚合器在 v0.2，当前版本需人工逐项确认。');
  lines.push('');

  const ordered = audience === 'blue' ? prioritizeSections(lines, 'IOC') : lines;
  const markdown = ordered.join('\n');
  return {
    markdown,
    watermark: { seq: snap.seq, snapshot_id: snap.snapshot_id, exported_at: snap.exported_at },
    evidence_digests: { fact_members: sha(JSON.stringify(snap.rows)) },
    size: { md_bytes: Buffer.byteLength(markdown, 'utf8'), facts: snap.rows.length, max_facts_per_type: maxFactsPerType },
  };
}

/**
 * 导出到文件；format: 'md' | 'json' | 'both'。
 * 返回 {path|paths, watermark, evidence_digests}。
 */
export function exportReport({ store, engagementId, engagementRow, vault, globalDb, home = null, outDir, format = 'md', maxFactsPerType = 50, audience = 'full', metrics = null }) {
  const built = buildReport({ store, engagementId, engagementRow, vault, globalDb, home, maxFactsPerType, audience, metrics });
  const { watermark, evidence_digests } = built;
  mkdirSync(outDir, { recursive: true });

  // 自校验：导出时立刻对照当前库复核水位与摘要（只读），把结论写进报告
  const check = verifyReportAgainstStore(built.markdown, store);
  const selfCheck = {
    reproducible: check.reproducible,
    checked_at: new Date().toISOString(),
    report_snapshot: watermark.snapshot_id,
    current_snapshot: check.current.snapshot_id,
    drift_seq: check.drift.seq,
  };
  const checkLines = [
    '',
    '## 自校验（导出时即时复核）',
    '',
    `- 结果：${check.reproducible ? '**可复现**（水位与证据摘要一致）' : `**存在漂移**（seq 差 ${check.drift.seq}）`}`,
    `- 复核时间：${selfCheck.checked_at}`,
    `- 复核方式：\`node scripts/verify-report.mjs <本报告> --home <home> --engagement ${engagementId}\``,
    '',
  ];
  const markdown = check.reproducible ? built.markdown.replace(/(\n## 声明)/, `${checkLines.join('\n')}$1`) : built.markdown + checkLines.join('\n');

  const out = { paths: {}, watermark, evidence_digests, self_check: selfCheck };
  const wantMd = format === 'md' || format === 'both' || format === 'all';
  const wantJson = format === 'json' || format === 'both' || format === 'all';
  const wantHtml = format === 'html' || format === 'all' || format === 'both';
  if (wantMd) {
    const path = join(outDir, `${engagementId}-report-${watermark.seq}.md`);
    writeFileSync(path, markdown, 'utf8');
    out.paths.markdown = path;
  }
  if (wantHtml) {
    const path = join(outDir, `${engagementId}-report-${watermark.seq}${audience === 'full' ? '' : `-${audience}`}.html`);
    writeFileSync(path, renderHtml({
      markdown: check.reproducible ? markdown : markdown + checkLines.join('\n'),
      title: `GUNGNIR 战役报告 · ${engagementId}${audience === 'full' ? '' : ` · ${audience}`}`,
      meta: { engagement_id: engagementId, audience, watermark, generated_at: selfCheck.checked_at },
    }), 'utf8');
    out.paths.html = path;
  }
  if (wantJson) {
    const path = join(outDir, `${engagementId}-report-${watermark.seq}.json`);
    const json = buildReportJson({ store, engagementId, engagementRow, vault, globalDb, home, metrics });
    json.audience = audience;
    json.self_check = selfCheck;
    writeFileSync(path, JSON.stringify(json, null, 2), 'utf8');
    out.paths.json = path;
    out.ioc_summary = json.ioc_summary;
  }
  out.path = out.paths.markdown ?? out.paths.json;
  return out;
}

/** 从报告正文解析水位与证据摘要（供复现校验器使用）。 */
export function parseReportHeader(markdown) {
  const pick = (label) => {
    const m = markdown.match(new RegExp('- ' + label + ': `([^`]+)`'));
    return m ? m[1] : null;
  };
  return {
    seq: Number(pick('seq')),
    snapshot_id: pick('snapshot_id'),
    exported_at: pick('exported_at'),
    fact_members_digest: pick('fact_members'),
  };
}

/**
 * 复现校验（ADR-002 D4）：用报告里的水位与摘要对照当前库，
 * 判定报告是否仍可复现；漂移如实回报，不修数据。
 */
export function verifyReportAgainstStore(markdown, store) {
  const header = parseReportHeader(markdown);
  const snap = store.exportSnapshot();
  const digest = sha(JSON.stringify(snap.rows));
  const driftSeq = snap.seq - (Number.isFinite(header.seq) ? header.seq : 0);
  return {
    report: header,
    current: { seq: snap.seq, snapshot_id: snap.snapshot_id, fact_members_digest: digest },
    reproducible: header.snapshot_id === snap.snapshot_id && header.fact_members_digest === digest,
    drift: { seq: driftSeq, rows_now: snap.rows.length },
  };
}

export function readReport(path) {
  return readFileSync(path, 'utf8');
}

export { redactDeep };
