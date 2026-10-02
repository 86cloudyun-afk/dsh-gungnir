import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { RedteamModeAdapter } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { FileBridgeDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';
import { createWarroomService } from '../packages/warroom-plugin/src/service.js';
import { dshTools } from '../packages/warroom-plugin/src/tools.js';
import { toToolDefinition } from '../packages/warroom-plugin/src/dsh-entry.mjs';

// Inert source: no targets, processes, models or network are contacted.
class InertAdapter extends FakeAdapter {
  events = new Map();
  dispatches = 0;
  dispatch(id, contract) { this.dispatches++; return super.dispatch(id, contract); }
  finish(id, { event_seq = 1, generation, state = 'done', members = [] } = {}) {
    const task = this.tasks.get(id);
    this.events.set(task.task_id, { event_seq, generation: generation ?? task.generation, state,
      receipt: { receipt_id: `source-${id}-${event_seq}`, generation: generation ?? task.generation, members } });
  }
  observe(id) { return this.events.get(id) ?? null; }
}

function setup({ adapter = new InertAdapter(), home, delivery } = {}) {
  const notices = [];
  const sink = delivery ?? { deliver: async (_owner, notice) => {
    notices.push(notice); return { status: 'delivered', cursor: notices.length };
  } };
  const service = createWarroomService({ home: home ?? mkdtempSync(join(tmpdir(), 'host-runner-')),
    adapter, hostDelivery: sink, autoStart: false });
  const auth = service.broker.createEngagement({ user_message_id: 'inert-source', targets: ['example.test'] });
  const req = { engagement_id: auth.engagement_id, auth_version: 1, command_id: 'inert-one',
    contract: { targets: ['example.test'], action_class: 'readonly', wire_cost: 0, resources: [] } };
  const parent = { session_id: 'parent-one', created_at: 1000 };
  const result = service.broker.execute(req, { deferDispatch: true, parent });
  return { service, adapter, notices, req, parent, result };
}

test('host owns worker after queued tool return and completion updates ledger before notice', async () => {
  const h = setup();
  assert.ok(h.service.tasks, 'host task observer missing');
  assert.equal(h.result.state, 'queued');
  assert.equal(h.adapter.dispatches, 0);
  await h.service.tasks.tick();
  assert.equal(h.adapter.dispatches, 1);
  h.adapter.finish(h.req.command_id);
  await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'done');
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].task_id, h.result.task_id);
  await h.service.tasks.dispose();
});

test('lost completion delivery stays pending, reload replays notice without redispatch', async () => {
  const h = setup({ delivery: { deliver: async () => { throw new Error('delivery lost'); } } });
  await h.service.tasks.tick(); h.adapter.finish(h.req.command_id); await h.service.tasks.tick();
  assert.equal(h.service.broker.global.prepare('SELECT delivery_state FROM task_notifications').get().delivery_state, 'pending');
  await h.service.tasks.dispose();
  const notices = [];
  const reloaded = createWarroomService({ home: h.service.home, adapter: h.adapter, autoStart: false,
    hostDelivery: { deliver: async (_o, n) => { notices.push(n); return { status: 'delivered', cursor: 1 }; } } });
  await reloaded.tasks.tick(); await reloaded.tasks.tick();
  assert.equal(notices.length, 1);
  assert.equal(h.adapter.dispatches, 1);
  await reloaded.tasks.dispose();
});

test('duplicate and out-of-order source events cannot duplicate completion or regress state', async () => {
  const h = setup(); await h.service.tasks.tick();
  h.adapter.finish(h.req.command_id, { event_seq: 3 });
  await h.service.tasks.tick(); await h.service.tasks.tick();
  h.adapter.finish(h.req.command_id, { event_seq: 2, state: 'running' }); await h.service.tasks.tick();
  assert.equal(h.notices.length, 1);
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'done');
  assert.equal(h.service.broker.global.prepare('SELECT last_event_seq FROM task_owners').get().last_event_seq, 3);
  await h.service.tasks.dispose();
});

test('missing and old event generations cannot complete or ingest facts', async () => {
  const h = setup(); await h.service.tasks.tick();
  h.adapter.finish(h.req.command_id, { generation: '0:1:1' }); await h.service.tasks.tick();
  const event = h.adapter.events.get(h.result.task_id); delete event.generation; await h.service.tasks.tick();
  assert.equal(h.notices.length, 0);
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'running');
  assert.equal(h.service.broker.global.prepare('SELECT last_event_seq FROM task_owners').get().last_event_seq, 0);
  await h.service.tasks.dispose();
});

test('cancellation is registered before stop and late completion cannot resurrect task', async () => {
  const h = setup(); await h.service.tasks.tick();
  h.adapter.faults.containerResidue = true;
  h.adapter.tasks.get(h.req.command_id).container_up = true;
  h.adapter.tasks.get(h.req.command_id).manifest.push({ id: 'residual', kind: 'container' });
  const cancel = h.service.broker.cancel(h.req.engagement_id, h.result.task_id);
  assert.equal(cancel.state, 'cancel_requested');
  assert.equal(h.adapter.tasks.get(h.req.command_id).session_up, true, 'tool must only register cancellation');
  h.adapter.finish(h.req.command_id); await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'unresolved');
  assert.ok(h.notices.every((n) => n.state !== 'done' && n.state !== 'confirmed_stopped'));
  h.adapter.tasks.get(h.req.command_id).container_up = false;
  await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'confirmed_stopped');
  await h.service.tasks.dispose();
});

test('queued task cancelled before host tick never starts and never claims resource stop proof', async () => {
  const h = setup(); h.service.broker.cancel(h.req.engagement_id, h.result.task_id);
  await h.service.tasks.tick();
  assert.equal(h.adapter.dispatches, 0);
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'cancelled');
  assert.ok(h.notices.every((n) => n.state !== 'confirmed_stopped'));
  await h.service.tasks.dispose();
});

test('authorization revocation and window expiry suppress late success', async () => {
  for (const revoked of [true, false]) {
    const h = setup(); await h.service.tasks.tick(); h.adapter.finish(h.req.command_id);
    const db = h.service.broker._eng(h.req.engagement_id).db;
    if (revoked) h.service.broker.revoke(h.req.engagement_id);
    else h.service.broker._nowMs = () => Date.now() + 100 * 3600_000;
    await h.service.tasks.tick();
    assert.ok(h.notices.every((n) => n.state !== 'done'));
    assert.notEqual(h.service.broker._findCommand(h.result.task_id).state, 'done');
    assert.equal(h.adapter.dispatches, 1);
    assert.ok(db);
    await h.service.tasks.dispose();
  }
});

test('old attempt event cannot finish a newer ledger generation', async () => {
  const h = setup(); await h.service.tasks.tick(); h.adapter.finish(h.req.command_id);
  h.service.broker.global.prepare('UPDATE command_queue SET generation = ?').run('1:1:2');
  await h.service.tasks.tick();
  assert.equal(h.notices.length, 0);
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'running');
  await h.service.tasks.dispose();
});

test('bridge cancellation without source proof stays unresolved even if source says confirmed_stopped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-stop-'));
  const driver = new FileBridgeDriver({ root, background: true });
  const h = setup({ adapter: new RedteamModeAdapter({ driver }) });
  await h.service.tasks.tick();
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id);
  writeFileSync(driver._statusPath(h.result.task_id), JSON.stringify({ state: 'confirmed_stopped',
    external_id: h.result.task_id, generation: h.result.generation, event_seq: 2 }));
  writeFileSync(driver._probesPath(h.result.task_id), JSON.stringify({ generation: 'old', resources: [
    { id: `${h.result.task_id}-session`, kind: 'session', stopped: true } ] }));
  await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'unresolved');
  assert.ok(h.notices.every((n) => n.state !== 'confirmed_stopped'));
  await h.service.tasks.dispose();
});

test('DSH tool context queues for its actual parent and cannot take parent identity from args', async () => {
  const h = setup();
  const tool = dshTools(h.service).find((t) => t.name === 'warroom_execute');
  const def = toToolDefinition(tool);
  const r = await def.execute({ ...h.req, command_id: 'inert-two', parent_session_id: 'forged' }, {
    agent: { id: 'actual-parent', session: { header: { id: 'actual-parent', createdAt: 2000 } } },
    signal: new AbortController().signal,
  });
  assert.equal(r.state, 'queued');
  const owner = h.service.broker.global.prepare("SELECT * FROM task_owners WHERE command_id = 'inert-two'").get();
  assert.equal(owner.parent_session_id, 'actual-parent');
  assert.equal(owner.parent_created_at, 2000);
  assert.equal(h.adapter.dispatches, 0);
  await h.service.tasks.dispose();
});

test('DSH execute without parent context or host delivery fails before registration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'host-no-context-'));
  const svc = createWarroomService({ home });
  const def = toToolDefinition(dshTools(svc).find((t) => t.name === 'warroom_execute'));
  await assert.rejects(def.execute({}, { signal: new AbortController().signal }), /host|parent/i);
  assert.equal(svc.broker.global.prepare('SELECT count(*) n FROM command_queue').get().n, 0);
});

test('dispose waits for host-owned delivery and cancels further scheduled work', async () => {
  let release;
  let entered;
  const entering = new Promise((r) => { entered = r; });
  const h = setup({ delivery: { deliver: async () => {
    entered(); await new Promise((r) => { release = r; }); return { status: 'pending' };
  } } });
  await h.service.tasks.tick(); h.adapter.finish(h.req.command_id);
  const active = h.service.tasks.tick(); await entering;
  let disposed = false;
  const closing = h.service.tasks.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  release(); await active; await closing;
  assert.equal(disposed, true);
  await h.service.tasks.tick(); assert.equal(h.adapter.dispatches, 1);
});

test('host collection after cancellation or revocation cannot ingest a matching-generation receipt', async () => {
  const h = setup(); await h.service.tasks.tick();
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id);
  const receipt = { receipt_id: 'late', generation: h.result.generation, members: [
    { entity_type: 'asset', source_id: 'inert', revision_no: 1, content_hash: 'inert', payload: {} } ] };
  const result = h.service.broker.collect(h.req.engagement_id, h.result.task_id, receipt);
  assert.equal(result.accepted, false);
  assert.equal(h.service.broker._eng(h.req.engagement_id).store.effectiveCount(), 0);
  await h.service.tasks.dispose();
});

test('host settle and reconcile cannot bypass observer generation/cancellation guard', async () => {
  const h = setup(); await h.service.tasks.tick();
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id); await h.service.tasks.tick();
  const before = h.service.broker._findCommand(h.result.task_id).state;
  h.adapter.tasks.get(h.req.command_id).state = 'done';
  h.adapter.tasks.get(h.req.command_id).generation = 'old';
  assert.equal(h.service.broker.settle(h.req.engagement_id, h.result.task_id).ledger_state, before);
  await h.service.tasks.dispose();
});

test('host redispatch cannot revive cancelled task or bypass fresh authorization/budget', async () => {
  const h = setup(); await h.service.tasks.tick();
  h.adapter.faults.containerResidue = true;
  h.adapter.tasks.get(h.req.command_id).container_up = true;
  h.adapter.tasks.get(h.req.command_id).manifest.push({ id: 'residual', kind: 'container' });
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id); await h.service.tasks.tick();
  assert.throws(() => h.service.broker.redispatch(h.req.engagement_id, h.result.task_id), /host|fresh|cancel/i);
  assert.equal(h.adapter.dispatches, 1);
  await h.service.tasks.dispose();
});

test('missing runtime attachment after cancellation is unresolved rather than left cancel_requested', async () => {
  const h = setup(); await h.service.tasks.tick();
  h.adapter.lookup = () => null; h.adapter.hydrate = () => null;
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id); await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'unresolved');
  assert.ok(h.notices.every((n) => n.state !== 'confirmed_stopped'));
  await h.service.dispose();
});

test('service disposal closes owned databases once after draining host work', async () => {
  const h = setup(); await h.service.tasks.tick();
  await h.service.dispose(); await h.service.dispose();
  assert.throws(() => h.service.broker.knowledge.db.prepare('SELECT 1'), /closed|open/i);
  assert.equal(h.service.tasks.closed, true);
});

test('same-generation stale facts cannot satisfy a newer bridge completion sequence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-stale-sequence-'));
  const driver = new FileBridgeDriver({ root, background: true });
  const h = setup({ adapter: new RedteamModeAdapter({ driver }) }); await h.service.tasks.tick();
  writeFileSync(driver._statusPath(h.result.task_id), JSON.stringify({ external_id: h.result.task_id,
    generation: h.result.generation, state: 'done', event_seq: 3 }));
  writeFileSync(driver._factsPath(h.result.task_id), JSON.stringify({ external_id: h.result.task_id,
    generation: h.result.generation, members: [], event_seq: 2 }));
  await h.service.tasks.tick();
  assert.notEqual(h.service.broker._findCommand(h.result.task_id).state, 'done');
  assert.equal(h.notices.length, 0);
  await h.service.dispose();
});

for (const phase of ['undispatched', 'running', 'terminal']) test(`public collection cannot inject host facts while ${phase}`, async () => {
  const h = setup();
  if (phase !== 'undispatched') await h.service.tasks.tick();
  if (phase === 'terminal') { h.adapter.finish(h.req.command_id); await h.service.tasks.tick(); }
  const collect = dshTools(h.service).find((t) => t.name === 'warroom_collect');
  const result = await collect.execute({ engagement_id: h.req.engagement_id, task_id: h.result.task_id,
    receipt: { receipt_id: 'caller-injected', generation: h.result.generation, members: [
      { entity_type: 'asset', source_id: 'injected', revision_no: 1, content_hash: 'safe', payload: {} } ] } });
  assert.equal(result.accepted, false);
  assert.equal(h.service.broker._eng(h.req.engagement_id).store.effectiveCount(), 0);
  await h.service.dispose();
});

test('queued host bridge status is available before runtime dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-status-'));
  const h = setup({ adapter: new RedteamModeAdapter({ driver: new FileBridgeDriver({ root, background: true }) }) });
  const result = await dshTools(h.service).find((t) => t.name === 'warroom_status')
    .execute({ engagement_id: h.req.engagement_id, task_id: h.result.task_id });
  assert.equal(result.ledger_state, 'queued'); assert.equal(result.runtime_state, null);
  await h.service.dispose();
});

test('terminal host bridge ledger remains queryable after plugin reload without runtime attachment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-terminal-status-'));
  const h = setup({ adapter: new RedteamModeAdapter({ driver: new FileBridgeDriver({ root, background: true }) }) });
  h.service.broker.global.prepare("UPDATE command_queue SET state = 'done'").run();
  await h.service.dispose();
  const reloaded = createWarroomService({ home: h.service.home, autoStart: false,
    adapter: new RedteamModeAdapter({ driver: new FileBridgeDriver({ root, background: true }) }),
    hostDelivery: { deliver: async () => ({ status: 'pending' }) } });
  const result = await dshTools(reloaded).find((t) => t.name === 'warroom_status')
    .execute({ engagement_id: h.req.engagement_id, task_id: h.result.task_id });
  assert.equal(result.ledger_state, 'done'); assert.equal(result.runtime_state, null);
  await reloaded.dispose();
});

for (const proofSeq of [undefined, 1, 10]) test(`stop proof sequence ${proofSeq ?? 'missing'} cannot predate cancellation boundary`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-stop-sequence-'));
  const driver = new FileBridgeDriver({ root, background: true });
  const h = setup({ adapter: new RedteamModeAdapter({ driver }) }); await h.service.tasks.tick();
  const envelope = { external_id: h.result.task_id, generation: h.result.generation };
  writeFileSync(driver._statusPath(h.result.task_id), JSON.stringify({ ...envelope, state: 'running', event_seq: 10 }));
  writeFileSync(driver._probesPath(h.result.task_id), JSON.stringify({ ...envelope, event_seq: proofSeq,
    resources: [{ id: `${h.result.task_id}-session`, kind: 'session', stopped: true }] }));
  // Cancel before polling seq10: the causal floor must come from the source, not last_event_seq=0.
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id); await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'unresolved');
  writeFileSync(driver._statusPath(h.result.task_id), JSON.stringify({ ...envelope, state: 'confirmed_stopped', event_seq: 11 }));
  const request = JSON.parse(readFileSync(driver._stopPath(h.result.task_id), 'utf8'));
  writeFileSync(driver._probesPath(h.result.task_id), JSON.stringify({ ...envelope, event_seq: 11,
    stop_request_id: request.request_id,
    resources: [{ id: `${h.result.task_id}-session`, kind: 'session', stopped: true }] }));
  await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'confirmed_stopped');
  await h.service.dispose();
});

test('observed residual resource remains required when later proof omits it and plugin reloads', async () => {
  const h = setup(); await h.service.tasks.tick();
  let manifest = [{ id: 'session', kind: 'session', check: () => true },
    { id: 'residual', kind: 'process', check: () => false }];
  h.adapter.manifestOf = () => manifest;
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id); await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'unresolved');
  manifest = manifest.slice(0, 1); await h.service.dispose();
  const reloaded = createWarroomService({ home: h.service.home, adapter: h.adapter, autoStart: false,
    hostDelivery: { deliver: async () => ({ status: 'pending' }) } });
  await reloaded.tasks.tick();
  assert.equal(reloaded.broker._findCommand(h.result.task_id).state, 'unresolved');
  await reloaded.dispose();
});

test('cancellation terminal state rolls back if notification registration fails and retries safely', async () => {
  const h = setup(); h.service.broker.cancel(h.req.engagement_id, h.result.task_id);
  const notice = h.service.tasks._notice;
  h.service.tasks._notice = () => { throw new Error('notification write interrupted'); };
  await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'cancel_requested');
  h.service.tasks._notice = notice; await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'cancelled');
  assert.equal(h.notices.length, 1);
  await h.service.dispose();
});

for (const replaySeq of [3, 11]) test(`lost source status cannot make old stopped proof sequence ${replaySeq} causal`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-stop-causality-'));
  const driver = new FileBridgeDriver({ root, background: true });
  const h = setup({ adapter: new RedteamModeAdapter({ driver }) }); await h.service.tasks.tick();
  const envelope = { external_id: h.result.task_id, generation: h.result.generation };
  writeFileSync(driver._statusPath(h.result.task_id), JSON.stringify({ ...envelope, state: 'running', event_seq: 10 }));
  await h.service.tasks.tick(); unlinkSync(driver._statusPath(h.result.task_id));
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id); await h.service.tasks.tick();
  writeFileSync(driver._statusPath(h.result.task_id), JSON.stringify({ ...envelope, state: 'confirmed_stopped', event_seq: replaySeq }));
  writeFileSync(driver._probesPath(h.result.task_id), JSON.stringify({ ...envelope, event_seq: replaySeq,
    resources: [{ id: `${h.result.task_id}-session`, kind: 'session', stopped: true }] }));
  await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'unresolved');
  await h.service.dispose();
});

test('stop acknowledgement must match persisted cancellation identity across reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-stop-ack-'));
  const driver = new FileBridgeDriver({ root, background: true });
  const h = setup({ adapter: new RedteamModeAdapter({ driver }) }); await h.service.tasks.tick();
  h.service.broker.cancel(h.req.engagement_id, h.result.task_id); await h.service.tasks.tick();
  const request = JSON.parse(readFileSync(driver._stopPath(h.result.task_id), 'utf8'));
  const envelope = { external_id: h.result.task_id, generation: h.result.generation, event_seq: 12 };
  writeFileSync(driver._statusPath(h.result.task_id), JSON.stringify({ ...envelope, state: 'confirmed_stopped' }));
  const proof = { ...envelope, stop_request_id: 'another-cancellation',
    resources: [{ id: `${h.result.task_id}-session`, kind: 'session', stopped: true }] };
  writeFileSync(driver._probesPath(h.result.task_id), JSON.stringify(proof));
  await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'unresolved');
  writeFileSync(driver._stopPath(h.result.task_id), JSON.stringify({ ...request, request_id: 'another-cancellation' }));
  await h.service.tasks.tick();
  assert.equal(h.service.broker._findCommand(h.result.task_id).state, 'unresolved', 'spool replacement cannot rebind durable cancellation');
  writeFileSync(driver._stopPath(h.result.task_id), JSON.stringify(request));
  await h.service.dispose();
  const reloaded = createWarroomService({ home: h.service.home, adapter: new RedteamModeAdapter({ driver }), autoStart: false,
    hostDelivery: { deliver: async () => ({ status: 'pending' }) } });
  assert.ok(request.request_id);
  writeFileSync(driver._probesPath(h.result.task_id), JSON.stringify({ ...proof, stop_request_id: request.request_id }));
  await reloaded.tasks.tick();
  assert.equal(reloaded.broker._findCommand(h.result.task_id).state, 'confirmed_stopped');
  await reloaded.dispose();
});
