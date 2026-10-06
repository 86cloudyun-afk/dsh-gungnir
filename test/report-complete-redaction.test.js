// Harmless synthetic report fixtures: in-memory SQLite and an in-memory vault.
// No adapter execution, existing home, key file, or real target is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FACT_DDL, GLOBAL_DDL } from '../packages/warroom-core/src/db.js';
import { FactStore } from '../packages/warroom-core/src/store.js';
import { redact } from '../packages/warroom-core/src/redactor.js';
import { buildReport, buildReportJson, exportReport } from '../packages/warroom-core/src/report.js';
import { renderHtml } from '../packages/warroom-core/src/html.js';

const SECRET = 'Synthetic-Metadata-Value-2026';
const MARKER = '[REDACTED:fixture]';
const ENTITY_TYPES = ['asset', 'domain', 'vuln', 'credential', 'session', 'chain', 'shell', 'persistence'];

function fixture(t, values = [{ value: SECRET, label: 'fixture' }]) {
  const db = new DatabaseSync(':memory:');
  const globalDb = new DatabaseSync(':memory:');
  db.exec(FACT_DDL);
  globalDb.exec(GLOBAL_DDL);
  const store = new FactStore(db, 'eng_synthetic');
  store._now = () => '2026-10-05T00:00:00.000Z';
  t.after(() => { db.close(); globalDb.close(); });
  const vault = { values: () => values, redact: text => redact(text, values) };
  return { db, globalDb, store, params: { store, globalDb, vault, engagementId: 'eng_synthetic' } };
}

function seedFact(f, { active = true, entityType = `custom-${SECRET}`, metadata = true } = {}) {
  const member = {
    entity_type: entityType,
    source_id: metadata ? `source-${SECRET}` : 'public-source',
    revision_no: 1,
    content_hash: metadata ? `hash-${SECRET}` : 'public-hash',
    payload: { note: metadata ? SECRET : 'public note', nested: [null, { value: metadata ? SECRET : 'public' }] },
  };
  const input = { adapterInstance: metadata ? `adapter-${SECRET}` : 'public-adapter',
    generation: metadata ? `generation-${SECRET}` : 'public-generation', members: [member] };
  if (active) f.store.ingestMembers(input);
  else f.store.quarantineStaleGeneration(input);
  if (metadata) f.db.prepare('UPDATE fact_members SET flags = ?').run(`flag-${SECRET}`);
}

function seedRoute(f) {
  f.db.prepare('INSERT INTO jump_routes (route_id, lease_id, jumphost_id, socks, state, ts) VALUES (?,?,?,?,?,?)')
    .run('rt-opaque', 'lease-public', 'host-public', 'socks5://127.0.0.1:1080', 'active', '2026-10-05T00:00:00.000Z');
}

for (const active of [true, false]) {
  test(`JSON ${active ? 'effective' : 'quarantined'} facts scrub every metadata string and nested payload`, t => {
    const f = fixture(t);
    seedFact(f, { active });
    const rows = buildReportJson(f.params).facts[active ? 'effective' : 'quarantined'];
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes(SECRET), false);
    for (const field of ['entity_type', 'source_id', 'content_hash', 'adapter_instance', 'generation', 'flags']) {
      assert.ok(rows[0][field].includes(MARKER), `${field} must redact arbitrary metadata`);
    }
    assert.equal(rows[0].payload.nested[1].value, MARKER);
    assert.equal(rows[0].active, active ? 1 : 0);
    assert.equal(rows[0].revision_no, 1);
    assert.equal(rows[0].id, 1);
  });

  test(`Markdown and HTML ${active ? 'effective' : 'quarantined'} fact metadata are redacted for every audience`, t => {
    const f = fixture(t);
    seedFact(f, { active });
    for (const audience of ['full', 'client', 'blue']) {
      const { markdown } = buildReport({ ...f.params, audience });
      const html = renderHtml({ markdown, title: 'Synthetic fixture' });
      assert.equal(markdown.includes(SECRET), false, `${audience} Markdown leaks metadata`);
      assert.equal(html.includes(SECRET), false, `${audience} HTML leaks metadata`);
      assert.ok(markdown.includes(MARKER));
    }
  });
}

test('all known entity enums survive while identical free text is redacted', t => {
  const f = fixture(t, ENTITY_TYPES.map(value => ({ value, label: 'entity-enum' })));
  for (const entityType of ENTITY_TYPES) {
    f.store.ingestMembers({ adapterInstance: 'public', generation: 'public', members: [{
      entity_type: entityType, source_id: `row-${ENTITY_TYPES.indexOf(entityType)}`, revision_no: 1,
      content_hash: 'public', payload: { note: entityType },
    }] });
  }
  const report = buildReportJson(f.params);
  assert.deepEqual(report.facts.effective.map(row => row.entity_type), ENTITY_TYPES);
  assert.ok(report.facts.effective.every(row => row.payload.note === '[REDACTED:entity-enum]'));
});

test('unknown nested fact metadata is scrubbed without mutating the snapshot', t => {
  const f = fixture(t);
  seedFact(f, { entityType: 'asset', metadata: false });
  const snapshot = f.store.exportSnapshot();
  snapshot.rows[0].extension = { entries: [SECRET, { value: SECRET }], empty: null, number: 7 };
  const before = JSON.stringify(snapshot);
  const extendedStore = { db: f.db, shellState: () => f.store.shellState(), exportSnapshot: () => snapshot };
  const json = buildReportJson({ ...f.params, store: extendedStore });
  assert.deepEqual(json.facts.effective[0].extension, { entries: [MARKER, { value: MARKER }], empty: null, number: 7 });
  assert.equal(JSON.stringify(snapshot), before);
});

const refCases = [
  { name: 'entire fact reference', secret: 'fact#1', expected: '[REDACTED:ref]', source: 'fact' },
  { name: 'fact reference spanning #', secret: 'ct#1', expected: 'fa[REDACTED:ref]', source: 'fact' },
  { name: 'fact reference prefix', secret: 'fact', expected: '[REDACTED:ref]#1', source: 'fact' },
  { name: 'entire route reference', secret: 'jump_routes#rt-opaque', expected: '[REDACTED:ref]', source: 'route' },
  { name: 'route reference spanning #', secret: 'routes#rt-', expected: 'jump_[REDACTED:ref]opaque', source: 'route' },
  { name: 'route reference suffix', secret: 'rt-opaque', expected: 'jump_routes#[REDACTED:ref]', source: 'route' },
];
for (const scenario of refCases) {
  test(`IOC ${scenario.name} is redacted in JSON, Markdown and HTML`, t => {
    const f = fixture(t, [{ value: scenario.secret, label: 'ref' }]);
    if (scenario.source === 'fact') seedFact(f, { entityType: 'session', metadata: false });
    else seedRoute(f);
    const json = buildReportJson(f.params);
    assert.equal(json.ioc.length, 1);
    const item = json.ioc[0];
    assert.equal(item.evidence_ref, scenario.expected);
    assert.equal(item.kind, scenario.source === 'fact' ? 'session' : 'tunnel');
    assert.equal(item.source, scenario.source);
    assert.equal(item.confidence, 'high');
    assert.equal(item.manual_confirm, scenario.source === 'fact');
    for (const audience of ['full', 'client', 'blue']) {
      const { markdown } = buildReport({ ...f.params, audience });
      const html = renderHtml({ markdown, title: 'Synthetic fixture' });
      assert.equal(markdown.includes(scenario.secret + '）'), false, 'unredacted evidence reference must not remain');
      assert.ok(markdown.includes(`证据 ${scenario.expected}）`));
      assert.ok(html.includes(`证据 ${scenario.expected}）`));
    }
  });
}

test('no-vault exports keep metadata, IOC references and structure unchanged', t => {
  const f = fixture(t);
  seedFact(f, { entityType: 'session' });
  const snapshot = f.store.exportSnapshot();
  const json = buildReportJson({ ...f.params, vault: null });
  assert.deepEqual(json.facts.effective, snapshot.rows.map(row => ({ ...row, payload: JSON.parse(row.payload) })));
  assert.equal(json.ioc[0].evidence_ref, 'fact#1');
  assert.equal(json.ioc[0].kind, 'session');
  assert.ok(buildReport({ ...f.params, vault: null }).markdown.includes(SECRET));
});

function dump(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
}

test('all audience exports preserve the full-row digest, watermark and read-only databases', t => {
  const f = fixture(t);
  seedFact(f, { entityType: 'asset' });
  seedFact(f, { active: false, entityType: 'asset' });
  seedRoute(f);
  const before = [dump(f.db), dump(f.globalDb)];
  const snapshot = f.store.exportSnapshot();
  const digest = createHash('sha256').update(JSON.stringify(snapshot.rows)).digest('hex');
  const changes = [f.db.prepare('SELECT total_changes() AS n').get().n, f.globalDb.prepare('SELECT total_changes() AS n').get().n];
  f.db.exec('PRAGMA query_only = ON');
  f.globalDb.exec('PRAGMA query_only = ON');
  for (const audience of ['full', 'client', 'blue']) {
    const outDir = mkdtempSync(join(tmpdir(), 'report-synthetic-'));
    const exported = exportReport({ ...f.params, audience, outDir, format: 'all' });
    const json = JSON.parse(readFileSync(exported.paths.json, 'utf8'));
    assert.deepEqual(json.watermark, { seq: snapshot.seq, snapshot_id: snapshot.snapshot_id, exported_at: snapshot.exported_at });
    assert.equal(json.evidence_digests.fact_members, digest);
    assert.equal(json.facts.effective.length, 1);
    assert.equal(json.facts.quarantined.length, 1);
    assert.equal(exported.self_check.reproducible, true);
    for (const file of Object.values(exported.paths)) {
      const text = readFileSync(file, 'utf8');
      assert.equal(text.includes(SECRET), false);
      assert.ok(text.includes(digest));
    }
  }
  assert.deepEqual([dump(f.db), dump(f.globalDb)], before);
  assert.deepEqual(f.store.exportSnapshot(), snapshot);
  assert.deepEqual([f.db.prepare('SELECT total_changes() AS n').get().n, f.globalDb.prepare('SELECT total_changes() AS n').get().n], changes);
});
