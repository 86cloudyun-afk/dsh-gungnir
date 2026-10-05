// PR183/186 contract regression: inert temporary SQLite and an in-memory synthetic vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngagementDb, openGlobalDb } from '../packages/warroom-core/src/db.js';
import { FactStore } from '../packages/warroom-core/src/store.js';
import { exportReport, parseReportHeader } from '../packages/warroom-core/src/report.js';
import { buildTopology, toMermaid, toMermaidGrouped } from '../packages/warroom-core/src/topology.js';
import { redact } from '../packages/warroom-core/src/redactor.js';

const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const PREFIX = 'public-long-label-'.repeat(4);
const A = 'ComboPrivateAlpha-0123456789|"[]{}<fixture>/abcdefghijklmnopqrstuvwxyz';
const B = 'ComboPrivateBeta-0123456789|"[]{}<fixture>/abcdefghijklmnopqrstuvwxyz';
const VIA = 'ComboPrivateVia-RCE-credential-注入-0123456789|"[]{}<fixture>/abcdefghijklmnopqrstuvwxyz';
const TYPE = 'ComboPrivateType-2026';
const HASH = 'ComboPrivateHash-2026';
const GEN = 'ComboPrivateGeneration-2026';
const SHARED = 'shared-public-label-012345678901234567890123456789';
const values = [
  { value: A, label: SHARED }, { value: B, label: SHARED },
  { value: VIA, label: 'public]RCE-credential-注入' },
  { value: TYPE, label: 'type-fixture' }, { value: HASH, label: 'hash-fixture' },
  { value: GEN, label: 'generation-fixture' }, { value: 'REDACTED', label: 'neutral' },
  ...['asset', 'vuln', 'credential', 'session', 'chain', 'shell', 'other', 'inferred',
    'explicit', 'fact', 'high', 'unknown', 'gungnir-report/1', 'full', 'client', 'blue']
    .map((value) => ({ value, label: 'enum-fixture' })),
];
const R = (s) => redact(s, values);
const sqlRows = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
const section = (md, title) => md.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? '';
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-02T12:00:00.000Z') });
  const dir = mkdtempSync(join(tmpdir(), 'report-combo-'));
  const db = openEngagementDb(join(dir, 'engagement'));
  const globalDb = openGlobalDb(join(dir, 'global'));
  t.after(() => { db.close(); globalDb.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = new FactStore(db, 'eng_combo_fixed');
  store._now = () => '2026-01-02T03:04:05.000Z';
  const hostA = `${PREFIX}${A}-public-tail`;
  const hostB = `${PREFIX}${B}-public-tail`;
  const sessionA = `session-${A}`;
  const sessionB = `session-${B}`;
  const via = `${PREFIX}${VIA}-public-via-tail`;
  const headers = Object.fromEntries([[A, 'entry-one'], [B, 'entry-two'],
    [R(A), 'public-marker-entry'], [`${R(A)}#2`, 'public-suffix-entry'],
    ['__proto__', 'prototype-entry'], ['asset', 'free-reserved-name-entry']]);
  const member = (entity_type, source_id, payload = {}, revision_no = 1) => ({
    entity_type, source_id, payload, revision_no,
    content_hash: `opaque-${HASH}-${digest([entity_type, source_id, payload, revision_no])}`,
  });
  const ingest = (members) => store.ingestMembers({ adapterInstance: 'combo-fixture', generation: `active-${GEN}`, members });
  ingest([
    member('asset', hostA), member('asset', hostB),
    member('session', sessionA, { host: hostA }), member('session', sessionB, { host: hostB }),
    member('credential', `cred-${A}`), member('credential', `cred-${B}`),
    member('chain', 'route-public', { steps: [{ from: hostA, to: 'finding', via }] }),
    member('vuln', 'finding', { note: 'historical public RCE', fix: 'old historical advice' }),
    member(`custom-${TYPE}`, 'custom-record'),
  ]);
  ingest([member('vuln', 'finding', {
    note: `ordinary observation [REDACTED:RCE] [REDACTED:public]RCE-credential-注入] ${VIA}`,
    asset: { ref: hostA, entity_type: 'asset' }, nested: { headers },
  }, 2)]);
  ingest([member('vuln', 'finding', { note: 'late public RCE', fix: 'late historical advice' }, 1)]);
  ingest([member('vuln', 'finding', { note: 'conflict public RCE', fix: 'conflict historical advice' }, 2)]);
  store.quarantineStaleGeneration({ adapterInstance: 'combo-fixture', generation: `stale-${GEN}`, members: [
    member('shell', 'isolated-shell', { proof: 'historical proof', achieved_via: hostA }),
    member(`custom-${TYPE}`, 'isolated-custom'),
  ] });
  return { dir, db, globalDb, store, hostA, hostB, via,
    args: { store, globalDb, engagementId: store.engagementId, vault: { values: () => values, redact: R } } };
}

test('topology retains the redaction callback and full display labels without changing raw joins', () => {
  const sources = [`${PREFIX}${A}-public-tail`, `${PREFIX}${B}-public-tail`];
  const seen = [];
  const rows = [
    { entity_type: 'asset', source_id: sources[0], payload: '{}' },
    { entity_type: 'session', source_id: sources[1], payload: JSON.stringify({ host: sources[0] }) },
  ];
  const topology = buildTopology(rows, { redactLabel: (s) => { seen.push(s); return R(s); } });
  assert.deepEqual(seen, sources, 'callback receives each complete original source exactly once');
  assert.deepEqual(topology.nodes.map((n) => n.label), sources.map(R));
  assert.ok(topology.nodes.every((n) => n.label.length > 40 && n.label.endsWith('-public-tail')));
  assert.deepEqual(topology.nodes.map((n) => n.id), [`asset:${sources[0]}`, `session:${sources[1]}`]);
  assert.deepEqual(topology.edges, [{ from: `asset:${sources[0]}`, to: `session:${sources[1]}`, via: 'host', kind: 'inferred' }]);
  assert.equal(buildTopology(rows).nodes[0].label, sources[0], 'default callback retains complete no-vault labels');
});

test('both Mermaid renderers and the critical list shorten display labels and edge via only', () => {
  const nodeLabel = `${PREFIX}[REDACTED:long-label]-public-tail`;
  const edgeLabel = `${PREFIX}[REDACTED:via-label]-public-tail`;
  const graph = { nodes: [{ id: 'public-a', label: nodeLabel, kind: 'asset' },
    { id: 'public-b', label: nodeLabel, kind: 'session' }],
  edges: [{ from: 'public-a', to: 'public-b', via: edgeLabel, kind: 'explicit' }], unexplained: 0 };
  const before = structuredClone(graph);
  for (const text of [toMermaid(graph), toMermaidGrouped(graph).mermaid]) {
    assert.equal(text.includes(nodeLabel), false);
    assert.equal(text.includes(edgeLabel), false);
    assert.ok(text.includes('…'));
    assert.match(text, /flowchart LR/);
  }
  const { critical } = toMermaidGrouped(graph);
  assert.equal(critical.length, 1);
  assert.ok(['from', 'to', 'via'].every((key) => critical[0][key].length <= 40 && critical[0][key].endsWith('…')));
  assert.deepEqual(graph, before, 'rendering never mutates full labels, identities or edge data');
});

for (const audience of ['full', 'client', 'blue']) {
  test(`${audience} combined exports keep complete scrubbed JSON labels and all PR183 boundaries`, (t) => {
    const h = fixture(t);
    const snapshot = h.store.exportSnapshot();
    const database = [sqlRows(h.db), sqlRows(h.globalDb)];
    const out = exportReport({ ...h.args, audience, format: 'all', outDir: join(h.dir, audience) });
    const json = JSON.parse(readFileSync(out.paths.json, 'utf8'));
    const markdown = readFileSync(out.paths.markdown, 'utf8');
    const html = readFileSync(out.paths.html, 'utf8');
    assert.equal(json.topology.nodes[0].label, R(h.hostA));
    assert.equal(json.topology.nodes[1].label, R(h.hostB));
    assert.ok(json.topology.nodes.slice(0, 2).every((n) => n.label.length > 40 && n.label.endsWith('-public-tail')));
    assert.equal(json.topology.edges[0].via, R(h.via), 'JSON keeps complete scrubbed via');
    assert.deepEqual(json.topology.edges.map((e) => [e.from, e.to, e.kind]), [
      [json.topology.nodes[0].id, json.topology.nodes[8].id, 'explicit'],
      [json.topology.nodes[0].id, json.topology.nodes[2].id, 'inferred'],
      [json.topology.nodes[1].id, json.topology.nodes[3].id, 'inferred'],
    ]);
    assert.equal(new Set(json.topology.nodes.map((n) => n.id)).size, 9);
    assert.equal(json.topology.edges.length, 3);
    assert.equal(json.facts.effective.length, 9);
    assert.equal(json.facts.quarantined.length, 5);
    assert.deepEqual(new Set(json.facts.quarantined.map((f) => f.flags ?? 'superseded')),
      new Set(['superseded', 'late_revision', 'conflict_review', 'stale_generation']));
    assert.equal(json.ioc_summary.total, 5, 'two sessions, two credentials and the active chain all retain IOC evidence');
    assert.equal(new Set(json.ioc.map((i) => i.evidence_ref)).size, 5);
    assert.equal(json.impact.scope.assets, 4);
    assert.deepEqual(json.impact.findings, { vulns: 1, credentials: 2, chains: 1, shells: 0 });
    assert.equal(json.impact.severity.level, '中');
    assert.equal(json.shell.current_validity, 'unknown');
    assert.equal(json.shell.highest_proof, null);
    assert.ok(json.remediation.items.every((i) => i.generic && i.advice.includes('最小权限与补丁管理基线')));
    const finding = json.facts.effective.find((f) => f.entity_type === 'vuln');
    assert.deepEqual(finding.payload.asset, { ref: R(h.hostA), entity_type: 'asset' });
    const headers = finding.payload.nested.headers;
    assert.equal(Object.keys(headers).length, 6);
    assert.deepEqual(Object.values(headers).sort(), ['entry-one', 'entry-two', 'free-reserved-name-entry',
      'prototype-entry', 'public-marker-entry', 'public-suffix-entry'].sort());
    assert.equal(Object.hasOwn(headers, '__proto__'), true);
    assert.equal(Object.hasOwn(headers, 'asset'), false, 'nested map keys are free text while root ref schema is preserved');
    assert.equal(json.schema, 'gungnir-report/1');
    assert.equal(json.audience, audience);
    assert.deepEqual(json.topology.nodes.map((n) => n.kind), ['asset', 'asset', 'session', 'session', 'credential', 'credential', 'chain', 'other', 'vuln']);
    assert.ok(json.facts.effective.find((f) => f.entity_type.startsWith('custom-')));
    for (const text of [markdown, html, JSON.stringify(json)]) {
      for (const secret of [A, B, VIA, TYPE, HASH, GEN]) assert.equal(text.includes(secret), false, secret);
      assert.equal(text.includes('ComboPrivateAlpha-0123456789'), false, 'no escaped/truncated secret prefix');
      assert.equal(text.includes('ComboPrivateVia-RCE'), false);
    }
    const graph = section(markdown, '攻击路径拓扑');
    assert.match(graph, /节点 9 · 边 3/);
    assert.match(graph, /关键跳清单/);
    assert.equal(graph.includes(R(h.hostA)), false, 'Mermaid and its critical list alone are display-shortened');
    assert.equal(graph.includes(R(h.via)), false);
    assert.match(graph, /…/);
    assert.match(section(markdown, '影响面摘要'), /影响面等级：中/);
    assert.match(html, /影响面等级：中/);
    assert.deepEqual(json.watermark, { seq: 4, snapshot_id: snapshot.snapshot_id, exported_at: snapshot.exported_at });
    assert.equal(json.evidence_digests.fact_members, digest(snapshot.rows));
    assert.equal(parseReportHeader(markdown).snapshot_id, snapshot.snapshot_id);
    assert.equal(parseReportHeader(markdown).fact_members_digest, digest(snapshot.rows));
    assert.deepEqual(h.store.exportSnapshot(), snapshot);
    assert.deepEqual([sqlRows(h.db), sqlRows(h.globalDb)], database);
    t.diagnostic(JSON.stringify({ audience, active: 9, history: 5, full_rows: 14, seq: 4,
      nodes: 9, edges: 3, ioc: 5, assets: 4, map_entries: 6, json_label_length: json.topology.nodes[0].label.length,
      json_policy: 'complete scrubbed label/via; Mermaid/critical display only shortens beyond 40' }));
  });
}
