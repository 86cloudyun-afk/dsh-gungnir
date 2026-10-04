// Fixed inert read-side fixture: temporary SQLite and in-memory synthetic vault only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateReceipt } from '../packages/shared-types/src/index.js';
import { openEngagementDb, openGlobalDb } from '../packages/warroom-core/src/db.js';
import { FactStore } from '../packages/warroom-core/src/store.js';
import { buildReportJson, exportReport, parseReportHeader } from '../packages/warroom-core/src/report.js';
import { redact, redactForAnalysis } from '../packages/warroom-core/src/redactor.js';

const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const member = (entity_type, source_id, payload = {}, revision_no = 1, content_hash = digest([entity_type, source_id, payload, revision_no])) =>
  ({ entity_type, source_id, payload, revision_no, content_hash });
const section = (md, title) => md.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? '';

function databaseRows(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}
function fixture(t, values) {
  const dir = mkdtempSync(join(tmpdir(), 'report-concentrated-'));
  const db = openEngagementDb(join(dir, 'engagement'));
  const globalDb = openGlobalDb(join(dir, 'global'));
  t.after(() => { db.close(); globalDb.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = new FactStore(db, 'eng_concentrated_fixture');
  store._now = () => '2026-01-01T00:00:00.000Z';
  const args = { store, globalDb, engagementId: store.engagementId, vault: { values: () => values, redact: (s) => redact(s, values) } };
  const ingest = (members, generation = '1:1:1') => store.ingestMembers({ adapterInstance: 'inert-fixture', generation, members });
  const stale = (members, generation = '0:0:0') => store.quarantineStaleGeneration({ adapterInstance: 'inert-fixture', generation, members });
  return { dir, store, args, ingest, stale };
}
function assertSnapshotUnchanged(h, before, rowsBefore, out, md, report) {
  assert.equal(out.self_check.reproducible, true);
  assert.equal(report.self_check.reproducible, true);
  assert.deepEqual(report.watermark, { seq: before.seq, snapshot_id: before.snapshot_id, exported_at: before.exported_at });
  assert.equal(report.evidence_digests.fact_members, digest(before.rows));
  assert.equal(parseReportHeader(md).fact_members_digest, digest(before.rows));
  assert.deepEqual(h.store.exportSnapshot(), before);
  assert.deepEqual([databaseRows(h.store.db), databaseRows(h.args.globalDb)], rowsBefore);
}

test('historical markers are removed before registered secret values can damage their prefix', () => {
  const values = [{ value: 'REDACTED', label: 'neutral' }];
  assert.equal(redactForAnalysis('ordinary observation [REDACTED:RCE]', values), 'ordinary observation  ');
  assert.equal(redactForAnalysis('ordinary observation [redacted:credential]', values), 'ordinary observation  ');
  assert.equal(redactForAnalysis('ordinary observation [REDACTED:注入]', values), 'ordinary observation  ');
  assert.equal(redactForAnalysis('ordinary observation [REDACTED:RCE] public RCE', values), 'ordinary observation   public RCE');
});

for (const audience of ['full', 'client', 'blue']) {
  test(`${audience} historical marker prefix secrets do not inflate severity or generic advice`, (t) => {
    const values = [{ value: 'REDACTED', label: 'neutral' }];
    const h = fixture(t, values);
    h.ingest([member('vuln', 'ordinary-finding', { note: 'ordinary observation [REDACTED:RCE]' })]);
    h.stale([member('shell', 'inactive-shell', { note: 'RCE' })]);
    const before = h.store.exportSnapshot();
    const rowsBefore = [databaseRows(h.store.db), databaseRows(h.args.globalDb)];
    const out = exportReport({ ...h.args, audience, format: 'all', outDir: join(h.dir, audience) });
    const md = readFileSync(out.paths.markdown, 'utf8');
    const html = readFileSync(out.paths.html, 'utf8');
    const report = JSON.parse(readFileSync(out.paths.json, 'utf8'));
    assert.equal(report.impact.severity.level, '中');
    assert.match(report.remediation.items[0].advice, /最小权限与补丁管理基线/);
    assert.match(section(md, '影响面摘要'), /影响面等级：中/);
    assert.match(html, /影响面等级：中/);
    assert.doesNotMatch(section(md, '修复建议'), /避免拼接命令/);
    assert.doesNotMatch(html, /避免拼接命令/);
    assert.equal(report.facts.effective[0].payload.note, redact('ordinary observation [REDACTED:RCE]', values), 'display redactor keeps its existing behavior');
    assert.deepEqual(report.impact.findings, { vulns: 1, credentials: 0, chains: 0, shells: 0 });
    assert.equal(report.facts.quarantined.length, 1);
    assert.equal(report.topology.nodes.length, 1);
    assert.equal(report.topology.edges.length, 0);
    assert.equal(report.impact.control.highest_proof, null);
    assert.equal(report.schema, 'gungnir-report/1');
    assert.equal(report.audience, audience);
    assertSnapshotUnchanged(h, before, rowsBefore, out, md, report);
    t.diagnostic(JSON.stringify({ group: 'marker-prefix', audience, formats: Object.keys(out.paths),
      severity: report.impact.severity.level, generic_advice: 'baseline', active: 1, history: 1, reproducible: true, database_unchanged: true }));
  });
}

for (const audience of ['full', 'client', 'blue']) {
  test(`${audience} custom fact types and opaque hash/generation metadata are scrubbed only in display`, (t) => {
    const typeA = 'SynthType-Private-2026';
    const typeB = 'SynthType-Private-B-2026';
    const hash = 'SynthHash-Private-2026';
    const generation = 'SynthGen-Private-2026';
    const values = [{ value: typeA, label: 'type-fixture' }, { value: typeB, label: 'type-fixture' },
      { value: hash, label: 'hash-fixture' }, { value: generation, label: 'generation-fixture' }, { value: 'asset', label: 'enum-fixture' }];
    const customA = `custom-${typeA}`;
    const customB = `custom-${typeB}`;
    const opaqueHash = `opaque-${hash}`;
    const activeGeneration = `active-${generation}`;
    const archivedGeneration = `archived-${generation}`;
    const h = fixture(t, values);
    const members = [member('asset', 'public-host'), member('vuln', 'ordinary-finding', { asset: 'public-host', fix: 'current public fix' }),
      member(customA, 'custom-a', { note: 'old ordinary observation' }, 1, opaqueHash),
      member(customB, 'custom-b', { note: 'ordinary observation' }, 1, opaqueHash)];
    assert.doesNotThrow(() => validateReceipt({ receipt_id: 'inert-receipt', generation: activeGeneration, members }),
      'current receipt contract permits custom type and opaque metadata; report must handle their display');
    h.ingest(members, activeGeneration);
    h.ingest([member(customA, 'custom-a', { note: 'current ordinary observation' }, 2, opaqueHash)], activeGeneration);
    h.stale([member(customB, 'custom-history', {}, 1, opaqueHash)], archivedGeneration);
    const before = h.store.exportSnapshot();
    const rowsBefore = [databaseRows(h.store.db), databaseRows(h.args.globalDb)];
    const out = exportReport({ ...h.args, audience, format: 'all', outDir: join(h.dir, audience) });
    const md = readFileSync(out.paths.markdown, 'utf8');
    const html = readFileSync(out.paths.html, 'utf8');
    const jsonText = readFileSync(out.paths.json, 'utf8');
    const report = JSON.parse(jsonText);
    for (const text of [md, html, jsonText]) {
      for (const privateValue of [typeA, typeB, hash, generation]) assert.equal(text.includes(privateValue), false);
    }
    assert.equal(report.facts.effective[0].entity_type, 'asset', 'defined enum is preserved even when registered as a secret');
    const customFacts = report.facts.effective.filter((f) => f.source_id.startsWith('custom-'));
    assert.equal(customFacts.length, 2);
    assert.ok(customFacts.every((f) => f.entity_type === 'custom-[REDACTED:type-fixture]'));
    assert.equal(new Set(customFacts.map((f) => f.id)).size, 2, 'shared display labels do not merge original custom classifications');
    assert.ok(customFacts.every((f) => f.content_hash === 'opaque-[REDACTED:hash-fixture]'));
    assert.ok(report.facts.effective.every((f) => f.generation === 'active-[REDACTED:generation-fixture]'));
    assert.equal(report.facts.quarantined.length, 2);
    assert.ok(report.facts.quarantined.every((f) => f.entity_type === 'custom-[REDACTED:type-fixture]' && f.content_hash === 'opaque-[REDACTED:hash-fixture]'));
    assert.equal(report.facts.quarantined.find((f) => f.flags === 'stale_generation').generation, 'archived-[REDACTED:generation-fixture]');
    assert.equal(report.facts.quarantined.find((f) => f.superseded_by).generation, 'active-[REDACTED:generation-fixture]');
    assert.equal((md.match(/### custom-\[REDACTED:type-fixture\]（1）/g) ?? []).length, 2, 'raw custom type groups each retain their own count');
    assert.match(section(md, '未采用记录（隔离/历史/待审）'), /custom-\[REDACTED:type-fixture\]/);
    assert.match(section(md, '证据摘要（sha256，供复现校验）'), /custom-\[REDACTED:type-fixture\]/);
    assert.equal(report.impact.scope.assets, 1);
    assert.deepEqual(report.impact.findings, { vulns: 1, credentials: 0, chains: 0, shells: 0 });
    assert.equal(report.impact.severity.level, '中');
    assert.deepEqual(report.remediation.items.map((i) => i.advice), ['current public fix']);
    assert.equal(report.topology.nodes.length, 4);
    assert.deepEqual(report.topology.nodes.map((n) => n.kind), ['asset', 'vuln', 'other', 'other']);
    assert.equal(report.topology.edges.length, 1);
    assert.equal(report.schema, 'gungnir-report/1');
    assert.equal(report.audience, audience);
    assertSnapshotUnchanged(h, before, rowsBefore, out, md, report);
    delete h.args.vault;
    const plain = buildReportJson(h.args);
    assert.ok(plain.facts.effective.some((f) => f.entity_type === customA && f.content_hash === opaqueHash && f.generation === activeGeneration));
    assert.ok(plain.facts.quarantined.some((f) => f.entity_type === customB && f.generation === archivedGeneration));
    t.diagnostic(JSON.stringify({ group: 'fact-metadata', audience, formats: Object.keys(out.paths), custom_groups: 2,
      active: 4, history: 2, nodes: 4, edges: 1, severity: report.impact.severity.level, reproducible: true, database_unchanged: true }));
  });
}
