// 证据落盘桥：把战役事实导出到作战室目录结构（对齐宪法第 8 节）。
// 输出（目标目录内）：
//   report-<seq>.md / report-<seq>.json   —— 与 API 同源（同水位、同摘要）
//   watermark.json                        —— 水位与证据摘要
//   EVIDENCE_INDEX.md                     —— 三段式：Confirmed / Leaked credentials(仅引用) / Raw artifacts
// 铁律：明文秘密永不落盘（凭据只出 secret_ref 引用）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function exportEvidence({ broker, engagementId, outDir, target = null }) {
  if (!outDir) throw new Error('exportEvidence 需要 outDir');
  const dir = target ? join(outDir, target) : outDir;
  mkdirSync(dir, { recursive: true });

  const exported = broker.exportReport(engagementId, { outDir: dir, format: 'both' });
  const store = broker._eng(engagementId).store;
  const members = store.db.prepare('SELECT * FROM fact_members WHERE active = 1 ORDER BY entity_type, source_id').all();
  const R = (s) => broker.secrets.redact(String(s ?? ''));

  const byType = (t) => members.filter((m) => m.entity_type === t);
  const confirmed = members.filter((m) => ['asset', 'vuln', 'chain', 'session', 'shell'].includes(m.entity_type));
  const creds = byType('credential').map((m) => {
    // 凭据只暴露引用：source_id 作为人类可读标签，payload 里的明文一律不落盘
    let label = m.source_id;
    try {
      const p = JSON.parse(m.payload ?? '{}');
      label = p.label ?? p.service ?? m.source_id;
    } catch { /* 保留 source_id */ }
    return { ref: m.source_id, label: R(label), evidence: `fact#${m.id}`, note: '明文存于 host 加密库，见 secret_ref' };
  });

  const index = [];
  index.push('# EVIDENCE_INDEX');
  index.push('');
  index.push(`- 战役：\`${engagementId}\``);
  index.push(`- 水位：seq=\`${exported.watermark.seq}\` snapshot=\`${exported.watermark.snapshot_id.slice(0, 16)}…\` @ ${exported.watermark.exported_at}`);
  index.push(`- 证据摘要（fact_members）：\`${exported.evidence_digests?.fact_members?.slice(0, 16) ?? sha(JSON.stringify(members)).slice(0, 16)}…\``);
  index.push('- 复现：`node scripts/verify-report.mjs report-<seq>.md --home <home> --engagement <id>`');
  index.push('');
  index.push('## Confirmed');
  index.push('');
  if (confirmed.length === 0) index.push('- （无）');
  for (const m of confirmed) {
    index.push(`- \`${m.entity_type}\` ${R(m.source_id)} @r${m.revision_no} · 证据 fact#${m.id}`);
  }
  index.push('');
  index.push('## Leaked credentials（仅引用，无明文）');
  index.push('');
  if (creds.length === 0) index.push('- （无）');
  for (const c of creds) {
    index.push(`- ${c.label} · 引用 \`${c.ref}\` · ${c.evidence} · ${c.note}`);
  }
  index.push('');
  index.push('## Raw artifacts');
  index.push('');
  index.push(`- report-${exported.watermark.seq}.md（可复现攻击报告 = 蓝队 IOC 排查清单）`);
  index.push(`- report-${exported.watermark.seq}.json（机器可读，schema gungnir-report/1）`);
  index.push('- watermark.json（水位与摘要，供对账）');
  index.push('');
  index.push('> 本目录内容由 GUNGNIR 生成；**不含任何明文凭据**。敏感值仅以 host 侧加密库中的引用存在。');
  index.push('');

  const indexPath = join(dir, 'EVIDENCE_INDEX.md');
  const watermarkPath = join(dir, 'watermark.json');
  writeFileSync(indexPath, index.join('\n'), 'utf8');
  writeFileSync(watermarkPath, JSON.stringify({
    engagement_id: engagementId,
    watermark: exported.watermark,
    evidence_digests: exported.evidence_digests ?? {},
    artifacts: [exported.paths.markdown, exported.paths.json].filter(Boolean).map((p) => p.split('/').pop()),
    index_digest: sha(index.join('\n')),
  }, null, 2), 'utf8');

  return {
    dir,
    files: { markdown: exported.paths.markdown, json: exported.paths.json, index: indexPath, watermark: watermarkPath },
    watermark: exported.watermark,
    counts: { confirmed: confirmed.length, credentials: creds.length, facts: members.length },
  };
}
