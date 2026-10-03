import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness as baseHarness } from '../packages/warroom-core/src/testing.js';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FileBridgeDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';
import { RedteamModeAdapter } from '../packages/warroom-core/src/adapters/redteam-mode.js';

const parent = { session_id: 'parent-one', created_at: 1000 };
// These admission/auth fixtures expose an inert observation source; built-in Fake remains synchronous only.
function harness(options) {
  const h = baseHarness(options); h.adapter.observe = () => null; return h;
}
const queued = (h, command_id = 'host-one', owner = parent) => h.broker.execute(
  { ...h.base, command_id, contract: h.contract({ wire_cost: 0 }) },
  { deferDispatch: true, parent: owner },
);

test('host registration returns queued while inert worker remains unstarted', () => {
  const h = harness({ faults: { neverFinish: true } });
  const r = queued(h);
  assert.equal(r.state, 'queued');
  assert.equal(h.adapter.tasks.size, 0, 'tool must not own worker execution');
  const owner = h.broker.global.prepare('SELECT * FROM task_owners WHERE command_id = ?').get('host-one');
  assert.equal(owner.parent_session_id, parent.session_id);
  assert.equal(owner.parent_created_at, parent.created_at);
  h.broker.dispatchQueued('host-one');
  assert.equal(h.adapter.tasks.size, 1);
  assert.equal(h.broker._findCommand(r.task_id).state, 'running');
});

test('host registration requires stable parent identity before any task is registered', () => {
  const h = harness();
  assert.throws(() => queued(h, 'no-parent', { session_id: parent.session_id }), /parent/i);
  assert.equal(h.broker.global.prepare('SELECT count(*) n FROM command_queue').get().n, 0);
  assert.equal(h.adapter.tasks.size, 0);
});

test('idempotent dispatch at the concurrency cap returns same task without reserving twice', () => {
  const h = harness();
  const r = queued(h);
  queued(h, 'host-two');
  const same = queued(h);
  assert.equal(same.task_id, r.task_id);
  assert.equal(same.deduped, true);
  assert.equal(h.store().db.prepare("SELECT sum(amount) n FROM rate_ledger WHERE kind = 'tool'").get().n, 2);
});

test('command identity cannot rebind a task to a different parent session', () => {
  const h = harness();
  queued(h);
  assert.throws(() => queued(h, 'host-one', { session_id: 'other', created_at: 1000 }), /parent/i);
  assert.equal(h.adapter.tasks.size, 0);
});

test('host dispatch rechecks revoked authorization and never starts queued task', () => {
  const h = harness();
  queued(h);
  h.broker._eng(h.eng.engagement_id).db.prepare('UPDATE engagements SET auth_version = 2').run();
  h.broker.dispatchQueued('host-one');
  assert.equal(h.adapter.tasks.size, 0);
  assert.equal(h.broker._findCommand('host-one').state, 'cancel_requested');
});

test('attempted dispatch after restart is only observed, never dispatched again', () => {
  const h = harness();
  queued(h);
  h.broker.global.prepare("UPDATE task_owners SET dispatch_attempted = 1 WHERE command_id = 'host-one'").run();
  const reopened = new Broker({ home: h.home, adapter: h.adapter });
  reopened.dispatchQueued('host-one');
  assert.equal(h.adapter.tasks.size, 0);
  assert.equal(reopened._findCommand('host-one').state, 'unknown');
});

test('host bridge enqueues immediately without Atomics.wait or invoking onJob', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-bridge-'));
  const driver = new FileBridgeDriver({ root, background: true, onJob: () => { throw new Error('inline worker invoked'); } });
  const wait = Atomics.wait;
  Atomics.wait = () => { throw new Error('blocking wait invoked'); };
  try {
    assert.deepEqual(driver.spawnRole('assess', { task_id: 'inert', generation: '1:1:1' }),
      { external_id: 'inert', state: 'queued' });
  } finally { Atomics.wait = wait; }
  assert.equal(driver.pendingJobs().length, 1);
});

test('bridge recovery attaches existing task without overwriting or spawning a job', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-attach-'));
  const driver = new FileBridgeDriver({ root, background: true });
  const contract = { task_id: 'inert', generation: '1:1:1' };
  writeFileSync(driver._jobPath('inert'), JSON.stringify({ external_id: 'inert', role: 'assess', contract }));
  driver.spawnRole = () => { throw new Error('recovery spawned'); };
  const adapter = new RedteamModeAdapter({ driver });
  const r = adapter.hydrate('host-one', contract, 'running');
  assert.equal(r.task_id, 'inert');
  assert.equal(adapter.lookup('host-one').task_id, 'inert');
});

test('bridge receipt keeps source generation rather than fabricating current adapter generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-source-'));
  const driver = new FileBridgeDriver({ root, timeoutMs: 1 });
  driver.onJob = (job) => {
    writeFileSync(driver._statusPath(job.external_id), JSON.stringify({ external_id: job.external_id, state: 'running', generation: '1:0:1' }));
    writeFileSync(driver._factsPath(job.external_id), JSON.stringify({ external_id: job.external_id, generation: '1:0:1', members: [] }));
  };
  const adapter = new RedteamModeAdapter({ driver });
  adapter.dispatch('host-one', { task_id: 'inert', generation: '1:1:1' });
  assert.equal(adapter.status('inert').generation, '1:0:1');
  assert.equal(adapter.collect('inert').generation, '1:0:1');
  writeFileSync(driver._factsPath('inert'), JSON.stringify({ external_id: 'inert', members: [] }));
  assert.equal(adapter.collect('inert').generation, undefined);
});

test('failed rate reservation cannot leave a dispatchable host task', () => {
  const h = harness();
  h.store().recordRate = () => { throw new Error('reservation lost'); };
  assert.throws(() => queued(h), /reservation lost/);
  h.broker.dispatchQueued('host-one');
  assert.equal(h.adapter.tasks.size, 0);
});

test('approval expiring between registration and host dispatch prevents execution', () => {
  const h = harness();
  const { approval_id } = h.broker.createApproval({ engagement_id: h.eng.engagement_id, ttlSeconds: 1 });
  h.broker.execute({ ...h.base, command_id: 'approved', manual_approval_token: approval_id,
    contract: h.contract({ action_class: 'destructive', wire_cost: 0 }) }, { deferDispatch: true, parent });
  h.broker._nowMs = () => Date.now() + 2000;
  h.broker.dispatchQueued('approved');
  assert.equal(h.adapter.tasks.size, 0);
});

test('retry of incomplete registration cannot acknowledge an unreserved task as queued', () => {
  const h = harness(); const record = h.store().recordRate;
  h.store().recordRate = () => { throw new Error('reservation lost'); };
  assert.throws(() => queued(h), /reservation lost/); h.store().recordRate = record;
  assert.throws(() => queued(h), { code: 'E_REGISTRATION_INCOMPLETE' });
  assert.equal(h.adapter.tasks.size, 0);
});

for (const invalid of ['expired', 'failed']) test(`first host dispatch rechecks ${invalid} egress verification without reserving twice`, () => {
  const h = harness(); h.broker.config.requireEgressCheck = true; h.broker.config.egressMaxAgeMin = 30;
  h.broker.recordEgressCheck(h.eng.engagement_id, { jumphost_id: 'inert', exit_ip: '203.0.113.5' });
  h.broker.execute({ ...h.base, command_id: 'egress-host', contract: h.contract({ wire_cost: 1 }) },
    { deferDispatch: true, parent });
  if (invalid === 'expired') h.broker._nowMs = () => Date.now() + 31 * 60_000;
  else h.store().db.prepare("UPDATE egress_checks SET verdict = 'fail'").run();
  h.broker.dispatchQueued('egress-host');
  assert.equal(h.adapter.tasks.size, 0);
  assert.equal(h.store().rateTotal('wire'), 1);
});

test('tick grants dispatch grace before unknown and logs dispatch_unknown gate', async () => {
  const h = harness();
  const r = queued(h);
  // background 适配器：派发被接受但仍是 queued（等首次 observe 上报 running）
  h.broker.adapter = {
    dispatch: () => ({ task_id: r.task_id, state: 'queued' }),
    observe: () => null,
    lookup: () => null,
    hydrate: () => null,
    cancel: () => {},
    manifestOf: () => [],
  };
  const { HostTaskRunner } = await import('../packages/warroom-plugin/src/host-tasks.js');
  const runner = new HostTaskRunner({ broker: h.broker, delivery: { deliver: async () => ({ status: 'blocked' }) } });
  const state = () => h.broker._findCommand(r.task_id).state;
  const gates = () => h.store().db.prepare("SELECT * FROM gate_log WHERE decision = 'dispatch_unknown'").all();
  await runner.tick(); // 派发：dispatch_attempted=1，仍是 queued
  assert.equal(state(), 'queued');
  for (let i = 0; i < 4; i++) { await runner.tick(); assert.equal(state(), 'queued', `grace tick ${i + 1} 不得误标 unknown`); }
  assert.equal(gates().length, 0, '宽限期内不得打 dispatch_unknown');
  await runner.tick(); // 宽限耗尽
  assert.equal(state(), 'unknown');
  assert.equal(gates().length, 1, '标 unknown 时必须打 dispatch_unknown 门闸日志');
  assert.match(gates()[0].detail, /no adapter progress within grace period/);
});

test('adapter reporting running during grace clears the unknown countdown', async () => {
  const h = harness();
  const r = queued(h);
  h.broker.adapter = {
    dispatch: () => ({ task_id: r.task_id, state: 'queued' }),
    observe: () => null,
    lookup: () => ({ task_id: r.task_id }),
    hydrate: () => null,
    cancel: () => {},
    manifestOf: () => [],
  };
  const { HostTaskRunner } = await import('../packages/warroom-plugin/src/host-tasks.js');
  const runner = new HostTaskRunner({ broker: h.broker, delivery: { deliver: async () => ({ status: 'blocked' }) } });
  await runner.tick();
  await runner.tick();
  // 宽限期内适配器上报 running：直接恢复，不经过 unknown
  h.broker._setCommandState(r.command_id, 'running');
  await runner.tick(); await runner.tick(); await runner.tick(); await runner.tick();
  assert.equal(h.broker._findCommand(r.task_id).state, 'running');
  assert.equal(h.store().db.prepare("SELECT count(*) n FROM gate_log WHERE decision = 'dispatch_unknown'").get().n, 0);
});
