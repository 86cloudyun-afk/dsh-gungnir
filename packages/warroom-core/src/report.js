// 报告导出器（框架 §5）：水位绑定 + 事实视图 + IOC/清理附录（半自动初稿）+ 脱敏双保险。
// 报告双属性：给客户的可复现攻击报告 = 给蓝队的 IOC 排查清单（同一份证据的两个视图）。
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { redactDeep } from './redactor.js';
import { aggregateIoc } from './ioc.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

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
export function buildReportJson({ store, engagementId, engagementRow, vault, globalDb }) {
  const snap = store.exportSnapshot();
  const R = (v) => (vault ? redactDeep(v, vault.values()) : v);
  const facts = snap.rows.map((r) => {
    const { payload, ...rest } = r;
    let parsed = {};
    try { parsed = JSON.parse(payload ?? '{}'); } catch { parsed = { raw: payload }; }
    return { ...rest, payload: R(parsed) };
  });
  // 审计摘要（门闸判定分布）与跳板台账（隧道收口清单）
  const auditSummary = (() => {
    try { return store.db.prepare('SELECT decision, COUNT(*) AS n FROM gate_log GROUP BY decision ORDER BY n DESC').all(); }
    catch { return []; }
  })();
  const routes = (() => {
    try { return store.db.prepare('SELECT * FROM jump_routes ORDER BY ts').all(); }
    catch { return []; }
  })();

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
    facts: { effective: facts.filter((f) => f.active === 1), quarantined: facts.filter((f) => f.active !== 1) },
    ioc: ioc.items,
    ioc_summary: ioc.summary,
  };
}

/** 生成报告 markdown（含水位）；所有文本过 redactor。 */
export function buildReport({ store, engagementId, engagementRow, vault, globalDb }) {
  const snap = store.exportSnapshot();
  const values = vault ? vault.values() : [];
  const R = (s) => (vault ? vault.redact(s) : String(s));
  const facts = snap.rows.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload || '{}'),
  }));

  const effective = facts.filter((f) => f.active === 1);
  const quarantined = facts.filter((f) => f.active !== 1);
  const grouped = groupBy(effective, (f) => f.entity_type);

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

  lines.push('## 战役元信息');
  lines.push('');
  lines.push(`- 授权对象哈希: \`${engagementRow?.auth_hash ?? '-'}\``);
  lines.push(`- 授权版本: ${engagementRow?.auth_version ?? '-'}（撤销/变更后自增）`);
  lines.push(`- 节奏档: ${engagementRow?.rhythm ?? '-'}`);
  lines.push(`- 时间窗: ${engagementRow?.window_start ?? '-'} → ${engagementRow?.window_end ?? '-'}`);
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
  lines.push('## 事实（有效修订）');
  lines.push('');
  if (effective.length === 0) lines.push('- （无）');
  for (const type of ENTITY_ORDER.concat([...grouped.keys()].filter((k) => !ENTITY_ORDER.includes(k)))) {
    const rows = grouped.get(type);
    if (!rows) continue;
    lines.push(`### ${type}（${rows.length}）`);
    lines.push('');
    for (const r of rows) {
      const rev = `r${r.revision_no}`;
      lines.push(`- [${r.adapter_instance}] ${r.source_id} @${rev} · ${R(JSON.stringify(r.payload)).slice(0, 300)}`);
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
  if (auditSummary.length > 0) {
    lines.push('## 审计摘要（门闸判定分布）');
    lines.push('');
    for (const a of auditSummary) lines.push(`- \`${a.decision}\`：${a.n}`);
    lines.push('- 明细导出：`warroom audit --engagement <id> --export <dir>`（JSONL）');
    lines.push('');
  }
  if (routes.length > 0) {
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

  const markdown = lines.join('\n');
  return {
    markdown,
    watermark: { seq: snap.seq, snapshot_id: snap.snapshot_id, exported_at: snap.exported_at },
    evidence_digests: { fact_members: sha(JSON.stringify(snap.rows)) },
  };
}

/**
 * 导出到文件；format: 'md' | 'json' | 'both'。
 * 返回 {path|paths, watermark, evidence_digests}。
 */
export function exportReport({ store, engagementId, engagementRow, vault, globalDb, outDir, format = 'md' }) {
  const built = buildReport({ store, engagementId, engagementRow, vault, globalDb });
  const { watermark, evidence_digests } = built;
  mkdirSync(outDir, { recursive: true });
  const out = { paths: {}, watermark, evidence_digests };
  if (format === 'md' || format === 'both') {
    const path = join(outDir, `${engagementId}-report-${watermark.seq}.md`);
    writeFileSync(path, built.markdown, 'utf8');
    out.paths.markdown = path;
  }
  if (format === 'json' || format === 'both') {
    const path = join(outDir, `${engagementId}-report-${watermark.seq}.json`);
    const json = buildReportJson({ store, engagementId, engagementRow, vault, globalDb });
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
