import { test } from 'node:test';
import assert from 'node:assert/strict';
const { createHostDelivery } = await import('../packages/warroom-plugin/src/dsh-entry.mjs');

function fixture() {
  const log = [];
  let stored = [];
  const nextTurn = [];
  const agent = {
    id: 'parent', status: 'idle', session: { header: { id: 'parent', createdAt: 1000 } },
    inbox: { nextTurn, get hasPending() { return nextTurn.length > 0; } },
    followup(message) {
      nextTurn.push(message);
      log.push({ seq: log.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [message] } });
    },
    steer() { throw new Error('notification stole active user turn'); },
  };
  let current = agent;
  let flushHook = async () => {};
  const ctx = {
    agents: { get: (id) => id === 'parent' ? current : undefined },
    sessions: { flush: async () => { await flushHook(); stored = [...log]; return true; } },
    sessionPersistence: { open: async (id, access) => {
      assert.equal(id, 'parent'); assert.equal(access, 'read');
      return { header: { id: 'parent', createdAt: 1000 },
        read: async (offset, length) => ({ events: stored.slice(offset, offset + length) }), close: async () => {} };
    } },
  };
  const owner = { parent_session_id: 'parent', parent_created_at: 1000, delivery_cursor: 0 };
  const notice = { notice_id: 'notice-one', task_id: 'inert', command_id: 'one', generation: '1:1:1', state: 'done' };
  return { ctx, agent, owner, notice, log, nextTurn,
    replace: (a) => { current = a; }, flushHook: (fn) => { flushHook = fn; } };
}

test('idle parent receives one ordinary followup with ledger verification request', async () => {
  const h = fixture(); const transport = createHostDelivery(h.ctx);
  const result = await transport.deliver(h.owner, h.notice);
  assert.equal(result.status, 'delivered');
  assert.equal(h.nextTurn.length, 1);
  assert.match(h.nextTurn[0].content[0].text, /warroom_status/);
  assert.match(h.nextTurn[0].content[0].text, /1:1:1/);
  assert.equal(h.nextTurn[0].source.kind, 'warroom-task-notice');
});

test('busy parent or queued user input is handled before completion notification', async () => {
  const h = fixture(); const transport = createHostDelivery(h.ctx);
  h.agent.status = 'running';
  assert.equal((await transport.deliver(h.owner, h.notice)).status, 'pending');
  h.agent.status = 'idle'; h.nextTurn.push({ id: 'user-interjection' });
  assert.equal((await transport.deliver(h.owner, h.notice)).status, 'pending');
  assert.equal(h.nextTurn[0].id, 'user-interjection');
  h.nextTurn.shift();
  assert.equal((await transport.deliver(h.owner, h.notice)).status, 'delivered');
  assert.equal(h.nextTurn.length, 1);
});

test('accepted notification with lost acknowledgement is deduped after reload even after consumption', async () => {
  const h = fixture();
  const initial = await createHostDelivery(h.ctx).deliver(h.owner, h.notice);
  assert.equal(initial.status, 'delivered');
  h.nextTurn.shift();
  const replay = await createHostDelivery(h.ctx).deliver(h.owner, h.notice);
  assert.equal(replay.status, 'delivered');
  assert.equal(h.nextTurn.length, 0, 'consumed notice must not be sent twice');
  assert.equal(h.log.length, 1);
});

test('missing or destroyed parent stays pending and another identity is never addressed', async () => {
  const h = fixture(); h.replace(undefined);
  assert.equal((await createHostDelivery(h.ctx).deliver(h.owner, h.notice)).status, 'pending');
  h.replace({ ...h.agent, session: { header: { id: 'parent', createdAt: 2000 } } });
  assert.equal((await createHostDelivery(h.ctx).deliver(h.owner, h.notice)).status, 'blocked');
  assert.equal(h.nextTurn.length, 0);
});

test('agent replacement or user arrival during flush prevents stale delivery', async () => {
  for (const replace of [true, false]) {
    const h = fixture();
    h.flushHook(async () => {
      if (replace) h.replace({ ...h.agent });
      else h.nextTurn.push({ id: 'user-arrived-during-flush' });
    });
    assert.equal((await createHostDelivery(h.ctx).deliver(h.owner, h.notice)).status, 'pending');
    assert.equal(h.log.length, 0);
  }
});

test('authorization revoked during asynchronous flush cannot send success notification', async () => {
  const h = fixture(); let valid = true;
  h.flushHook(async () => { valid = false; });
  const r = await createHostDelivery(h.ctx).deliver(h.owner, h.notice, () => valid);
  assert.notEqual(r.status, 'delivered');
  assert.equal(h.log.length, 0);
});

test('flush failure after enqueue keeps acknowledgement pending and next attempt does not duplicate', async () => {
  const h = fixture(); let flushes = 0;
  h.flushHook(async () => { if (++flushes === 2) throw new Error('durability lost'); });
  const delivery = createHostDelivery(h.ctx);
  await assert.rejects(delivery.deliver(h.owner, h.notice), /durability lost/);
  assert.equal(h.nextTurn.length, 1);
  h.flushHook(async () => {});
  assert.equal((await delivery.deliver(h.owner, h.notice)).status, 'delivered');
  assert.equal(h.nextTurn.length, 1);
  assert.equal(h.log.length, 1);
});

test('without persistence/flush capability no transport claims delivery', () => {
  assert.equal(createHostDelivery({ agents: { get() {} } }), null);
});
