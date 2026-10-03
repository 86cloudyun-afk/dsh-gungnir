// Read-side regression only: fixed inert members, temporary SQLite, no adapter or broker execution.
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

const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const member = (entity_type, source_id, revision_no, payload = {}, hash = '') => ({
  entity_type, source_id, revision_no, payload, content_hash: digest([entity_type, source_id, revision_no, payload, hash]),
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'report-active-'));
  const db = openEngagementDb(join(dir, 'engagement'));
  const globalDb = openGlobalDb(join(dir, 'global'));
  t.after(() => { db.close(); globalDb.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = new FactStore(db, 'eng_report_fixture');
  store._now = () => '2026-01-01T00:00:00.000Z';
  const args = { store, globalDb, engagementId: store.engagementId };
  const ingest = (members) => store.ingestMembers({ adapterInstance: 'fixture', generation: '1:1:1', members });
  const stale = (members) => store.quarantineStaleGeneration({ adapterInstance: 'fixture', generation: '0:0:0', members });
  return { dir, store, args, ingest, stale };
}

function revisedFixture(t) {
  const h = fixture(t);
  h.ingest([member('asset', 'asset-old', 1), member('asset', 'asset-current', 1)]);
  h.ingest([member('vuln', 'finding', 1, { asset: 'asset-old', note: 'RCE', remediation: 'retired-only-fix' })]);
  h.ingest([member('vuln', 'finding', 2, { asset: 'asset-current', note: '版本泄露', remediation: 'current-only-fix' })]);
  return h;
}

function section(md, title) {
  return md.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? '';
}

function databaseRows(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}

test('JSON conclusions count only revision 2 while revision 1 remains in history', (t) => {
  const h = revisedFixture(t);
  const report = buildReportJson(h.args);
  assert.equal(report.impact.findings.vulns, 1);
  assert.equal(report.impact.severity.level, '中');
  assert.deepEqual(report.remediation.items.map((i) => i.advice), ['current-only-fix']);
  assert.deepEqual(report.topology.nodes.map((n) => n.id), ['asset:asset-old', 'asset:asset-current', 'vuln:finding']);
  assert.deepEqual(report.topology.edges, [{ from: 'asset:asset-current', to: 'vuln:finding', via: 'asset', kind: 'inferred' }]);
  assert.equal(report.topology.unexplained, 0);
  assert.equal(report.facts.effective.find((f) => f.source_id === 'finding').revision_no, 2);
  assert.equal(report.facts.quarantined.length, 1);
  assert.equal(report.facts.quarantined[0].payload.remediation, 'retired-only-fix');
  assert.ok(report.facts.quarantined[0].superseded_by);
});

test('Markdown conclusions exclude revision 1 and keep its history reference', (t) => {
  const h = revisedFixture(t);
  const { markdown: md } = buildReport(h.args);
  assert.match(section(md, '影响面摘要'), /弱点 1 条/);
  assert.match(section(md, '影响面摘要'), /影响面等级：中/);
  assert.match(section(md, '修复建议'), /current-only-fix/);
  assert.doesNotMatch(section(md, '修复建议'), /retired-only-fix/);
  assert.match(section(md, '攻击路径拓扑'), /节点 3 · 边 1/);
  assert.match(section(md, '未采用记录（隔离\/历史\/待审）'), /vuln\/finding r1/);
});

for (const flag of ['late_revision', 'conflict_review', 'stale_generation']) {
  test(`${flag} does not contribute nodes, edges, findings or advice`, (t) => {
    const h = fixture(t);
    h.ingest([member('asset', 'asset-current', 1), member('vuln', 'finding', 2, {
      asset: 'asset-current', note: '版本泄露', remediation: 'accepted-fix',
    })]);
    const rejected = member('vuln', flag === 'stale_generation' ? 'inactive-finding' : 'finding',
      flag === 'late_revision' ? 1 : 2, { asset: 'asset-current', note: 'RCE', remediation: 'excluded-fix' });
    if (flag === 'stale_generation') h.stale([rejected]);
    else h.ingest([rejected]);
    const report = buildReportJson(h.args);
    assert.equal(report.facts.quarantined[0].flags, flag);
    assert.equal(report.impact.findings.vulns, 1);
    assert.equal(report.impact.severity.level, '中');
    assert.deepEqual(report.remediation.items.map((i) => i.advice), ['accepted-fix']);
    assert.equal(report.topology.nodes.length, 2);
    assert.equal(report.topology.edges.length, 1);
    assert.equal(report.topology.unexplained, 0);
    const { markdown: md } = buildReport(h.args);
    assert.match(section(md, '影响面摘要'), /弱点 1 条/);
    assert.doesNotMatch(section(md, '修复建议'), /excluded-fix/);
    assert.match(section(md, '攻击路径拓扑'), /节点 2 · 边 1/);
    assert.ok(section(md, '未采用记录（隔离/历史/待审）').includes(`flags=${flag}`));
  });
}

test('Inactive-only entities and references do not create a control proof or topology edge', (t) => {
  const h = fixture(t);
  h.stale(['asset', 'domain', 'vuln', 'credential', 'session', 'chain', 'shell', 'persistence'].map((type) =>
    member(type, `inactive-${type}`, 1, { asset: 'inactive-asset', note: 'RCE', remediation: 'excluded-fix' })));
  h.ingest([member('vuln', 'accepted-finding', 1, { asset: 'inactive-asset', note: '版本泄露', fix: 'accepted-fix' })]);
  const report = buildReportJson(h.args);
  assert.equal(h.store.shellState(), null);
  assert.deepEqual(report.impact.scope, { assets: 0, domains: 0, note: '资产/域名按事实库中的实体计数（同一 source_id 只算一次）' });
  assert.deepEqual(report.impact.findings, { vulns: 1, credentials: 0, chains: 0, shells: 0 });
  assert.equal(report.impact.control.highest_proof, null);
  assert.equal(report.impact.control.current_validity, 'unknown');
  assert.equal(report.impact.severity.level, '中');
  assert.deepEqual(report.topology.nodes.map((n) => n.id), ['vuln:accepted-finding']);
  assert.deepEqual(report.topology.edges, []);
  assert.equal(report.topology.unexplained, 1);
  assert.deepEqual(report.remediation.items.map((i) => i.advice), ['accepted-fix']);
  assert.equal(report.facts.quarantined.length, 8);
  const { markdown: md } = buildReport(h.args);
  assert.doesNotMatch(section(md, '影响面摘要'), /已取得控制面证明/);
  assert.match(section(md, '影响面摘要'), /控制面事实 0 条/);
  assert.match(section(md, 'shell 状态'), /unknown/);
  assert.equal(section(md, '攻击路径拓扑'), '');
});

test('Active parsed payloads keep explicit references, advice aliases and synthetic redaction', (t) => {
  const h = fixture(t);
  const value = 'fixture-RCE-only-private-value';
  const values = [{ label: 'fixture', value }];
  h.args.vault = { values: () => values, redact: (s) => redact(s, values) };
  h.ingest([
    member('asset', 'asset-current', 1),
    member('vuln', 'finding', 1, { asset: 'asset-current', note: `版本泄露 ${value}`, fix: `rotate ${value}` }),
    member('chain', 'accepted-chain', 1, { steps: [{ from: 'asset-current', to: 'finding', via: 'observed' }],
      path: ['finding', 'accepted-chain'], advice: 'retain-current-advice' }),
    member('credential', 'accepted-credential', 1, { note: 'credential leak' }),
  ]);
  const report = buildReportJson(h.args);
  assert.equal(report.schema, 'gungnir-report/1');
  assert.equal(typeof report.facts.effective[1].payload, 'object');
  assert.deepEqual(report.topology.edges, [
    { from: 'asset:asset-current', to: 'vuln:finding', via: 'observed', kind: 'explicit' },
    { from: 'vuln:finding', to: 'chain:accepted-chain', via: 'path', kind: 'explicit' },
  ]);
  assert.deepEqual(report.impact.findings, { vulns: 1, credentials: 1, chains: 1, shells: 0 });
  assert.equal(report.impact.severity.level, '中');
  assert.equal(report.remediation.generic_count, 1);
  assert.deepEqual(report.remediation.items.slice(0, 2).map((i) => i.advice),
    ['rotate [REDACTED:fixture]', 'retain-current-advice']);
  assert.match(report.remediation.items[2].advice, /轮换已泄露凭据/);
  assert.equal(JSON.stringify(report).includes(value), false);
  const { markdown: md } = buildReport(h.args);
  assert.equal(md.includes(value), false);
  assert.match(section(md, '影响面摘要'), /影响面等级：中/);
  assert.match(section(md, '修复建议'), /rotate \[REDACTED:fixture\]/);
  assert.match(section(md, '攻击路径拓扑'), /节点 4 · 边 2/);
});

test('Without a vault, active advice keeps the existing JSON/Markdown payload contract', (t) => {
  const h = fixture(t);
  const advice = 'public fixture password=example-only';
  h.ingest([member('vuln', 'finding', 1, { remediation: advice })]);
  assert.equal(buildReportJson(h.args).remediation.items[0].advice, advice);
  assert.ok(section(buildReport(h.args).markdown, '修复建议').includes(advice));
});

for (const audience of ['full', 'client', 'blue']) {
  test(`${audience} JSON/Markdown/HTML exports retain active conclusions and full snapshot without database writes`, (t) => {
    const h = revisedFixture(t);
    h.stale([member('shell', 'inactive-shell', 1)]);
    const before = h.store.exportSnapshot();
    const rowsBefore = [databaseRows(h.store.db), databaseRows(h.args.globalDb)];
    const out = exportReport({ ...h.args, audience, format: 'all', outDir: join(h.dir, audience) });
    const md = readFileSync(out.paths.markdown, 'utf8');
    const html = readFileSync(out.paths.html, 'utf8');
    const report = JSON.parse(readFileSync(out.paths.json, 'utf8'));
    assert.equal(report.audience, audience);
    assert.equal(report.impact.findings.vulns, 1);
    assert.equal(report.impact.findings.shells, 0);
    assert.equal(report.impact.severity.level, '中');
    assert.deepEqual(report.remediation.items.map((i) => i.advice), ['current-only-fix']);
    assert.equal(report.topology.nodes.length, 3);
    assert.equal(report.topology.edges.length, 1);
    assert.equal(report.facts.quarantined.length, 2);
    assert.match(section(md, '影响面摘要'), /弱点 1 条/);
    assert.match(section(md, '攻击路径拓扑'), /节点 3 · 边 1/);
    assert.match(md, /vuln\/finding r1/);
    assert.match(md, /shell\/inactive-shell r1/);
    assert.match(html, /弱点 1 条/);
    assert.match(html, /控制面事实 0 条/);
    assert.match(html, /节点 3 · 边 1/);
    assert.match(html, /current-only-fix/);
    assert.doesNotMatch(md + html, /retired-only-fix|已取得控制面证明/);
    assert.equal(out.self_check.reproducible, true);
    assert.equal(report.self_check.reproducible, true);
    assert.deepEqual(report.watermark, out.watermark);
    assert.equal(out.watermark.seq, before.seq);
    assert.equal(out.watermark.snapshot_id, before.snapshot_id);
    assert.equal(report.evidence_digests.fact_members, digest(before.rows));
    assert.equal(parseReportHeader(md).fact_members_digest, digest(before.rows));
    const activeRows = before.rows.filter((r) => r.active === 1);
    assert.notEqual(report.evidence_digests.fact_members, digest(activeRows));
    assert.notEqual(report.watermark.snapshot_id, digest({ seq: before.seq, rows: activeRows }));
    assert.deepEqual(h.store.exportSnapshot(), before);
    assert.deepEqual([databaseRows(h.store.db), databaseRows(h.args.globalDb)], rowsBefore);
    assert.equal(buildReport(h.args).size.facts, before.rows.length);
  });
}
