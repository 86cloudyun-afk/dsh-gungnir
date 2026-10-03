// Defensive retry boundary: synthetic homes, inert FakeAdapter, no real probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { ERR } from '../packages/shared-types/src/index.js';
import { dshTools } from '../packages/warroom-plugin/src/tools.js';
import { toToolDefinition } from '../packages/warroom-plugin/src/dsh-entry.mjs';

function fixture(t, { state = 'failed', destructive = false, actionClass = 'active' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wr-retry-auth-'));
  const adapter = new FakeAdapter({ faults: { containerResidue: true } });
  const c = { home, adapter, clock: Date.now(), calls: 0 };
  c.broker = new Broker({ home, adapter, nowMs: () => c.clock });
  c.eng = c.broker.createEngagement({ user_message_id: 'trusted-synthetic-retry', targets: ['target.example.test'] });
  const approval = destructive ? c.broker.createApproval({ engagement_id: c.eng.engagement_id,
    bound: { action: 'exec', targets: ['target.example.test'] } }) : null;
  c.started = c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, command_id: 'retry-fixture',
    contract: { targets: ['target.example.test'], action_class: destructive ? 'destructive' : actionClass,
      ...(destructive ? { action: 'exec' } : {}),
      resources: state === 'unresolved' ? ['container'] : [], wire_cost: 0 }, manual_approval_token: approval?.approval_id });
  if (state === 'unresolved') c.broker.cancel(c.eng.engagement_id, c.started.task_id, 'inert residue fixture');
  else if (state !== 'running') c.broker._setCommandState('retry-fixture', state);
  const retry = adapter.redispatch.bind(adapter);
  adapter.redispatch = (...args) => { c.calls++; return retry(...args); };
  t.after(() => {
    for (const { db } of c.broker.engagements.values()) db.close();
    c.broker.global.close(); rmSync(home, { recursive: true, force: true });
  });
  return c;
}

function changeAuth(c, patch) {
  const auth = { ...c.broker._auth(c.eng.engagement_id).auth, ...patch };
  // Isolate each gate using synthetic trusted data; no original authorization is opened.
  c.broker._eng(c.eng.engagement_id).db.prepare('UPDATE engagements SET auth_object = ? WHERE id = ?')
    .run(JSON.stringify(auth), c.eng.engagement_id);
}
function changeContract(c, patch) {
  const cmd = c.broker._findCommand(c.started.task_id);
  c.broker.global.prepare('UPDATE command_queue SET contract = ? WHERE command_id = ?')
    .run(JSON.stringify({ ...JSON.parse(cmd.contract), ...patch }), cmd.command_id);
}
function snapshot(c) {
  return { command: { ...c.broker._findCommand(c.started.task_id) },
    adapter: JSON.stringify([...c.adapter.tasks.values()]), calls: c.calls,
    approvals: c.broker.global.prepare('SELECT * FROM approvals').all(),
    rate: c.broker._eng(c.eng.engagement_id).store.db.prepare('SELECT * FROM rate_ledger').all() };
}
function denied(c, code, owner = c.eng.engagement_id, id = c.started.task_id) {
  const before = snapshot(c);
  assert.throws(() => c.broker.redispatch(owner, id, 'synthetic denied retry'), { code });
  assert.deepEqual(snapshot(c), before, 'denial must not mutate ledger, adapter, approvals or rates');
}

for (const state of ['failed', 'unresolved']) {
  test(`redispatch rejects expired authorization for ${state} without side effects`, (t) => {
    const c = fixture(t, { state }); c.clock = Date.parse(c.eng.auth_object.window_end) + 1;
    denied(c, ERR.E_GATE_WINDOW_CLOSED);
  });
  test(`redispatch rejects revoked original authorization for ${state}`, (t) => {
    const c = fixture(t, { state }); c.broker.revoke(c.eng.engagement_id, 'synthetic revocation');
    denied(c, ERR.E_GATE_AUTH_EXPIRED);
  });
  test(`redispatch preserves valid same-owner ${state} task identity and quarantines old receipt`, (t) => {
    const c = fixture(t, { state });
    const out = c.broker.redispatch(c.eng.engagement_id, c.started.task_id, 'trusted inert retry');
    assert.equal(out.task_id, c.started.task_id); assert.equal(out.attempt, 2); assert.equal(out.generation, '1:1:2');
    assert.equal(c.calls, 1); assert.equal(c.adapter.tasks.size, 1);
    assert.equal(c.broker._findCommand('retry-fixture').state, 'running');
    const stale = c.broker.collect(c.eng.engagement_id, c.started.task_id,
      { receipt_id: 'inert-old', generation: c.started.generation, members: [] });
    assert.equal(stale.accepted, false); assert.equal(stale.quarantined, 'generation');
    assert.equal(c.broker.collect(c.eng.engagement_id, c.started.task_id,
      { receipt_id: 'inert-current', generation: out.generation, members: [] }).accepted, true);
  });
}
for (const idKind of ['task', 'command']) test(`redispatch rejects another engagement using ${idKind} identifier`, (t) => {
  const c = fixture(t);
  const other = c.broker.createEngagement({ user_message_id: 'trusted-other-fixture', targets: ['target.example.test'] });
  denied(c, ERR.E_APPROVAL_MISMATCH, other.engagement_id, idKind === 'task' ? c.started.task_id : 'retry-fixture');
});
test('redispatch rejects unknown owner before opening its storage', (t) => {
  const c = fixture(t); denied(c, ERR.E_APPROVAL_MISMATCH, 'eng_unknown');
  assert.equal(existsSync(join(c.home, 'engagements', 'eng_unknown')), false);
});
for (const [label, patch, code] of [
  ['out-of-scope stored targets', { scope: ['other.example.test'] }, ERR.E_GATE_OUT_OF_SCOPE],
  ['lower current action-class limit', { action_class_limit: 'readonly' }, ERR.E_GATE_CLASS_EXCEEDS_LIMIT],
  ['window not started', { window_start: '2099-01-01T00:00:00.000Z', window_end: '2100-01-01T00:00:00.000Z' }, ERR.E_GATE_WINDOW_CLOSED],
  ['reversed window', { window_start: '2099-01-01T00:00:00.000Z', window_end: '2000-01-01T00:00:00.000Z' }, ERR.E_GATE_WINDOW_CLOSED],
  ['invalid window start', { window_start: 'invalid' }, ERR.E_GATE_WINDOW_CLOSED],
  ['invalid window end', { window_end: 'invalid' }, ERR.E_GATE_WINDOW_CLOSED],
]) test(`redispatch rejects ${label}`, (t) => { const c = fixture(t); changeAuth(c, patch); denied(c, code); });
for (const state of ['failed', 'unresolved']) {
  for (const limit of ['invalid', null, undefined, '']) test(`redispatch rejects unusable current class limit ${String(limit)} for ${state}`, (t) => {
    const c = fixture(t, { state }); changeAuth(c, { action_class_limit: limit });
    denied(c, ERR.E_GATE_CLASS_EXCEEDS_LIMIT);
  });
}
for (const value of ['{', 'null']) test(`redispatch rejects malformed stored JSON ${value}`, (t) => {
  const c = fixture(t);
  c.broker.global.prepare('UPDATE command_queue SET contract = ? WHERE command_id = ?').run(value, 'retry-fixture');
  denied(c, ERR.E_GATE_MISSING_TUPLE);
});
test('redispatch rejects invalid current clock', (t) => { const c = fixture(t); c.clock = NaN; denied(c, ERR.E_GATE_WINDOW_CLOSED); });
test('redispatch cannot reuse consumed destructive approval', (t) => {
  const c = fixture(t, { destructive: true }); denied(c, ERR.E_GATE_DESTRUCTIVE_NEEDS_APPROVAL);
});
test('redispatch refuses unsupported adapter before claiming running', (t) => {
  const c = fixture(t); c.adapter.redispatch = undefined; denied(c, ERR.E_TASK_NOT_REDISPATCHABLE);
});
for (const [label, patch] of [
  ['other engagement', { engagement_id: 'eng_other' }], ['other task', { task_id: 'wt_other' }],
]) test(`redispatch rejects stored contract binding to ${label}`, (t) => {
  const c = fixture(t); changeContract(c, patch); denied(c, ERR.E_APPROVAL_MISMATCH);
});
for (const patch of [{ targets: [] }, { action_class: 'invalid' }]) test(`redispatch validates stored contract ${JSON.stringify(patch)}`, (t) => {
  const c = fixture(t); changeContract(c, patch); denied(c, ERR.E_GATE_MISSING_TUPLE);
});
for (const value of [null, 'invalid', '0:1:1', '1:1:0', '1:1:1\n', '9007199254740992:1:1']) {
  for (const source of ['queue', 'original']) test(`redispatch rejects invalid ${source} generation ${JSON.stringify(value)}`, (t) => {
    const c = fixture(t);
    if (source === 'original') changeContract(c, { generation: value });
    else c.broker.global.prepare('UPDATE command_queue SET generation = ? WHERE command_id = ?').run(value, 'retry-fixture');
    denied(c, ERR.E_GATE_MISSING_TUPLE);
  });
}
test('redispatch rejects generation attempt inconsistent with queue', (t) => {
  const c = fixture(t); c.broker.global.prepare('UPDATE command_queue SET generation = ? WHERE command_id = ?').run('1:1:2', 'retry-fixture');
  denied(c, ERR.E_GATE_MISSING_TUPLE);
});
test('redispatch rejects attempt overflow before modifying persistent generation', (t) => {
  const c = fixture(t);
  c.broker.global.prepare('UPDATE command_queue SET generation = ?, attempt = ? WHERE command_id = ?')
    .run('1:1:9007199254740991', Number.MAX_SAFE_INTEGER, 'retry-fixture');
  denied(c, ERR.E_GATE_MISSING_TUPLE);
});
test('native model redispatch wrapper refuses revoked task without mutation', async (t) => {
  const c = fixture(t); c.broker.revoke(c.eng.engagement_id, 'synthetic wrapper revocation');
  const definition = toToolDefinition(dshTools({ broker: c.broker }).find((x) => x.name === 'warroom_redispatch'));
  const args = { engagement_id: c.eng.engagement_id, task_id: c.started.task_id, reason: 'inert wrapper' };
  assert.deepEqual(definition.parameters.required, ['engagement_id', 'task_id']);
  const before = snapshot(c);
  await assert.rejects(() => definition.execute(args), { code: ERR.E_GATE_AUTH_EXPIRED });
  assert.deepEqual(snapshot(c), before);
});
test('redispatch cannot revive a historical retry that promoted original authorization', (t) => {
  const c = fixture(t); c.broker.revoke(c.eng.engagement_id, 'synthetic revocation');
  c.broker.global.prepare('UPDATE command_queue SET generation = ? WHERE command_id = ?').run('2:1:1', 'retry-fixture');
  denied(c, ERR.E_GATE_AUTH_EXPIRED);
});
for (const state of ['running', 'unknown', 'cancel_requested', 'done', 'confirmed_stopped']) test(`redispatch still refuses ${state}`, (t) => {
  const c = fixture(t, { state: 'running' });
  if (state === 'confirmed_stopped') { c.broker._setCommandState('retry-fixture', 'cancel_requested'); c.broker._setCommandState('retry-fixture', state); }
  else if (state !== 'running') c.broker._setCommandState('retry-fixture', state);
  denied(c, ERR.E_TASK_NOT_REDISPATCHABLE);
});
test('redispatch after broker restart with same adapter uses persistent task sequence', (t) => {
  const c = fixture(t);
  c.broker.execute({ engagement_id: c.eng.engagement_id, auth_version: 1, command_id: 'other-task',
    contract: { targets: ['target.example.test'], action_class: 'readonly', resources: [], wire_cost: 0 } });
  for (const { db } of c.broker.engagements.values()) db.close(); c.broker.global.close();
  c.broker = new Broker({ home: c.home, adapter: c.adapter, nowMs: () => c.clock });
  assert.equal(c.broker.redispatch(c.eng.engagement_id, 'retry-fixture').generation, '1:1:2');
  assert.equal(c.calls, 1); assert.equal(c.adapter.tasks.size, 2);
});
test('redispatch retains readonly class and original version across repeated failed attempts', (t) => {
  const c = fixture(t, { actionClass: 'readonly' });
  const second = c.broker.redispatch(c.eng.engagement_id, 'retry-fixture');
  assert.equal(second.generation, '1:1:2');
  c.adapter.tasks.get('retry-fixture').state = 'failed';
  c.broker._setCommandState('retry-fixture', 'failed');
  const third = c.broker.redispatch(c.eng.engagement_id, 'retry-fixture');
  assert.equal(third.generation, '1:1:3'); assert.equal(third.task_id, c.started.task_id);
  assert.equal(c.calls, 2); assert.equal(c.adapter.tasks.size, 1);
  assert.equal(c.adapter.tasks.get('retry-fixture').contract.action_class, 'readonly');
});
test('redispatch retains valid legacy zero sequence without upgrading authorization', (t) => {
  const c = fixture(t);
  c.broker.global.prepare('UPDATE command_queue SET generation = ?, attempt = 2 WHERE command_id = ?').run('1:0:2', 'retry-fixture');
  const out = c.broker.redispatch(c.eng.engagement_id, 'retry-fixture');
  assert.equal(out.generation, '1:0:3'); assert.equal(out.attempt, 3); assert.equal(c.calls, 1);
});
