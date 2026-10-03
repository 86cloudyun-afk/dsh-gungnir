// Historical corruption fixtures only: no service, real worker or real ledger mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { HostTaskRunner } from '../packages/warroom-plugin/src/host-tasks.js';

function fixture(t) {
  const h = harness(); h.adapter.observe = () => null;
  t.after(() => {
    for (const { db } of h.broker.engagements.values()) db.close();
    h.broker.knowledge.db.close(); h.broker.global.close();
    rmSync(h.home, { recursive: true, force: true });
  });
  const parent = { session_id: 'inert-identity-parent', created_at: 1000 };
  const queue = (command_id, task_id) => h.broker.execute({ ...h.base, command_id, task_id,
    contract: h.contract({ wire_cost: 0 }) }, { deferDispatch: true, parent });
  const calls = [];
  h.broker.adapter.lookup = id => { calls.push(['lookup', id]); return { task_id: id }; };
  h.broker.adapter.cancel = id => { calls.push(['cancel', id]); };
  h.broker.adapter.manifestOf = id => {
    calls.push(['manifest', id]);
    return [{ id: `${id}-inert-resource`, kind: 'session', check: () => { calls.push(['check', id]); return true; } }];
  };
  const runner = new HostTaskRunner({ broker: h.broker, delivery: {
    deliver: async (_owner, notice) => { calls.push(['deliver', notice.command_id]); return { status: 'blocked' }; },
  } });
  return { h, queue, calls, runner };
}
function ledger(h) {
  return {
    global: Object.fromEntries(['command_queue', 'task_owners', 'task_cancellations', 'task_resources', 'task_notifications', 'approvals']
      .map(table => [table, h.broker.global.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    gates: h.store().db.prepare('SELECT * FROM gate_log ORDER BY id').all(),
    rates: h.store().db.prepare('SELECT * FROM rate_ledger ORDER BY id').all(),
    facts: h.store().db.prepare('SELECT * FROM fact_members ORDER BY id').all(),
  };
}
function requestStop(h, attempted) {
  h.broker.global.prepare("UPDATE command_queue SET state = 'cancel_requested'").run();
  h.broker.global.prepare('UPDATE task_owners SET cancel_requested = 1, dispatch_attempted = ?').run(Number(attempted));
  h.broker.global.prepare(`INSERT INTO task_cancellations (command_id, generation, request_id)
    SELECT command_id, generation, command_id || '-inert-stop' FROM command_queue`).run();
}
for (const attempted of [false, true]) for (const kind of ['duplicate-task', 'task-as-command', 'command-as-task']) {
  test(`host pending cancellation rejects historical ${kind} with dispatch_attempted=${attempted} before stop or terminal notice`, async t => {
    const { h, queue, calls, runner } = fixture(t);
    queue('identity-first', 'identity-task'); queue('identity-second', 'identity-other-task');
    // Only this temporary fixture is rewritten to represent legacy ambiguous storage.
    if (kind === 'duplicate-task') h.broker.global.prepare("UPDATE command_queue SET task_id = 'identity-task' WHERE command_id = 'identity-second'").run();
    if (kind === 'task-as-command') h.broker.global.prepare("UPDATE command_queue SET task_id = 'identity-first' WHERE command_id = 'identity-second'").run();
    if (kind === 'command-as-task') h.broker.global.prepare("UPDATE command_queue SET task_id = 'identity-second' WHERE command_id = 'identity-first'").run();
    requestStop(h, attempted);
    const before = ledger(h);
    await runner.tick();
    assert.deepEqual(calls, [], 'ambiguous identity must not touch any adapter or deliver a notice');
    assert.deepEqual(ledger(h), before, 'pending rows and non-diagnostic ledgers remain unchanged');
    const diagnostics = h.broker.global.prepare('SELECT kind, state, detail FROM op_log ORDER BY rowid').all();
    assert.equal(diagnostics.length, 2);
    for (const diagnostic of diagnostics) assert.deepEqual({ ...diagnostic }, {
      kind: 'host_task_error', state: 'unresolved', detail: 'E_APPROVAL_MISMATCH',
    });
  });
}
for (const attempted of [false, true]) test(`host unique pending cancellation retains dispatch_attempted=${attempted} stop behavior`, async t => {
  const { h, queue, calls, runner } = fixture(t);
  queue('identity-first', 'identity-task'); requestStop(h, attempted);
  await runner.tick();
  assert.equal(h.broker._findCommand('identity-first').state, attempted ? 'confirmed_stopped' : 'cancelled');
  assert.equal(calls.filter(([method]) => method === 'cancel').length, attempted ? 1 : 0);
  if (attempted) {
    assert.ok(calls.some(([method]) => method === 'check'));
    assert.ok(h.broker.global.prepare('SELECT * FROM task_resources').all().length > 0);
  }
});
