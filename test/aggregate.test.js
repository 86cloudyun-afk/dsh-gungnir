// 聚合边界：只读打开、写入必须失败、合并视图不具副作用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { harness } from '../packages/warroom-core/src/testing.js';
import { openSessionsDb, readSessionAggregate, aggregateView } from '../packages/warroom-core/src/aggregate.js';

function fakeSessionsDb() {
  const dir = mkdtempSync(join(tmpdir(), 'wr-sess-'));
  const path = join(dir, 'pentest-sessions.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE facts (id INTEGER PRIMARY KEY, note TEXT);
    CREATE TABLE findings (id INTEGER PRIMARY KEY, note TEXT);
    CREATE TABLE assets (id INTEGER PRIMARY KEY, note TEXT);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, note TEXT);
    INSERT INTO facts (note) VALUES ('f1'), ('f2');
    INSERT INTO findings (note) VALUES ('n1');
  `);
  db.close();
  return path;
}

test('聚合库只读打开：写入必须失败（边界不可破）', () => {
  const path = fakeSessionsDb();
  const db = openSessionsDb(path);
  const agg = readSessionAggregate(db);
  assert.equal(agg.available, true);
  assert.equal(agg.facts, 2);
  assert.equal(agg.findings, 1);
  assert.throws(() => db.exec("INSERT INTO facts (note) VALUES ('illegal')"), /readonly|read-only|attempt to write/i);
  db.close();
});

test('聚合视图：合并各战役事实与 DSH 聚合库；标明只读边界', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'agg-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.store().recordShellProof({ proof: 'shell-agg', validity: 'valid', evidence_ref: 'ev-1' });

  const view = aggregateView({ home: h.home, sessionsDbPath: fakeSessionsDb() });
  assert.equal(view.schema, 'gungnir-aggregate/1');
  assert.equal(view.totals.engagements, 1);
  assert.equal(view.totals.facts, 1);
  assert.equal(view.totals.shells, 1);
  assert.equal(view.engagements[0].engagement_id, h.eng.engagement_id);
  assert.equal(view.dsh_sessions.facts, 2);
  assert.match(view.boundary, /只读/);
});

test('本框架各战役库也只读打开：聚合过程不产生任何写入', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'agg-2', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const before = h.store().seq();

  aggregateView({ home: h.home });
  aggregateView({ home: h.home });

  const reopened = new DatabaseSync(join(h.home, 'engagements', h.eng.engagement_id, 'fact.db'), { readOnly: true });
  const after = reopened.prepare('SELECT v FROM meta WHERE k = ?').get('seq')?.v ?? reopened.prepare('SELECT COUNT(*) AS n FROM fact_members').get().n;
  reopened.close();
  assert.ok(after !== undefined);
  assert.equal(h.store().seq(), before, '聚合不得改动本框架水位');
});

test('聚合库不存在时不报错（返回 available=false）', () => {
  const h = harness();
  const view = aggregateView({ home: h.home, sessionsDbPath: join(h.home, 'nope.db') });
  assert.equal(view.dsh_sessions.available, false);
  assert.equal(openSessionsDb(null), null);
});
