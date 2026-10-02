// 审计：门闸判定可查、可导出、内容已脱敏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';
import { runWave } from '../packages/warroom-core/src/wave.js';

const SECRET = 'audit-plain-secret-2026';

test('审计查询：按 decision 过滤 + 决策分布统计', () => {
  const h = harness();
  h.broker.execute({ ...h.base, command_id: 'au-1', contract: h.contract() });
  runWave({
    broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: '审计用会议', notes: 'x', tasks: [{ id: 'A', role: 'recon', targets: ['10.0.0.5'] }] },
  });
  h.broker.settle(h.eng.engagement_id, 'au-1');

  const all = h.broker.audit(h.eng.engagement_id, { limit: 100 });
  assert.ok(all.total >= 3, `应至少含 execute/meeting/settle，实际 ${all.total}`);
  const allows = h.broker.audit(h.eng.engagement_id, { decision: 'allow' });
  assert.ok(allows.rows.every((r) => r.decision === 'allow'));
  const meetings = h.broker.audit(h.eng.engagement_id, { decision: 'meeting' });
  assert.equal(meetings.rows.length, 1);
  const dist = Object.fromEntries(all.by_decision.map((d) => [d.decision, d.n]));
  assert.ok(dist.allow >= 1 && dist.meeting === 1 && dist.settle >= 1, JSON.stringify(dist));
});

test('拒付也留痕：门闸拒绝写进审计（deny 路径可追溯）', () => {
  const h = harness();
  // 触发一次 adapter 层失败（非预期错误）→ gate_log deny 分支
  const original = h.adapter.dispatch.bind(h.adapter);
  h.adapter.dispatch = () => { throw Object.assign(new Error('boom'), { code: 'E_TEST_FAILURE' }); };
  try {
    h.broker.execute({ ...h.base, command_id: 'au-deny', contract: h.contract() });
  } catch { /* 预期抛出 */ }
  h.adapter.dispatch = original;

  const denies = h.broker.audit(h.eng.engagement_id, { decision: 'deny' });
  assert.equal(denies.rows.length, 1);
  assert.match(denies.rows[0].detail, /boom/);
});

test('审计导出 JSONL：行数一致、内容脱敏（明文秘密不入日志）', () => {
  const h = harness();
  const { secret_ref } = h.broker.secrets.put(SECRET, { label: 'ssh-pw' });
  h.store().appendGateLog({ decision: 'test', detail: h.broker.secrets.redact(`发现 ${SECRET}`) });
  h.broker.execute({ ...h.base, command_id: 'au-2', contract: h.contract() });

  const r = h.broker.auditExport(h.eng.engagement_id, { outDir: join(h.home, 'audit-out') });
  const text = readFileSync(r.path, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, r.lines);
  assert.ok(lines.every((l) => JSON.parse(l).ts), '每行都应是合法 JSON');
  assert.equal(text.includes(SECRET), false, '审计日志不得含明文');
  assert.ok(r.summary.length >= 1);
  assert.ok(secret_ref);
});

test('CLI audit 子命令：查询与导出两路可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  h.broker.execute({ ...h.base, command_id: 'au-cli', contract: h.contract() });
  const query = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'audit', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.ok(query.total >= 1);
  const exported = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'audit', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--export', join(h.home, 'cli-audit'), '--json'], { encoding: 'utf8', env }));
  assert.ok(exported.path.endsWith('audit-log.jsonl'));
});
