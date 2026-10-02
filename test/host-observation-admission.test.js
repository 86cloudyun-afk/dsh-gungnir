// Only synthetic homes and in-memory fake/local drivers; bridge is registered but never dispatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWarroomService } from '../packages/warroom-plugin/src/service.js';
import { dshTools } from '../packages/warroom-plugin/src/tools.js';

const parent = { session_id: 'inert-parent', created_at: 1000 };
function fixture(t, adapterKind) {
  const home = mkdtempSync(join(tmpdir(), 'host-observation-admission-'));
  const service = createWarroomService({ home, ...(adapterKind ? { adapterKind } : {}), autoStart: false,
    hostDelivery: { deliver: async () => ({ status: 'pending' }) } });
  t.after(async () => { await service.dispose(); rmSync(home, { recursive: true, force: true }); });
  const auth = service.broker.createEngagement({ user_message_id: 'inert-admission', targets: ['example.test'],
    overrides: { action_class_limit: 'destructive' } });
  const approval = service.broker.createApproval({ engagement_id: auth.engagement_id });
  const req = { engagement_id: auth.engagement_id, auth_version: 1, command_id: 'inert-admission',
    manual_approval_token: approval.approval_id,
    contract: { targets: ['example.test'], action_class: 'destructive', wire_cost: 1, resources: [] } };
  return { service, req, approval };
}
for (const kind of [undefined, 'local']) for (const entry of ['broker', 'native']) {
  test(`${kind ?? 'default fake'} ${entry} rejects deferred work before ledger, approval and rate mutation`, (t) => {
    const { service, req, approval } = fixture(t, kind);
    const invoke = entry === 'broker'
      ? () => service.broker.execute(req, { deferDispatch: true, parent })
      : () => dshTools(service).find((tool) => tool.name === 'warroom_execute').execute(req,
        { agent: { id: parent.session_id, session: { header: { id: parent.session_id, createdAt: parent.created_at } } } });
    assert.throws(invoke, { code: 'E_HOST_OBSERVATION_UNSUPPORTED' });
    const db = service.broker.global;
    assert.equal(db.prepare('SELECT count(*) n FROM command_queue').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM task_owners').get().n, 0);
    assert.equal(db.prepare('SELECT used_by_command FROM approvals WHERE approval_id = ?').get(approval.approval_id).used_by_command, null);
    assert.equal(service.broker._eng(req.engagement_id).store.rateTotal('tool'), 0);
    assert.equal(service.broker._eng(req.engagement_id).store.rateTotal('wire'), 0);
    assert.equal(service.broker.dispatchCounter, 0);
    assert.equal(service.broker.adapter.lookup(req.command_id), null);
  });
}
for (const kind of [undefined, 'local']) test(`${kind ?? 'default fake'} retains synchronous tool/CLI dispatch`, (t) => {
  const { service, req } = fixture(t, kind);
  const result = dshTools(service).find((tool) => tool.name === 'warroom_execute').execute(req);
  assert.equal(result.state, 'running');
  assert.ok(service.broker.adapter.lookup(req.command_id));
  assert.equal(service.broker.global.prepare('SELECT count(*) n FROM task_owners').get().n, 0);
});
test('supported bridge accepts queued native work without starting a worker', (t) => {
  const { service, req } = fixture(t, 'bridge');
  const result = dshTools(service).find((tool) => tool.name === 'warroom_execute').execute(req,
    { agent: { id: parent.session_id, session: { header: { id: parent.session_id, createdAt: parent.created_at } } } });
  assert.equal(result.state, 'queued');
  assert.equal(service.broker.global.prepare('SELECT count(*) n FROM task_owners').get().n, 1);
  assert.equal(service.broker.adapter.lookup(req.command_id), null);
  assert.equal(service.broker.adapter.driver.pendingJobs().length, 0);
});
