import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { harness as makeHarness } from '../packages/warroom-core/src/testing.js';

function fixture(t) {
  const h = makeHarness();
  h.adapter.observe = () => null;
  t.after(() => {
    for (const { db } of h.broker.engagements.values()) db.close();
    h.broker.global.close();
    rmSync(h.home, { recursive: true, force: true });
  });
  return h;
}
const parent = { session_id: 'inert-parent', created_at: 1000 };
function execute(h, command_id, task_id, deferred = false, auth = h.base) {
  return h.broker.execute({ ...auth, command_id, task_id, contract: h.contract({ wire_cost: 0 }) },
    deferred ? { deferDispatch: true, parent } : {});
}
function ledger(h) {
  return {
    commands: h.broker.global.prepare('SELECT * FROM command_queue ORDER BY command_id').all(),
    owners: h.broker.global.prepare('SELECT * FROM task_owners ORDER BY command_id').all(),
    approvals: h.broker.global.prepare('SELECT * FROM approvals ORDER BY approval_id').all(),
    engagements: [...h.broker.engagements.entries()].map(([id, { db }]) => ({ id,
      gates: db.prepare('SELECT * FROM gate_log ORDER BY id').all(),
      rates: db.prepare('SELECT * FROM rate_ledger ORDER BY id').all(),
      facts: db.prepare('SELECT * FROM fact_members ORDER BY id').all(),
    })),
    dispatchCounter: h.broker.dispatchCounter,
    adapterTasks: h.adapter.tasks.size,
  };
}

for (const deferred of [false, true]) for (const otherEngagement of [false, true]) {
  test(`${deferred ? 'deferred' : 'sync'} rejects duplicate task identity in ${otherEngagement ? 'another' : 'same'} engagement without side effects`, (t) => {
    const h = fixture(t);
    execute(h, 'first-command', 'shared-task', deferred);
    const auth = otherEngagement ? h.broker.createEngagement({ user_message_id: 'inert-other', targets: ['10.0.0.0/24'] }) : h.base;
    const before = ledger(h);
    assert.throws(() => execute(h, 'second-command', 'shared-task', deferred, auth), { code: 'E_APPROVAL_MISMATCH' });
    assert.deepEqual(ledger(h), before);
  });
}
for (const deferred of [false, true]) for (const alias of ['task-as-command', 'command-as-task']) {
  test(`${deferred ? 'deferred' : 'sync'} rejects ${alias} alias before reservation or dispatch`, (t) => {
    const h = fixture(t);
    execute(h, 'first-command', 'first-task', deferred);
    const before = ledger(h);
    assert.throws(() => execute(h, alias === 'task-as-command' ? 'first-task' : 'second-command',
      alias === 'command-as-task' ? 'first-command' : 'second-task', deferred), { code: 'E_APPROVAL_MISMATCH' });
    assert.deepEqual(ledger(h), before);
  });
}
test('deduplication cannot acknowledge an explicitly changed task identity', (t) => {
  const h = fixture(t);
  execute(h, 'same-command', 'original-task');
  const before = ledger(h);
  assert.throws(() => execute(h, 'same-command', 'different-task'), { code: 'E_APPROVAL_MISMATCH' });
  assert.deepEqual(ledger(h), before);
});
test('distinct task identities and an unchanged idempotent command retain their own results', (t) => {
  const h = fixture(t);
  const first = execute(h, 'first-command', 'first-task');
  const second = execute(h, 'second-command', 'second-task');
  const before = ledger(h);
  const same = execute(h, 'first-command', 'first-task');
  assert.equal(same.deduped, true);
  assert.equal(same.task_id, first.task_id);
  assert.deepEqual(ledger(h), before);
  assert.equal(h.broker.status(h.eng.engagement_id, first.task_id).command_id, 'first-command');
  assert.equal(h.broker.status(h.eng.engagement_id, second.task_id).command_id, 'second-command');
});
for (const lookup of ['shared-task', 'first-command', 'second-command']) {
  test(`historical duplicate task identity rejects ${lookup} lookup and preserves all rows`, (t) => {
    const h = fixture(t);
    execute(h, 'first-command', 'shared-task');
    execute(h, 'second-command', 'other-task');
    // Legacy corruption fixture only: no migration or real ledger modification.
    h.broker.global.prepare("UPDATE command_queue SET task_id = 'shared-task' WHERE command_id = 'second-command'").run();
    const before = ledger(h);
    assert.throws(() => h.broker.status(h.eng.engagement_id, lookup), { code: 'E_APPROVAL_MISMATCH' });
    assert.deepEqual(ledger(h), before);
  });
}
test('historical command/task alias rejects cancellation before adapter or audit changes', (t) => {
  const h = fixture(t);
  execute(h, 'first-command', 'first-task');
  execute(h, 'second-command', 'second-task');
  h.broker.global.prepare("UPDATE command_queue SET task_id = 'first-command' WHERE command_id = 'second-command'").run();
  const before = ledger(h);
  assert.throws(() => h.broker.cancel(h.eng.engagement_id, 'first-command'), { code: 'E_APPROVAL_MISMATCH' });
  assert.deepEqual(ledger(h), before);
  assert.equal(h.adapter.status('first-task').state, 'running');
  assert.equal(h.adapter.status('second-task').state, 'running');
});
