// Synthetic parent and inert source only: no task payload, process, model or network execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { createWarroomService } from '../packages/warroom-plugin/src/service.js';
import { dshTools } from '../packages/warroom-plugin/src/tools.js';
import { toToolDefinition } from '../packages/warroom-plugin/src/dsh-entry.mjs';
import { createHostDelivery } from '../packages/warroom-plugin/src/host-delivery.js';

class HeldAdapter extends FakeAdapter {
  dispatches = 0;
  event = null;
  dispatch(id, contract) { this.dispatches++; return super.dispatch(id, contract); }
  observe() { return this.event; }
  complete(result, state) {
    this.event = { generation: result.generation, event_seq: 1, state,
      receipt: { receipt_id: 'inert-completion', generation: result.generation, members: [] } };
  }
}

function fixture(t, { deliveryAvailable = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'parent-turn-contract-'));
  const adapter = new HeldAdapter();
  const events = [];
  const messages = [];
  let stored = [];
  const agent = { id: 'inert-parent', status: 'active',
    session: { header: { id: 'inert-parent', createdAt: 1000 } },
    inbox: { hasPending: false },
    followup(message) {
      messages.push(message);
      events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { inserted: [message] } });
    } };
  const ctx = { agents: { get: () => agent },
    sessions: { flush: async () => { stored = [...events]; return true; } },
    sessionPersistence: { open: async () => ({ header: agent.session.header,
      read: async (offset, limit) => ({ events: stored.slice(offset, offset + limit) }),
      close: async () => {} }) } };
  const service = createWarroomService({ home, adapter, autoStart: false,
    hostDelivery: deliveryAvailable ? createHostDelivery(ctx) : null });
  t.after(async () => { await service.dispose(); rmSync(home, { recursive: true, force: true }); });
  const auth = service.broker.createEngagement({ user_message_id: 'inert-user', targets: ['example.test'] });
  const req = { command_id: 'inert-command', engagement_id: auth.engagement_id, auth_version: 1,
    action_class: 'readonly', contract: { targets: ['example.test'], action_class: 'readonly', wire_cost: 0, resources: [] } };
  const definitions = dshTools(service).map(toToolDefinition);
  const execute = definitions.find((tool) => tool.name === 'warroom_execute');
  const status = definitions.find((tool) => tool.name === 'warroom_status');
  return { service, adapter, agent, messages, req, execute, status };
}

for (const context of [undefined, null, {}]) test(`native dispatch refuses ${String(context)} context before synchronous fallback`, async (t) => {
  const h = fixture(t);
  await assert.rejects(h.execute.execute(h.req, context), { code: 'E_HOST_CONTEXT_REQUIRED' });
  assert.equal(h.adapter.dispatches, 0);
  assert.equal(h.service.broker.global.prepare('SELECT count(*) n FROM command_queue').get().n, 0);
  assert.equal(h.service.broker._eng(h.req.engagement_id).store.rateTotal('tool'), 0);
});

for (const agent of [{}, { id: 'inert-parent' },
  { id: 'inert-parent', session: { header: { id: 'other', createdAt: 1000 } } },
  { id: 'inert-parent', session: { header: { id: 'inert-parent', createdAt: 'invalid' } } }]) {
  test(`native dispatch rejects malformed parent ${JSON.stringify(agent)} without fallback`, async (t) => {
    const h = fixture(t);
    await assert.rejects(h.execute.execute(h.req, { agent }));
    assert.equal(h.adapter.dispatches, 0);
    assert.equal(h.service.broker.global.prepare('SELECT count(*) n FROM command_queue').get().n, 0);
  });
}

test('native tool advertises returning the parent turn after background registration', (t) => {
  const h = fixture(t);
  assert.match(h.execute.description, /后台/);
  assert.match(h.execute.description, /结束.*回合/);
});

test('native dispatch refuses missing delivery before registration', async (t) => {
  const h = fixture(t, { deliveryAvailable: false });
  await assert.rejects(h.execute.execute(h.req, { agent: h.agent }), /host|parent/i);
  assert.equal(h.adapter.dispatches, 0);
  assert.equal(h.service.broker.global.prepare('SELECT count(*) n FROM command_queue').get().n, 0);
});

for (const state of ['done', 'failed']) test(`native queued return releases parent turn before ${state} notification`, async (t) => {
  const h = fixture(t);
  const result = await h.execute.execute(h.req, { agent: h.agent });
  assert.equal(result.state, 'queued');
  assert.equal(h.adapter.dispatches, 0, 'registration must return before source dispatch');
  assert.ok(result.task_id); assert.ok(result.generation);
  assert.deepEqual(result.host_dispatch, { mode: 'background', completion: 'host_notification', next_action: 'return_to_user' });
  // Simulate ending the invocation and receiving a new user turn while completion is held.
  h.agent.status = 'idle';
  await h.service.tasks.tick();
  h.agent.inbox.hasPending = true;
  h.agent.status = 'active';
  const reply = await h.status.execute({ engagement_id: h.req.engagement_id, task_id: result.task_id }, { agent: h.agent });
  assert.equal(reply.ledger_state, 'running');
  assert.equal(h.adapter.event, null, 'new user turn answered before source completion');
  h.adapter.complete(result, state);
  await h.service.tasks.tick();
  assert.equal(h.messages.length, 0, 'notification must wait for the pending user turn');
  h.agent.inbox.hasPending = false; h.agent.status = 'idle';
  await h.service.tasks.tick(); await h.service.tasks.tick();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content[0].text, new RegExp(`"state":"${state}"`));
  assert.equal(h.adapter.dispatches, 1);
  const replay = await h.execute.execute(h.req, { agent: h.agent });
  assert.equal(replay.task_id, result.task_id); assert.equal(replay.state, state);
  assert.equal(replay.host_dispatch.next_action, 'return_to_user');
  await h.service.tasks.tick();
  assert.equal(h.messages.length, 1, 'idempotent return must not repeat a completion notice');
});

test('direct tools retain explicit synchronous compatibility outside native wrapper', (t) => {
  const h = fixture(t);
  const result = dshTools(h.service).find((tool) => tool.name === 'warroom_execute').execute(h.req);
  assert.equal(result.state, 'running');
  assert.equal(h.adapter.dispatches, 1);
  assert.equal(result.host_dispatch, undefined);
});
