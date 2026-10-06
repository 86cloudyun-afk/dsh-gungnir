// Fixed clock, in-memory synthetic vault/SQLite; only pure artifact construction/parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactMember, parseEvidence } from '../executors/tool-runner.mjs';
import { FACT_DDL, GLOBAL_DDL } from '../packages/warroom-core/src/db.js';
import { FactStore } from '../packages/warroom-core/src/store.js';
import { buildReportJson, exportReport } from '../packages/warroom-core/src/report.js';
import { redact } from '../packages/warroom-core/src/redactor.js';

const SUPPORTED = ['asset', 'domain', 'vuln', 'credential', 'session', 'chain', 'shell', 'persistence', 'artifact'];
const CONTENT = 'SyntheticArtifactContent2026';
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const dump = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
function fixture(t, values = [{ value: 'artifact', label: 'type' }, { value: CONTENT, label: 'content' }]) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-02-17T12:00:00.000Z') });
  const db = new DatabaseSync(':memory:'); db.exec(FACT_DDL);
  const globalDb = new DatabaseSync(':memory:'); globalDb.exec(GLOBAL_DDL);
  const store = new FactStore(db, 'synthetic-artifact');
  t.after(() => { db.close(); globalDb.close(); });
  const vault = { values: () => values, redact: text => redact(text, values) };
  return { db, globalDb, store, args: { store, globalDb, engagementId: 'synthetic-artifact', vault } };
}
function seed(f, active) {
  const members = [{ entity_type: 'artifact', source_id: `source-${CONTENT}`, revision_no: 1,
    content_hash: `hash-${CONTENT}`, payload: { note: 'artifact', nested: [CONTENT], artifact: `/synthetic/artifact/${CONTENT}` } }];
  const input = { adapterInstance: `adapter-${CONTENT}`, generation: `generation-${CONTENT}`, members };
  if (active) f.store.ingestMembers(input); else f.store.quarantineStaleGeneration(input);
  f.db.prepare('UPDATE fact_members SET flags=?').run(`flag-${CONTENT}`);
}
for (const active of [true, false]) {
  for (const audience of ['full', 'client', 'blue']) {
    test(`${audience} ${active ? 'active' : 'quarantined'} artifact preserves its enum and scrubs free metadata/content in all formats`, t => {
      const f = fixture(t); seed(f, active);
      const snapshot = f.store.exportSnapshot();
      const sqlBefore = [dump(f.db), dump(f.globalDb)];
      const changes = [f.db, f.globalDb].map(db => db.prepare('SELECT total_changes() n').get().n);
      f.db.exec('PRAGMA query_only=ON'); f.globalDb.exec('PRAGMA query_only=ON');
      const out = exportReport({ ...f.args, audience, format: 'all', outDir: mkdtempSync(join(tmpdir(), 'artifact-report-')) });
      const text = Object.fromEntries(Object.entries(out.paths).map(([format, file]) => [format, readFileSync(file, 'utf8')]));
      const json = JSON.parse(text.json);
      const rows = json.facts[active ? 'effective' : 'quarantined'];
      assert.equal(rows[0].entity_type, 'artifact');
      assert.equal(rows[0].payload.note, '[REDACTED:type]');
      assert.equal(rows[0].payload.artifact, '/synthetic/[REDACTED:type]/[REDACTED:content]');
      for (const field of ['source_id', 'adapter_instance', 'generation', 'content_hash', 'flags']) assert.ok(rows[0][field].includes('[REDACTED:content]'));
      assert.equal(rows[0].active, active ? 1 : 0);
      assert.ok(text.markdown.includes(active ? '### artifact（1）' : '- artifact/'));
      for (const content of Object.values(text)) assert.equal(content.includes(CONTENT), false);
      assert.equal(json.evidence_digests.fact_members, digest(snapshot.rows));
      assert.deepEqual(json.watermark, { seq: snapshot.seq, snapshot_id: snapshot.snapshot_id, exported_at: snapshot.exported_at });
      assert.deepEqual([dump(f.db), dump(f.globalDb)], sqlBefore);
      assert.deepEqual(f.store.exportSnapshot(), snapshot);
      assert.deepEqual([f.db, f.globalDb].map(db => db.prepare('SELECT total_changes() n').get().n), changes);
      assert.equal(out.self_check.reproducible, true);
    });
  }
}
test('the complete supported set preserves only entity_type while identically named payload text is scrubbed', t => {
  const f = fixture(t, SUPPORTED.map(value => ({ value, label: 'enum' })));
  f.store.ingestMembers({ adapterInstance: 'public', generation: 'public', members: SUPPORTED.map((entity_type, i) => ({
    entity_type, source_id: `public-${i}`, revision_no: 1, content_hash: `public-${i}`, payload: { note: entity_type },
  })) });
  const json = buildReportJson(f.args);
  assert.deepEqual(json.facts.effective.map(row => row.entity_type), SUPPORTED);
  assert.ok(json.facts.effective.every(row => row.payload.note === '[REDACTED:enum]'));
});
test('pure executor artifact constructor/evidence parser output remains a supported report type', t => {
  const f = fixture(t);
  const artifact = artifactMember({ id: 'fixture', action: 'exec', cmd: 'synthetic fixture only', exit: 0, stdout: CONTENT, stderr: '', artifactDir: '/synthetic/artifact' });
  const parsed = parseEvidence('GUNGNIR_MEMBER synthetic-nonce: {"entity_type":"artifact","source_id":"public-parser","payload":{"note":"artifact"}}', { nonce: 'synthetic-nonce' });
  assert.equal(parsed.length, 1);
  f.store.ingestMembers({ adapterInstance: 'public', generation: 'public', members: [artifact, ...parsed] });
  assert.deepEqual(buildReportJson(f.args).facts.effective.map(row => row.entity_type), ['artifact', 'artifact']);
});
test('unknown custom types remain redacted and no-vault keeps the raw fact shape', t => {
  const f = fixture(t); seed(f, true);
  const snapshot = f.store.exportSnapshot();
  const raw = buildReportJson({ ...f.args, vault: null });
  assert.deepEqual(raw.facts.effective, snapshot.rows.map(row => ({ ...row, payload: JSON.parse(row.payload) })));
  snapshot.rows[0].entity_type = `custom-artifact-${CONTENT}`;
  snapshot.rows[0].extension = { type_hint: 'artifact', future: [CONTENT] };
  const before = JSON.stringify(snapshot);
  const store = { db: f.db, shellState: () => f.store.shellState(), exportSnapshot: () => snapshot };
  const row = buildReportJson({ ...f.args, store }).facts.effective[0];
  assert.equal(row.entity_type, 'custom-[REDACTED:type]-[REDACTED:content]');
  assert.deepEqual(row.extension, { type_hint: '[REDACTED:type]', future: ['[REDACTED:content]'] });
  assert.equal(JSON.stringify(snapshot), before);
});
