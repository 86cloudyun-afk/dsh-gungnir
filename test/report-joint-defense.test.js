// Read-only report regression: fixed inert SQLite members and an in-memory vault only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngagementDb, openGlobalDb } from '../packages/warroom-core/src/db.js';
import { FactStore } from '../packages/warroom-core/src/store.js';
import { buildReport, buildReportJson, exportReport, parseReportHeader } from '../packages/warroom-core/src/report.js';
import { redact } from '../packages/warroom-core/src/redactor.js';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const member = (entity_type, source_id, payload = {}, revision_no = 1) => ({
  entity_type, source_id, payload, revision_no, content_hash: digest([entity_type, source_id, payload, revision_no]),
});
function fixture(t, values = []) {
  const dir = mkdtempSync(join(tmpdir(), 'report-joint-'));
  const db = openEngagementDb(join(dir, 'engagement'));
  const globalDb = openGlobalDb(join(dir, 'global'));
  t.after(() => { db.close(); globalDb.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = new FactStore(db, 'eng_joint_fixture');
  store._now = () => '2026-01-01T00:00:00.000Z';
  const vault = { values: () => values, redact: (s) => redact(s, values) };
  const args = { store, globalDb, engagementId: store.engagementId, vault };
  const ingest = (members) => store.ingestMembers({ adapterInstance: 'fixture', generation: '1:1:1', members });
  const stale = (members) => store.quarantineStaleGeneration({ adapterInstance: 'fixture', generation: '0:0:0', members });
  return { dir, store, args, ingest, stale };
}
const section = (md, title) => md.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? '';
function databaseRows(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}

test('long secret labels are redacted before truncation and Mermaid/HTML escaping', (t) => {
  const secret = 'long-private-prefix-0123456789|[]{}"<fixture>-abcdefghijklmnopqrstuv';
  const h = fixture(t, [{ value: secret, label: 'long-fixture' }]);
  const source = `host-${secret}`;
  h.ingest([member('asset', source), member('vuln', 'finding', { asset: source, fix: `rotate ${secret}` })]);
  const report = buildReportJson(h.args);
  assert.equal(report.topology.nodes[0].label, 'host-[REDACTED:long-fixture]');
  assert.equal(report.topology.nodes[0].kind, 'asset');
  const out = exportReport({ ...h.args, format: 'all', outDir: join(h.dir, 'all') });
  for (const path of Object.values(out.paths)) {
    const text = readFileSync(path, 'utf8');
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes('long-private-prefix'), false, 'truncated or escaped secret fragments must not survive');
  }
  assert.match(section(readFileSync(out.paths.markdown, 'utf8'), '攻击路径拓扑'), /REDACTED:long-fixture/);
});

test('shared vault labels preserve asset counts, graph joins and IOC deduplication', (t) => {
  const a = 'private-asset-A-2026';
  const b = 'private-asset-B-2026';
  const h = fixture(t, [{ value: a, label: 'shared' }, { value: b, label: 'shared' }]);
  h.ingest([
    member('asset', `host-${a}`), member('asset', `host-${b}`),
    member('session', `session-${a}`, { host: `host-${a}` }),
    member('session', `session-${b}`, { host: `host-${b}` }),
    member('credential', `credential-${a}`), member('credential', `credential-${b}`),
  ]);
  const report = buildReportJson(h.args);
  assert.equal(report.impact.scope.assets, 4, 'original host/session identities count separately');
  assert.equal(new Set(report.topology.nodes.map((n) => n.id)).size, 6);
  const nodes = report.topology.nodes;
  assert.deepEqual(report.topology.edges.map((e) => [e.from, e.to]), [[nodes[0].id, nodes[2].id], [nodes[1].id, nodes[3].id]]);
  assert.equal(report.ioc_summary.total, 4, 'both sessions and credentials survive raw-identity dedupe');
  assert.equal(report.ioc.filter((i) => i.kind === 'credential-ref').length, 2);
  assert.equal(new Set(report.ioc.map((i) => i.evidence_ref)).size, 4);
  assert.ok(report.topology.edges.every((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to)));
  for (const secret of [a, b]) assert.equal(JSON.stringify(report).includes(secret), false);
  const graph = section(buildReport(h.args).markdown, '攻击路径拓扑');
  assert.equal(new Set([...graph.matchAll(/(n\d+)\["/g)].map((m) => m[1])).size, 4);
});

for (const risk of ['RCE', 'credential', '注入']) {
  test(`secret text and vault label containing ${risk} cannot classify findings`, (t) => {
    const secret = `private-${risk}-fixture-2026`;
    const h = fixture(t, [{ value: secret, label: `${risk}-label` }, { value: 'label-only-private', label: risk }]);
    h.ingest([
      member('vuln', `finding-${secret}`, { note: 'ordinary observation', detail: `label-only-private ${secret}` }),
      member('vuln', 'public-finding', { note: `ordinary observation ${secret}` }),
    ]);
    const report = buildReportJson(h.args);
    assert.equal(report.impact.severity.level, '中');
    assert.ok(report.remediation.items.every((i) => i.advice.includes('最小权限与补丁管理基线')));
    const md = buildReport(h.args).markdown;
    assert.match(section(md, '影响面摘要'), /影响面等级：中/);
    assert.equal(section(md, '修复建议').includes('避免拼接命令'), false);
    assert.equal(section(md, '修复建议').includes('参数化查询'), false);
    assert.equal(section(md, '修复建议').includes('轮换已泄露凭据'), false);
    assert.match(md, /REDACTED/);
  });
}

test('pattern secrets and escaped payload strings are neutral for analysis while explicit advice keeps its shape', (t) => {
  const secret = 'private-"RCE|credential-注入-fixture';
  const h = fixture(t, [{ value: secret, label: 'RCE-credential-注入' }]);
  h.ingest([
    member('vuln', 'finding', { note: 'ordinary observation password=RCE-credential-注入-fixture-value' }),
    member('vuln', 'advised', { asset: { ref: 'public-host' },
      steps: [{ from: 'public-host', to: 'advised', via: secret }], fix: `rotate ${secret}` }),
    member('asset', 'public-host'),
  ]);
  const report = buildReportJson(h.args);
  assert.equal(report.impact.severity.level, '中');
  assert.match(report.remediation.items[0].advice, /最小权限与补丁管理基线/);
  assert.equal(report.remediation.items[1].advice, 'rotate [REDACTED:RCE-credential-注入]');
  assert.deepEqual(report.facts.effective[1].payload.asset, { ref: 'public-host' });
  assert.equal(Array.isArray(report.facts.effective[1].payload.steps), true);
  assert.equal(report.topology.edges.length, 1, 'object-valued asset refs are not coerced or guessed');
  assert.equal(report.topology.edges[0].via, '[REDACTED:RCE-credential-注入]');
  const md = buildReport(h.args).markdown;
  assert.equal(md.includes('private-\\"RCE'), false, 'redact original strings before JSON escaping');
  assert.equal(md.includes('RCE-credential-注入-fixture-value'), false);
});

test('real public risk hints still select their severity and generic advice', (t) => {
  const h = fixture(t, [{ value: 'private-RCE-fixture', label: '注入' }]);
  h.ingest([
    member('vuln', 'public-command', { note: 'RCE 命令执行 private-RCE-fixture' }),
    member('vuln', 'public-credential', { note: 'credential exposure' }),
    member('vuln', 'public-query', { note: 'SQL 注入' }),
  ]);
  const report = buildReportJson(h.args);
  assert.equal(report.impact.severity.level, '高');
  assert.match(report.remediation.items[0].advice, /避免拼接命令/);
  assert.match(report.remediation.items[1].advice, /轮换已泄露凭据/);
  assert.match(report.remediation.items[2].advice, /参数化查询/);
  assert.match(section(buildReport(h.args).markdown, '影响面摘要'), /影响面等级：高/);
});

test('without a vault, pattern secrets and existing redaction markers do not become risk hints', (t) => {
  const h = fixture(t);
  delete h.args.vault;
  h.ingest([
    member('vuln', 'pattern-finding', { note: 'ordinary observation password=RCE-credential-注入-fixture-value' }),
    member('vuln', 'marker-finding', { note: 'ordinary observation [REDACTED:RCE-credential-注入]' }),
    member('vuln', 'advised-finding', { fix: 'public fixture password=example-only' }),
  ]);
  const report = buildReportJson(h.args);
  assert.equal(report.impact.severity.level, '中');
  assert.ok(report.remediation.items.slice(0, 2).every((i) => i.advice.includes('最小权限与补丁管理基线')));
  assert.equal(report.remediation.items[2].advice, 'public fixture password=example-only', 'existing no-vault display contract remains intact');
  assert.match(section(buildReport(h.args).markdown, '影响面摘要'), /影响面等级：中/);
});

test('known complete redaction markers neutralize risk tails after closing brackets in vault labels', (t) => {
  const label = 'public]RCE-credential-注入';
  const h = fixture(t, [{ value: 'marker-fixture-private-value', label }]);
  const marker = `[REDACTED:${label}]`;
  h.ingest([member('vuln', `finding-${marker}`, { note: `ordinary observation ${marker}` })]);
  const report = buildReportJson(h.args);
  assert.equal(report.impact.severity.level, '中');
  assert.match(report.remediation.items[0].advice, /最小权限与补丁管理基线/);
  assert.match(section(buildReport(h.args).markdown, '影响面摘要'), /影响面等级：中/);
});

test('overlapping registered labels neutralize the longest complete marker first', (t) => {
  const values = [{ value: 'first-private-value', label: 'public' },
    { value: 'second-private-value', label: 'public]RCE-credential-注入' }];
  const h = fixture(t, values);
  h.ingest([member('vuln', 'finding', { note: `ordinary observation [REDACTED:${values[1].label}]` })]);
  const report = buildReportJson(h.args);
  assert.equal(report.impact.severity.level, '中');
  assert.match(report.remediation.items[0].advice, /最小权限与补丁管理基线/);
});

test('schema enum values matching secrets stay fixed while payload/display refs are scrubbed', (t) => {
  const words = ['asset', 'vuln', 'credential', 'session', 'shell', 'chain', 'chain-step', 'explicit', 'inferred', 'fact',
    'high', 'medium', 'unknown', '高', '中', 'gungnir-report/1', 'full', 'client', 'blue'];
  const h = fixture(t, words.map((value) => ({ value, label: 'enum-fixture' })));
  h.ingest([
    member('asset', 'asset-private'),
    member('vuln', 'vuln-private', { asset: 'asset-private', note: '中' }),
    member('credential', 'credential-private', { note: 'credential' }),
    member('session', 'session-private', { steps: [{ from: 'vuln-private', to: 'session-private', via: 'explicit' }] }),
    member('chain', 'chain-private'),
  ]);
  const report = buildReportJson(h.args);
  assert.equal(report.schema, 'gungnir-report/1');
  assert.deepEqual(report.facts.effective.map((f) => f.entity_type), ['asset', 'vuln', 'credential', 'session', 'chain']);
  assert.deepEqual(report.topology.nodes.map((n) => n.kind), ['asset', 'vuln', 'credential', 'session', 'chain']);
  assert.deepEqual(report.topology.edges.map((e) => e.kind), ['explicit', 'inferred']);
  assert.deepEqual(report.ioc.map((i) => [i.kind, i.source, i.confidence]).sort((a, b) => a[0].localeCompare(b[0])),
    [['chain-step', 'fact', 'medium'], ['credential-ref', 'fact', 'high'], ['session', 'fact', 'high']]);
  assert.deepEqual(Object.keys(report.ioc_summary.by_kind).sort(), ['chain-step', 'credential-ref', 'session']);
  assert.equal(report.impact.severity.level, '中');
  assert.ok(report.impact.severity.reasons.every((r) => r.level === '中'));
  assert.equal(report.impact.control.current_validity, 'unknown');
  assert.equal(report.shell.current_validity, 'unknown');
  assert.equal(report.facts.effective[2].payload.note, '[REDACTED:enum-fixture]');
  assert.ok(report.facts.effective.every((f) => f.source_id.includes('[REDACTED:enum-fixture]')));
  assert.ok(report.topology.edges.every((e) => report.topology.nodes.some((n) => n.id === e.from) && report.topology.nodes.some((n) => n.id === e.to)));
  const md = buildReport(h.args).markdown;
  assert.match(md, /### credential（1）/);
  assert.match(section(md, '影响面摘要'), /影响面等级：中/);
  assert.match(section(md, 'IOC / 清理附录（自动聚合 3 项，人工确认后交付）'), /\*\*credential-ref\*\*/);
  assert.match(section(md, '攻击路径拓扑'), /==>/, 'session kind remains a control-plane node after enum-valued redaction');
});

for (const audience of ['full', 'client', 'blue']) {
  test(`${audience} cross-format export preserves active conclusions, schema, history and read-only watermark`, (t) => {
    const secret = 'private-RCE|fixture-history-2026';
    const h = fixture(t, [{ value: secret, label: 'credential-注入' }, { value: audience, label: 'enum' }]);
    const src = `host-${secret}`;
    h.ingest([member('asset', src), member('vuln', 'finding', { asset: src, note: 'RCE', fix: 'retired-fix' })]);
    h.ingest([member('vuln', 'finding', { asset: src, note: `版本泄露 ${secret}`, fix: `rotate ${secret}` }, 2)]);
    h.stale([member('shell', `inactive-${secret}`, { note: 'RCE' })]);
    const before = h.store.exportSnapshot();
    const dbBefore = [databaseRows(h.store.db), databaseRows(h.args.globalDb)];
    const out = exportReport({ ...h.args, audience, format: 'all', outDir: join(h.dir, audience) });
    const md = readFileSync(out.paths.markdown, 'utf8');
    const html = readFileSync(out.paths.html, 'utf8');
    const report = JSON.parse(readFileSync(out.paths.json, 'utf8'));
    assert.equal(report.audience, audience);
    assert.equal(report.schema, 'gungnir-report/1');
    assert.deepEqual(report.impact.findings, { vulns: 1, credentials: 0, chains: 0, shells: 0 });
    assert.equal(report.impact.severity.level, '中');
    assert.deepEqual(report.remediation.items.map((i) => i.advice), ['rotate [REDACTED:credential-注入]']);
    assert.equal(report.topology.nodes.length, 2);
    assert.deepEqual(report.topology.edges.map((e) => [e.from, e.to]), [[report.topology.nodes[0].id, report.topology.nodes[1].id]]);
    assert.equal(report.facts.effective.length, 2);
    assert.equal(report.facts.quarantined.length, 2, 'client JSON keeps full scrubbed history as existing contract');
    assert.equal(report.facts.quarantined[0].payload.fix, 'retired-fix');
    assert.equal(report.facts.quarantined[1].entity_type, 'shell');
    assert.equal(report.facts.quarantined[1].flags, 'stale_generation');
    assert.equal(report.ioc_summary.total, 0);
    assert.equal(md.includes(secret) || html.includes(secret) || JSON.stringify(report).includes(secret), false);
    assert.match(section(md, '影响面摘要'), /影响面等级：中/);
    assert.match(html, /影响面等级：中/);
    assert.match(section(md, '攻击路径拓扑'), /节点 2 · 边 1/);
    assert.match(html, /节点 2 · 边 1/);
    assert.doesNotMatch(md + html, /retired-fix|已取得控制面证明/);
    assert.equal(out.self_check.reproducible, true);
    assert.deepEqual(report.watermark, { seq: before.seq, snapshot_id: before.snapshot_id, exported_at: before.exported_at });
    assert.equal(report.evidence_digests.fact_members, digest(before.rows));
    assert.equal(parseReportHeader(md).fact_members_digest, digest(before.rows));
    assert.deepEqual(h.store.exportSnapshot(), before);
    assert.deepEqual([databaseRows(h.store.db), databaseRows(h.args.globalDb)], dbBefore);
    t.diagnostic(JSON.stringify({ audience, formats: Object.keys(out.paths), schema: report.schema,
      active: report.facts.effective.length, history: report.facts.quarantined.length,
      nodes: report.topology.nodes.length, edges: report.topology.edges.length,
      severity: report.impact.severity.level, reproducible: out.self_check.reproducible, database_unchanged: true }));
  });
}
