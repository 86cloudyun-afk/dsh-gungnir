// Only synthetic values, in-memory databases, fixed clock; no actual vault or target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GLOBAL_DDL, FACT_DDL } from '../packages/warroom-core/src/db.js';
import { FactStore } from '../packages/warroom-core/src/store.js';
import { buildReportJson } from '../packages/warroom-core/src/report.js';
import { redact } from '../packages/warroom-core/src/redactor.js';

function fixture(t, members, values) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-02T12:00:00.000Z') });
  const db = new DatabaseSync(':memory:'); db.exec(FACT_DDL);
  const g = new DatabaseSync(':memory:'); g.exec(GLOBAL_DDL);
  const store = new FactStore(db, 'synthetic-report-restoration');
  store.ingestMembers({ adapterInstance: 'fixture', generation: 'fixture-1', members: members.map((m, i) => ({ revision_no: 1, content_hash: `fixture-${i}`, ...m })) });
  db.exec('PRAGMA query_only=ON');g.exec('PRAGMA query_only=ON');
  t.after(() => { db.close();g.close(); });
  const vault = { values: () => values, redact: v => redact(v, values) };
  return buildReportJson({ store, globalDb: g, engagementId: 'synthetic-report-restoration', vault });
}

test('synthetic dynamic key must be scrubbed from exported JSON', t => {
  const value = 'SyntheticKeyOnly2026';
  const report = fixture(t, [{ entity_type: 'vuln', source_id: 'fixture-vuln', payload: { observed_headers: { [value]: 'public-value' } } }], [{ label: 'fixture', value }]);
  assert.equal(JSON.stringify(report).includes(value), false);
});

test('redacted topology keeps unique local IDs and original join endpoints', t => {
  const a='host-Synthetic-A-2026',b='host-Synthetic-B-2026';
  const report=fixture(t,[
    {entity_type:'asset',source_id:a,payload:{}},
    {entity_type:'asset',source_id:b,payload:{}},
    {entity_type:'chain',source_id:'fixture-chain',payload:{steps:[{from:a,to:b,via:'fixture-step'}]}},
  ],[{label:'shared',value:'Synthetic-A-2026'},{label:'shared',value:'Synthetic-B-2026'}]);
  assert.equal(new Set(report.topology.nodes.map(n=>n.id)).size,report.topology.nodes.length);
  assert.equal(report.topology.edges.length,1);
  assert.notEqual(report.topology.edges[0].from,report.topology.edges[0].to);
});
