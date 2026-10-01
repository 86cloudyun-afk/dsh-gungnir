// 报告复现校验（ADR-002 D4）：导出即可复现；有新写入则如实报漂移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { parseReportHeader } from '../packages/warroom-core/src/report.js';

test('导出后立即校验 → 可复现（水位 + 证据摘要双一致）', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'vr-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const { path } = h.broker.exportReport(h.eng.engagement_id);
  const markdown = readFileSync(path, 'utf8');
  const v = h.broker.verifyReport(h.eng.engagement_id, markdown);
  assert.equal(v.reproducible, true);
  assert.equal(v.drift.seq, 0);
});

test('导出后有新写入 → 如实报漂移，不修数据', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'vr-2', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const { path } = h.broker.exportReport(h.eng.engagement_id);

  const ex2 = h.broker.execute({
    ...h.base, command_id: 'vr-3',
    contract: h.contract({
      fake_members: [{ entity_type: 'asset', source_id: 'a-drift', revision_no: 1, content_hash: 'h-drift', payload: {} }],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex2.task_id, h.adapter.collect(ex2.task_id));

  const v = h.broker.verifyReport(h.eng.engagement_id, readFileSync(path, 'utf8'));
  assert.equal(v.reproducible, false);
  assert.ok(v.drift.seq > 0);
  assert.equal(v.current.fact_members_digest !== v.report.fact_members_digest, true);
});

test('报告头部可解析（水位/摘要进入正文）', () => {
  const h = harness();
  const { markdown } = h.broker.buildReport(h.eng.engagement_id);
  const header = parseReportHeader(markdown);
  assert.ok(Number.isInteger(header.seq));
  assert.ok(header.snapshot_id && header.snapshot_id.length === 64);
  assert.ok(header.fact_members_digest && header.fact_members_digest.length === 64);
});

test('CLI 校验器：一致退出 0，漂移退出 3', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'vr-4', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const { path } = h.broker.exportReport(h.eng.engagement_id);

  const args = ['scripts/verify-report.mjs', path, '--home', h.home, '--engagement', h.eng.engagement_id];
  const ok = execFileSync('node', args, { encoding: 'utf8' });
  assert.match(ok, /可复现/);

  const ex2 = h.broker.execute({ ...h.base, command_id: 'vr-5', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex2.task_id, h.adapter.collect(ex2.task_id));
  let code = 0;
  try { execFileSync('node', args, { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.equal(code, 3);
});
