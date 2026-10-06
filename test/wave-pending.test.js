// Synthetic FakeAdapter only; fixed virtual Date, fresh temporary broker databases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';
import { runWave } from '../packages/warroom-core/src/wave.js';

function fixture(t, faults = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-02-17T12:00:00.000Z') });
  const h = harness({ faults });
  const store = h.store();
  t.after(() => { store.db.close(); h.broker.global.close(); });
  const run = tasks => runWave({ broker: h.broker, engagementId: h.eng.engagement_id,
    wave: { title: 'Synthetic pending wave', notes: 'Offline fixture', tasks } });
  const queue = () => h.broker.global.prepare('SELECT * FROM command_queue ORDER BY rowid').all();
  return { ...h, run, queue };
}
const tasks = () => [
  { id: 'A', role: 'recon', targets: ['10.0.0.5'] },
  { id: 'B', role: 'chain', targets: ['10.0.0.5'], depends_on: ['A'] },
];

test('delayed receipt returns pending and blocks its dependent without busy polling', t => {
  const h = fixture(t);
  const readyAt = Date.now() + 500;
  const collect = h.adapter.collect.bind(h.adapter);
  let polls = 0;
  h.adapter.collect = task => { polls++; if (Date.now() < readyAt) throw new Error('synthetic receipt pending'); return collect(task); };
  const result = h.run(tasks());
  assert.equal(result.pending, true);
  assert.deepEqual(result.order, ['A']);
  assert.deepEqual(result.blocked, ['B']);
  assert.deepEqual(result.unsettled, ['A']);
  assert.ok(polls <= 4, 'return at no progress, rather than poll until an iteration budget expires');
  assert.equal(h.queue().length, 1);
  assert.equal(h.store().effectiveCount(), 0);
});

test('late valid receipt can finish the original task after pending without redispatch', t => {
  const h = fixture(t);
  const readyAt = Date.now() + 500;
  const collect = h.adapter.collect.bind(h.adapter);
  h.adapter.collect = task => { if (Date.now() < readyAt) throw new Error('synthetic pending'); return collect(task); };
  const result = h.run(tasks());
  const original = h.queue()[0];
  t.mock.timers.tick(500);
  const receipt = h.adapter.collect(result.tasks[0].task_id);
  assert.equal(h.broker.collect(h.eng.engagement_id, original.task_id, receipt).accepted, true);
  assert.equal(h.broker.settle(h.eng.engagement_id, original.task_id).settled, true);
  assert.equal(h.queue()[0].command_id, original.command_id);
  assert.equal(h.queue()[0].generation, original.generation);
  assert.equal(h.queue()[0].state, 'done');
  assert.equal(h.queue().length, 1, 'pending never dispatches or resubmits blocked tasks');
  assert.equal(h.adapter.counter, 1);
  assert.equal(h.store().effectiveCount(), 1);
});

test('a receipt ready on the next pass still completes dependencies in settle order', t => {
  const h = fixture(t);
  const collect = h.adapter.collect.bind(h.adapter);
  let polls = 0;
  h.adapter.collect = task => { if (++polls === 1) throw new Error('synthetic short delay'); return collect(task); };
  const result = h.run(tasks());
  assert.equal(result.pending, false);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unsettled, []);
  assert.deepEqual(result.order, ['A', 'B']);
  assert.ok(result.tasks.every(task => task.settled && task.state === 'done'));
  assert.equal(result.facts_inserted, 2);
});

test('independent work completes while a delayed task leaves only its downstream blocked', t => {
  const h = fixture(t);
  const collect = h.adapter.collect.bind(h.adapter);
  let firstTask = null;
  h.adapter.collect = task => { firstTask ??= task; if (task === firstTask) throw new Error('synthetic A pending'); return collect(task); };
  const [a, b] = tasks();
  const result = h.run([a, { id: 'C', role: 'recon', targets: ['10.0.0.6'] }, b]);
  assert.equal(result.pending, true);
  assert.deepEqual(result.order, ['A', 'C']);
  assert.deepEqual(result.blocked, ['B']);
  assert.deepEqual(result.unsettled, ['A']);
  assert.equal(result.tasks.find(task => task.id === 'C').state, 'done');
  assert.equal(result.facts_inserted, 1);
  assert.equal(h.store().effectiveCount(), 1);
  assert.equal(h.queue().length, 2);
});

test('running terminal delay preserves actual inserts through duplicate receipts and stays pending', t => {
  const h = fixture(t, { neverFinish: true });
  const result = h.run(tasks());
  assert.equal(result.pending, true);
  assert.equal(result.tasks[0].settled, false);
  assert.equal(result.tasks[0].state, 'running');
  assert.equal(result.facts_inserted, 1, 'repeated collect does not erase previous inserted credit');
  assert.equal(h.store().effectiveCount(), 1);
  assert.equal(h.queue()[0].state, 'running');
  assert.deepEqual(result.blocked, ['B']);
});

test('timeout leaves unknown honest and blocks downstream without inventing failure', t => {
  const h = fixture(t);
  let first = true;
  h.adapter.collect = () => {
    if (first) { first = false; t.mock.timers.tick(500); h.broker.sweepTimeouts(h.eng.engagement_id, { timeoutMs: 100 }); }
    throw new Error('synthetic timed-out receipt');
  };
  const result = h.run(tasks());
  assert.equal(result.pending, true);
  assert.deepEqual(result.blocked, ['B']);
  assert.equal(result.tasks[0].state, 'unknown');
  assert.equal(result.tasks[0].settled, false);
  assert.equal(h.queue()[0].state, 'unknown');
  assert.equal(h.store().effectiveCount(), 0);
  assert.equal(h.queue().length, 1);
});

test('revocation during a pending receipt preserves confirmed stop and never dispatches downstream', t => {
  const h = fixture(t);
  let first = true;
  h.adapter.collect = () => {
    if (first) { first = false; h.broker.revoke(h.eng.engagement_id, 'synthetic stop'); }
    throw new Error('synthetic stopped receipt');
  };
  const result = h.run(tasks());
  assert.equal(result.pending, true);
  assert.deepEqual(result.blocked, ['B']);
  assert.equal(result.tasks[0].state, 'confirmed_stopped');
  assert.equal(h.queue()[0].state, 'confirmed_stopped');
  assert.equal(h.queue().length, 1);
  assert.equal(h.adapter.counter, 1);
  assert.equal(h.store().effectiveCount(), 0);
});
