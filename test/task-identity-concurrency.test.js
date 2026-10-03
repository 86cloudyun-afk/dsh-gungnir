// Deterministic two-Broker interleavings; inert adapters and temporary ledgers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

const parent = { session_id: 'inert-review-parent', created_at: 1000 };
function fixture(t, deferred) {
  const h = harness();
  h.adapter.observe = () => null;
  const peerAdapter = new FakeAdapter(); peerAdapter.observe = () => null;
  const peer = new Broker({ home: h.home, adapter: peerAdapter });
  const opts = deferred ? { deferDispatch: true, parent } : {};
  const req = (command_id, task_id, extras = {}) => ({ ...h.base, command_id, task_id,
    contract: h.contract({ wire_cost: 0 }), ...extras });
  t.after(() => {
    for (const b of [peer, h.broker]) {
      for (const { db } of b.engagements.values()) db.close();
      b.knowledge.db.close(); b.global.close();
    }
    rmSync(h.home, { recursive: true, force: true });
  });
  return { h, peer, peerAdapter, opts, req };
}
function snapshot(h, peerAdapter) {
  return {
    commands: h.broker.global.prepare('SELECT * FROM command_queue ORDER BY command_id').all(),
    owners: h.broker.global.prepare('SELECT * FROM task_owners ORDER BY command_id').all(),
    approvals: h.broker.global.prepare('SELECT * FROM approvals ORDER BY approval_id').all(),
    rates: h.store().db.prepare('SELECT * FROM rate_ledger ORDER BY id').all(),
    gates: h.store().db.prepare('SELECT * FROM gate_log ORDER BY id').all(),
    firstTasks: h.adapter.tasks.size, peerTasks: peerAdapter.tasks.size,
    firstDispatchCounter: h.broker.dispatchCounter,
  };
}
// Deterministically inject the peer's complete registration after A's unlocked
// reads and immediately before A takes its writer lock: A:READ -> B:COMMIT -> A:BEGIN.
function beforeWriteLock(broker, action) {
  const exec = broker.global.exec.bind(broker.global); let injected = false;
  broker.global.exec = function(sql) {
    if (!injected && sql === 'BEGIN IMMEDIATE') { injected = true; action(); }
    return exec(sql);
  };
  return () => injected;
}

for (const deferred of [false, true]) for (const kind of ['duplicate-task', 'task-as-command', 'command-as-task']) {
  test(`independent interleaving ${deferred ? 'deferred' : 'sync'} ${kind} rejects before mutation`, (t) => {
    const c = fixture(t, deferred);
    const first = c.req('review-first', 'review-task');
    const second = c.req(kind === 'command-as-task' ? 'review-task' : 'review-peer',
      kind === 'duplicate-task' ? 'review-task' : kind === 'task-as-command' ? 'review-first' : 'review-peer-task');
    let before;
    const injected = beforeWriteLock(c.h.broker, () => {
      c.peer.execute(second, c.opts); before = snapshot(c.h, c.peerAdapter);
    });
    assert.throws(() => c.h.broker.execute(first, c.opts), { code: 'E_APPROVAL_MISMATCH' });
    assert.equal(injected(), true);
    assert.deepEqual(snapshot(c.h, c.peerAdapter), before);
  });
}
for (const deferred of [false, true]) test(`independent interleaving ${deferred ? 'deferred' : 'sync'} identical command/task stays idempotent`, (t) => {
  const c = fixture(t, deferred); const request = c.req('review-identical', 'review-task');
  let before, accepted;
  const injected = beforeWriteLock(c.h.broker, () => {
    accepted = c.peer.execute(request, c.opts); before = snapshot(c.h, c.peerAdapter);
  });
  const retry = c.h.broker.execute(request, c.opts);
  assert.equal(injected(), true); assert.equal(retry.deduped, true);
  assert.equal(retry.task_id, accepted.task_id); assert.equal(retry.generation, accepted.generation);
  assert.deepEqual(snapshot(c.h, c.peerAdapter), before);
});
for (const deferred of [false, true]) test(`independent interleaving ${deferred ? 'deferred' : 'sync'} identical retry at concurrency cap stays idempotent`, (t) => {
  const c = fixture(t, deferred);
  c.h.broker.execute(c.req('review-existing', 'review-existing-task'), c.opts);
  const request = c.req('review-identical', 'review-task');
  let before, accepted;
  const injected = beforeWriteLock(c.h.broker, () => {
    accepted = c.peer.execute(request, c.opts); before = snapshot(c.h, c.peerAdapter);
  });
  const retry = c.h.broker.execute(request, c.opts);
  assert.equal(injected(), true); assert.equal(retry.deduped, true);
  assert.equal(retry.task_id, accepted.task_id); assert.equal(retry.generation, accepted.generation);
  assert.deepEqual(snapshot(c.h, c.peerAdapter), before);
});
for (const deferred of [false, true]) for (const kind of ['duplicate-task', 'task-as-command', 'command-as-task']) {
  test(`independent interleaving ${deferred ? 'deferred' : 'sync'} ${kind} cannot consume destructive approval`, (t) => {
    const c = fixture(t, deferred);
    const { approval_id } = c.h.broker.createApproval({ engagement_id: c.h.eng.engagement_id,
      bound: { action: 'exec', targets: ['10.0.0.5'] } });
    const first = c.req('review-first', 'review-task', { manual_approval_token: approval_id,
      contract: c.h.contract({ wire_cost: 0, action_class: 'destructive', action: 'exec' }) });
    const second = c.req(kind === 'command-as-task' ? 'review-task' : 'review-peer',
      kind === 'duplicate-task' ? 'review-task' : kind === 'task-as-command' ? 'review-first' : 'review-peer-task');
    let before;
    const injected = beforeWriteLock(c.h.broker, () => {
      c.peer.execute(second, c.opts); before = snapshot(c.h, c.peerAdapter);
    });
    assert.throws(() => c.h.broker.execute(first, c.opts), { code: 'E_APPROVAL_MISMATCH' });
    assert.equal(injected(), true); assert.deepEqual(snapshot(c.h, c.peerAdapter), before);
    assert.equal(c.h.broker.global.prepare('SELECT used_by_command FROM approvals WHERE approval_id = ?').get(approval_id).used_by_command, null);
  });
}
for (const deferred of [false, true]) test(`independent interleaving ${deferred ? 'deferred' : 'sync'} same command changed task remains a mismatch`, (t) => {
  const c = fixture(t, deferred); let before;
  const injected = beforeWriteLock(c.h.broker, () => {
    c.peer.execute(c.req('review-identical', 'review-peer-task'), c.opts); before = snapshot(c.h, c.peerAdapter);
  });
  assert.throws(() => c.h.broker.execute(c.req('review-identical', 'review-task'), c.opts), { code: 'E_APPROVAL_MISMATCH' });
  assert.equal(injected(), true); assert.deepEqual(snapshot(c.h, c.peerAdapter), before);
});
test('independent second writer cannot enter while identity registration lock is held and can enter after commit', (t) => {
  const c = fixture(t, true); c.peer.global.exec('PRAGMA busy_timeout = 0');
  const exec = c.h.broker.global.exec.bind(c.h.broker.global); let lockObserved = false;
  c.h.broker.global.exec = function(sql) {
    const result = exec(sql);
    if (sql === 'BEGIN IMMEDIATE') {
      assert.throws(() => c.peer.global.exec('BEGIN IMMEDIATE'), error => /locked|busy/.test(error.message));
      lockObserved = true;
    }
    return result;
  };
  c.h.broker.execute(c.req('review-lock', 'review-lock-task'), c.opts);
  assert.equal(lockObserved, true);
  c.peer.global.exec('BEGIN IMMEDIATE'); c.peer.global.exec('ROLLBACK');
});

// The peer may commit immediately after the initial unlocked same-command read,
// before any alias check. A matching explicit task must still be a lawful retry.
function afterInitialCommandRead(broker, action) {
  const prepare = broker.global.prepare.bind(broker.global); let injected = false;
  broker.global.prepare = function(sql) {
    const statement = prepare(sql);
    if (injected || sql !== 'SELECT * FROM command_queue WHERE command_id = ?') return statement;
    return new Proxy(statement, { get(target, name) {
      if (name !== 'get') {
        const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args) => {
        const result = target.get(...args);
        if (!injected) { injected = true; action(); }
        return result;
      };
    } });
  };
  return () => injected;
}
for (const deferred of [false, true]) for (const atCap of [false, true]) {
  test(`early same-command read interleaving ${deferred ? 'deferred' : 'sync'} explicit task retry stays idempotent with atCap=${atCap}`, t => {
    const c = fixture(t, deferred);
    if (atCap) c.h.broker.execute(c.req('early-existing', 'early-existing-task'), c.opts);
    const request = c.req('early-identical', 'early-task'); let before, accepted;
    const injected = afterInitialCommandRead(c.h.broker, () => {
      accepted = c.peer.execute(request, c.opts); before = snapshot(c.h, c.peerAdapter);
    });
    const retry = c.h.broker.execute(request, c.opts);
    assert.equal(injected(), true); assert.equal(retry.deduped, true);
    assert.equal(retry.task_id, accepted.task_id); assert.equal(retry.generation, accepted.generation);
    assert.deepEqual(snapshot(c.h, c.peerAdapter), before);
  });
}

// Approval binding integration: action strings are data in FakeAdapter only.
function approved(c, command_id = 'bound-command', task_id = 'bound-task') {
  const { approval_id } = c.h.broker.createApproval({ engagement_id: c.h.eng.engagement_id,
    bound: { action: 'exec', targets: ['10.0.0.5'], url: 'https://10.0.0.5:8443/safe' } });
  return c.req(command_id, task_id, { manual_approval_token: approval_id,
    contract: c.h.contract({ wire_cost: 0, action_class: 'destructive', action: 'exec', url: 'https://10.0.0.5:8443/safe' }) });
}
for (const deferred of [false, true]) test(`bound approval ${deferred ? 'deferred' : 'sync'} registration records actual command and valid host binding`, t => {
  const c = fixture(t, deferred); const request = approved(c);
  const result = c.h.broker.execute(request, c.opts);
  assert.equal(result.task_id, request.task_id);
  assert.equal(c.h.broker.dispatchCounter, 1);
  const row = c.h.broker.global.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(request.manual_approval_token);
  assert.equal(row.used_by_command, request.command_id);
  if (deferred) {
    const cmd = c.h.broker._findCommand(request.command_id);
    const owner = c.h.broker.global.prepare('SELECT * FROM task_owners WHERE command_id = ?').get(request.command_id);
    assert.doesNotThrow(() => c.h.broker.assertHostAuthorization(cmd, owner));
    c.h.broker.global.prepare('UPDATE command_queue SET contract = ? WHERE command_id = ?')
      .run(JSON.stringify({ ...JSON.parse(cmd.contract), url: 'https://10.0.0.5:8443/other' }), request.command_id);
    assert.throws(() => c.h.broker.assertHostAuthorization(c.h.broker._findCommand(request.command_id), owner), { code: 'E_APPROVAL_MISMATCH' });
  }
});
for (const deferred of [false, true]) for (const [name, inject] of [['early', afterInitialCommandRead], ['late', beforeWriteLock]]) {
  test(`bound approval ${deferred ? 'deferred' : 'sync'} ${name} retry at cap does not consume twice or register again`, t => {
    const c = fixture(t, deferred);
    c.h.broker.execute(c.req('bound-existing', 'bound-existing-task'), c.opts);
    const request = approved(c); let before, accepted;
    const injected = inject(c.h.broker, () => {
      accepted = c.peer.execute(request, c.opts); before = snapshot(c.h, c.peerAdapter);
    });
    const retry = c.h.broker.execute(request, c.opts);
    assert.equal(injected(), true); assert.equal(retry.deduped, true);
    assert.equal(retry.generation, accepted.generation); assert.deepEqual(snapshot(c.h, c.peerAdapter), before);
    assert.equal(c.h.broker.global.prepare('SELECT used_by_command FROM approvals WHERE approval_id = ?')
      .get(request.manual_approval_token).used_by_command, request.command_id);
  });
}
for (const kind of ['action', 'target', 'port', 'path', 'expired', 'used']) {
  test(`bound approval ${kind} rejection leaves counter registration rates and token unchanged`, t => {
    const c = fixture(t, true); const request = approved(c);
    if (kind === 'action') request.contract.action = 'internal';
    if (kind === 'target') request.contract.targets = ['10.0.0.6'];
    if (kind === 'port') request.contract.url = 'https://10.0.0.5:9443/safe';
    if (kind === 'path') request.contract.url = 'https://10.0.0.5:8443/other';
    if (kind === 'expired') c.h.broker.global.prepare('UPDATE approvals SET expires_at = ? WHERE approval_id = ?')
      .run('2000-01-01T00:00:00.000Z', request.manual_approval_token);
    if (kind === 'used') c.peer.execute({ ...request, command_id: 'bound-prior', task_id: 'bound-prior-task' }, c.opts);
    const before = snapshot(c.h, c.peerAdapter);
    assert.throws(() => c.h.broker.execute(request, c.opts), { code: kind === 'expired' ? 'E_APPROVAL_EXPIRED' : kind === 'used' ? 'E_APPROVAL_USED' : 'E_APPROVAL_MISMATCH' });
    assert.deepEqual(snapshot(c.h, c.peerAdapter), before);
  });
}
