// Broker command APIs must bind to the caller's engagement_id (ADR-001 side-effect channel).
// Cross-engagement cancel/collect/status/reconcile/settle/heartbeat previously mutated the
// real command while writing gate_log into the wrong campaign store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { ERR } from '../packages/shared-types/src/index.js';

function twoCampaigns(t, { faults = {} } = {}) {
  const h = harness({ faults });
  const other = h.broker.createEngagement({
    user_message_id: 'um-other',
    targets: ['10.0.0.0/24'],
  });
  const started = h.broker.execute({
    ...h.base,
    command_id: 'own-cmd-1',
    contract: h.contract({ resources: faults.containerResidue ? ['container'] : [] }),
  });
  t.after(() => {
    for (const { db } of h.broker.engagements.values()) db.close();
    h.broker.global.close();
  });
  return { h, other, started };
}

function snapshot(h, taskId) {
  const cmd = h.broker._findCommand(taskId);
  return {
    command: cmd ? { ...cmd } : null,
    adapter: JSON.stringify([...h.adapter.tasks.values()]),
    gatesOwner: h.broker._eng(h.eng.engagement_id).db
      .prepare('SELECT decision, detail FROM gate_log ORDER BY id').all(),
    gatesOther: null,
  };
}

function denied(h, otherEng, fn, code = ERR.E_APPROVAL_MISMATCH) {
  const before = snapshot(h, 'own-cmd-1');
  // Capture other gates only if that engagement store already exists.
  const otherDir = join(h.home, 'engagements', otherEng);
  const otherBefore = existsSync(otherDir)
    ? h.broker._eng(otherEng).db.prepare('SELECT decision, detail FROM gate_log ORDER BY id').all()
    : null;
  assert.throws(fn, { code });
  const after = snapshot(h, 'own-cmd-1');
  assert.deepEqual(after.command, before.command, 'denial must not mutate command ledger');
  assert.equal(after.adapter, before.adapter, 'denial must not mutate adapter tasks');
  assert.deepEqual(after.gatesOwner, before.gatesOwner, 'denial must not write owner gate_log');
  if (otherBefore) {
    const otherAfter = h.broker._eng(otherEng).db
      .prepare('SELECT decision, detail FROM gate_log ORDER BY id').all();
    assert.deepEqual(otherAfter, otherBefore, 'denial must not write foreign gate_log');
  } else {
    assert.equal(existsSync(otherDir), false, 'denial must not create foreign engagement storage');
  }
}

for (const idKind of ['task', 'command']) {
  test(`cancel rejects another engagement using ${idKind} id without side effects`, (t) => {
    const { h, other, started } = twoCampaigns(t);
    const id = idKind === 'task' ? started.task_id : 'own-cmd-1';
    denied(h, other.engagement_id, () => h.broker.cancel(other.engagement_id, id, 'cross'));
  });
}

test('cancel rejects unknown engagement id without creating its store', (t) => {
  const { h, started } = twoCampaigns(t);
  denied(h, 'eng_unknown_owner', () => h.broker.cancel('eng_unknown_owner', started.task_id, 'cross'));
});

test('cancel still works for the owning engagement', (t) => {
  const { h, started } = twoCampaigns(t);
  const out = h.broker.cancel(h.eng.engagement_id, started.task_id, 'owner');
  assert.equal(out.state, 'confirmed_stopped');
});

test('collect rejects another engagement before opening its store', (t) => {
  const { h, other, started } = twoCampaigns(t);
  const receipt = h.adapter.collect(started.task_id);
  denied(h, other.engagement_id,
    () => h.broker.collect(other.engagement_id, started.task_id, receipt));
});

test('collect still works for the owning engagement', (t) => {
  const { h, started } = twoCampaigns(t);
  const receipt = h.adapter.collect(started.task_id);
  const out = h.broker.collect(h.eng.engagement_id, started.task_id, receipt);
  assert.equal(out.accepted, true);
});

test('status rejects another engagement', (t) => {
  const { h, other, started } = twoCampaigns(t);
  denied(h, other.engagement_id, () => h.broker.status(other.engagement_id, started.task_id));
});

test('status still works for the owning engagement', (t) => {
  const { h, started } = twoCampaigns(t);
  const st = h.broker.status(h.eng.engagement_id, started.task_id);
  assert.equal(st.engagement_id, h.eng.engagement_id);
  assert.equal(st.ledger_state, 'running');
});

test('reconcile rejects another engagement without mutating ledger', (t) => {
  const { h, other, started } = twoCampaigns(t);
  h.broker._setCommandState('own-cmd-1', 'unknown');
  denied(h, other.engagement_id, () => h.broker.reconcile(other.engagement_id, started.task_id));
});

test('settle rejects another engagement without mutating ledger', (t) => {
  const { h, other, started } = twoCampaigns(t);
  denied(h, other.engagement_id, () => h.broker.settle(other.engagement_id, started.task_id));
});

test('heartbeat rejects another engagement without mutating ledger', (t) => {
  const { h, other, started } = twoCampaigns(t);
  denied(h, other.engagement_id, () => h.broker.heartbeat(other.engagement_id, started.task_id));
});

test('heartbeat still works for the owning engagement', (t) => {
  const { h, started } = twoCampaigns(t);
  const out = h.broker.heartbeat(h.eng.engagement_id, started.task_id, { note: 'ok' });
  assert.equal(out.task_id, started.task_id);
  assert.ok(out.heartbeat_at);
});
