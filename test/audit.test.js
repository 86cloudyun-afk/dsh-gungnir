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

test('分页：limit/offset/has_more 语义 + 过滤后计数', () => {
  const h = harness();
  // 直接写审计行（避免与节奏闸耦合：分页测试只关心审计本身）
  for (let i = 0; i < 5; i += 1) h.store().appendGateLog({ decision: 'allow', detail: `pg-${i}` });
  const p1 = h.broker.audit(h.eng.engagement_id, { limit: 2, offset: 0 });
  assert.equal(p1.rows.length, 2);
  assert.equal(p1.page.matched, 5);
  assert.equal(p1.page.has_more, true);
  const p3 = h.broker.audit(h.eng.engagement_id, { limit: 2, offset: 4 });
  assert.equal(p3.rows.length, 1);
  assert.equal(p3.page.has_more, false);
  assert.equal(p1.rows[0].id > p3.rows[0].id, true, '默认倒序：首页是最新的');

  const asc = h.broker.audit(h.eng.engagement_id, { limit: 2, order: 'asc' });
  assert.ok(asc.rows[0].id < asc.rows[1].id, 'asc 应为最旧在前');

  // 过滤后的匹配数只算匹配行
  h.store().appendGateLog({ decision: 'deny', detail: 'not-matched' });
  const filtered = h.broker.audit(h.eng.engagement_id, { decision: 'allow', limit: 10 });
  assert.equal(filtered.page.matched, 5);
  assert.equal(h.broker.audit(h.eng.engagement_id, { decision: 'deny' }).page.matched, 1);
});

test('CSV 导出：RFC4180 转义 + 行数一致 + 可被解析', () => {
  const h = harness();
  h.store().appendGateLog({ decision: 'test-csv', detail: '含逗号,与"引号"' });
  h.broker.execute({ ...h.base, command_id: 'csv-1', contract: h.contract() });

  const r = h.broker.auditExportCsv(h.eng.engagement_id, { outDir: join(h.home, 'audit-csv') });
  const text = readFileSync(r.path, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, r.lines + 1, '含表头');
  assert.match(lines[0], /^id,ts,decision,code,detail,recovered_at$/);
  assert.ok(text.includes('"含逗号,与""引号"""'), 'RFC4180 转义应生效');

  // 过滤导出
  const only = h.broker.auditExportCsv(h.eng.engagement_id, { outDir: join(h.home, 'audit-csv2'), decision: 'allow' });
  assert.equal(only.lines, 1);
});

test('CLI audit 分页与 CSV 导出', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  for (let i = 0; i < 3; i += 1) h.store().appendGateLog({ decision: 'allow', detail: `cli-pg-${i}` });
  const page = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'audit', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--limit', '2', '--offset', '0', '--json'], { encoding: 'utf8', env }));
  assert.equal(page.rows.length, 2);
  assert.equal(page.page.matched, 3);
  const csv = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'audit', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--export', join(h.home, 'cli-csv'), '--format', 'csv', '--json'], { encoding: 'utf8', env }));
  assert.ok(csv.path.endsWith('.csv'));
});
