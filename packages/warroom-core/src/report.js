// 报告导出器（框架 §5）：水位绑定 + 事实视图 + IOC/清理附录（半自动初稿）+ 脱敏双保险。
// 报告双属性：给客户的可复现攻击报告 = 给蓝队的 IOC 排查清单（同一份证据的两个视图）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactDeep } from './redactor.js';

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

/** 从事实与运行记录推导 IOC / 清理候选（半自动：人工确认后进报告）。 */
export function buildIocDraft({ store, engagementId, globalDb }) {
  const items = [];
  const members = store.db.prepare('SELECT * FROM fact_members WHERE active = 1').all();
  for (const m of members) {
    if (m.entity_type === 'credential') {
      items.push({ kind: 'credential', ref: `fact#${m.id}`, note: `凭据引用（明文在秘密库，不在报告）`, manual: true });
    }
    if (m.entity_type === 'session') {
      items.push({ kind: 'session', ref: `fact#${m.id}`, note: '会话/立足点，需确认是否已清理', manual: true });
    }
  }
  const routes = store.db.prepare('SELECT * FROM jump_routes').all();
  for (const r of routes) {
    items.push({ kind: 'tunnel', ref: r.route_id, note: `隧道 ${r.socks}（跳板 ${r.jumphost_id}）→ 收口时拆除`, manual: false });
  }
  const cmds = globalDb.prepare('SELECT command_id, task_id, state FROM command_queue WHERE engagement_id = ?')
    .all(engagementId);
  for (const c of cmds) {
    if (['unresolved', 'unknown', 'failed'].includes(c.state)) {
      items.push({ kind: 'unfinished', ref: c.task_id, note: `任务终态 ${c.state} → 确认资源已停/未留残留`, manual: true });
    }
  }
  const pending = globalDb.prepare("SELECT ref_id, detail FROM op_log WHERE state = 'quarantined'").all();
  for (const p of pending) {
    items.push({ kind: 'quarantined', ref: p.ref_id ?? '-', note: `隔离态资源需人工处置：${p.detail ?? ''}`, manual: true });
  }
  return items;
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

  const ioc = buildIocDraft({ store, engagementId, globalDb });
  lines.push('## IOC / 清理附录（半自动初稿，人工确认后交付）');
  lines.push('');
  if (ioc.length === 0) lines.push('- （无候选）');
  for (const i of ioc) {
    lines.push(`- [${i.manual ? ' ' : 'x'}] **${i.kind}** \`${i.ref}\` — ${R(i.note)}`);
  }
  lines.push('');
  lines.push('## 声明');
  lines.push('');
  lines.push('- 本报告由 WARROOM/GUNGNIR 生成；无漏洞利用代码，无明文凭据（凭据仅以引用形式出现）。');
  lines.push('- IOC 附录为半自动初稿：自动聚合器在 v0.2，当前版本需人工逐项确认。');
  lines.push('');

  const markdown = lines.join('\n');
  return { markdown, watermark: { seq: snap.seq, snapshot_id: snap.snapshot_id, exported_at: snap.exported_at } };
}

/** 导出到文件；返回 {path, watermark}。 */
export function exportReport({ store, engagementId, engagementRow, vault, globalDb, outDir }) {
  const { markdown, watermark } = buildReport({ store, engagementId, engagementRow, vault, globalDb });
  const path = join(outDir, `${engagementId}-report-${watermark.seq}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, 'utf8');
  return { path, watermark };
}

export { redactDeep };
