// 影响面摘要：只对账本里有证据的东西下结论；控制面"历史拿过"不等于"现在可控"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { buildImpact, renderImpact } from '../packages/warroom-core/src/impact.js';

test('等级判定：有控制面证明 → 高；仅信息类 → 中；无事实 → 未评估', () => {
  const high = buildImpact([
    { entity_type: 'vuln', source_id: 'CVE-X', payload: { remediation: '' } },
    { entity_type: 'shell', source_id: 'sess-1', payload: {} },
  ], { highest_proof: 'shell-1', current_validity: 'likely', last_verified_at: null });
  assert.equal(high.severity.level, '高');
  assert.ok(high.severity.reasons.some((r) => r.text.includes('控制面证明')));

  const mid = buildImpact([{ entity_type: 'vuln', source_id: 'INFO-1', payload: { note: '版本泄露 1.2.3' } }], null);
  assert.equal(mid.severity.level, '中');

  const none = buildImpact([], null);
  assert.equal(none.severity.level, '未评估');
  assert.ok(none.caveats.some((c) => c.includes('不等于安全')));
});

test('资产去重计数与分类计数', () => {
  const impact = buildImpact([
    { entity_type: 'asset', source_id: 'a1', payload: {} },
    { entity_type: 'asset', source_id: 'a1', payload: {} },   // 同一 source_id 只算一次
    { entity_type: 'domain', source_id: 'd1', payload: {} },
    { entity_type: 'credential', source_id: 'c1', payload: {} },
    { entity_type: 'chain', source_id: 'ch1', payload: {} },
  ], null);
  assert.equal(impact.scope.assets, 2, 'a1 去重 + d1');
  assert.equal(impact.scope.domains, 1);
  assert.equal(impact.findings.credentials, 1);
  assert.equal(impact.findings.chains, 1);
});

test('控制面口径：历史证明不冒充当前可控；confirmed_lost 要写明', () => {
  const lost = buildImpact([{ entity_type: 'shell', source_id: 's1', payload: {} }],
    { highest_proof: 'shell-1', current_validity: 'confirmed_lost', last_verified_at: '2026-10-01T00:00:00Z' });
  assert.equal(lost.control.current_validity, 'confirmed_lost');
  assert.ok(lost.caveats.some((c) => c.includes('已确认失效')));
});

test('报告收录影响面摘要（放在 shell 状态之前）', () => {
  const h = harness();
  const ex = h.broker.execute({
    ...h.base, command_id: 'imp-1',
    contract: h.contract({
      fake_members: [
        { entity_type: 'asset', source_id: '10.0.0.5', revision_no: 1, content_hash: 'h1', payload: {} },
        { entity_type: 'vuln', source_id: 'CVE-IMP-1', revision_no: 1, content_hash: 'h2', payload: { note: 'RCE 可命令执行' } },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.store().recordShellProof({ proof: 'shell-imp', evidence_ref: 'ev' });

  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  const md = readFileSync(r.paths.markdown, 'utf8');
  assert.match(md, /## 影响面摘要/);
  assert.match(md, /影响面等级：高/);
  assert.match(md, /涉及资产：\*\*1\*\* 个/);
  const idx = (kw) => md.split('\n').findIndex((l) => l.startsWith('## ') && l.includes(kw));
  assert.ok(idx('影响面摘要') < idx('shell 状态'), '摘要应在 shell 状态之前');

  const json = JSON.parse(readFileSync(r.paths.json, 'utf8'));
  assert.equal(json.impact.severity.level, '高');
  assert.ok(Array.isArray(json.impact.caveats));
  assert.match(renderImpact(json.impact), /影响面等级/);
});
