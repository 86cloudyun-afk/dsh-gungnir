// The queued boundary must not bypass #167's malformed-current-authorization refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';

const invalid = [
  ['unknown class', { action_class_limit: 'invalid' }],
  ['null class', { action_class_limit: null }],
  ['missing class', { action_class_limit: undefined }],
  ['empty class', { action_class_limit: '' }],
  ['invalid start', { window_start: 'invalid' }],
  ['invalid end', { window_end: 'invalid' }],
  ['invalid clock', null],
];
function fixture(t) {
  const h = harness();
  h.adapter.observe = () => null; // Explicit inert source for queued authorization tests, not Fake product support.
  h.result = h.broker.execute({ ...h.base, command_id: 'malformed-host', contract: h.contract({ wire_cost: 0 }) },
    { deferDispatch: true, parent: { session_id: 'inert-parent', created_at: 1000 } });
  t.after(() => {
    for (const { db } of h.broker.engagements.values()) db.close();
    h.broker.global.close(); rmSync(h.home, { recursive: true, force: true });
  });
  return h;
}
function change(h, patch) {
  if (!patch) { h.broker._nowMs = () => NaN; return; }
  const auth = { ...h.broker._auth(h.eng.engagement_id).auth, ...patch };
  h.broker._eng(h.eng.engagement_id).db.prepare('UPDATE engagements SET auth_object = ? WHERE id = ?')
    .run(JSON.stringify(auth), h.eng.engagement_id);
}
for (const [label, patch] of invalid) {
  test(`integration: queued host refuses ${label} before first adapter dispatch`, (t) => {
    const h = fixture(t); change(h, patch);
    h.broker.dispatchQueued('malformed-host');
    assert.equal(h.adapter.tasks.size, 0, 'invalid current authority cannot start a worker');
    assert.equal(h.broker._findCommand(h.result.task_id).state, 'cancel_requested');
    assert.equal(h.broker.global.prepare('SELECT dispatch_attempted FROM task_owners').get().dispatch_attempted, 0);
  });
  test(`integration: host completion under ${label} cannot ingest effective facts`, (t) => {
    const h = fixture(t); h.broker.dispatchQueued('malformed-host'); change(h, patch);
    const generation = h.result.generation;
    const receipt = { receipt_id: 'inert-final', generation,
      members: [{ entity_type: 'asset', source_id: 'inert-source', revision_no: 1, content_hash: 'inert-hash', payload: {} }] };
    const result = h.broker.collectHostObservation(h.eng.engagement_id, h.result.task_id,
      { state: 'done', generation, event_seq: 1, receipt });
    assert.equal(result.accepted, false);
    assert.equal(result.quarantined, 'authorization');
    assert.equal(h.store().effectiveCount(), 0);
  });
}
