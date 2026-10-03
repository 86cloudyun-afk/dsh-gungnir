// ADR-001 D3: trusted host/CLI setup; synthetic homes, inert adapter and probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import { createWarroomService } from '../packages/warroom-plugin/src/service.js';
import { dshTools } from '../packages/warroom-plugin/src/tools.js';
import { toToolDefinition } from '../packages/warroom-plugin/src/dsh-entry.mjs';
import { ERR } from '../packages/shared-types/src/index.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const close = (svc) => { for (const { db } of svc.broker.engagements.values()) db.close(); svc.broker.global.close(); };
function fresh(t, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wr-host-auth-'));
  const c = { home, svc: createWarroomService({ home, adapterKind: 'fake', autoStart: false, ...opts }) };
  t.after(async () => { await c.svc.dispose(); rmSync(home, { recursive: true, force: true }); });
  return c;
}
const request = (eng, extra = {}) => ({ engagement_id: eng.engagement_id, auth_version: eng.auth_version, command_id: 'host-reference', action_class: 'active',
  contract: { targets: ['target.example.test'], action_class: 'active', resources: [], wire_cost: 0 }, ...extra });

test('trusted host setup permits model dispatch using an existing authorization reference', (t) => {
  const c = fresh(t);
  const eng = c.svc.broker.createEngagement({ user_message_id: 'trusted-host-fixture', targets: ['target.example.test'] });
  c.svc.jumps.egressProbe = () => ({ ok: true, exit_ip: '203.0.113.9' });
  c.svc.jumps.importHosts([{ id: 'jh-fixture', addr_v4: '203.0.113.9' }]);
  const route = c.svc.jumps.acquire({ engagement_id: eng.engagement_id, target: 'target.example.test' });
  assert.ok(tool('warroom_egress_check').run(c.svc, { engagement_id: eng.engagement_id, action: 'record',
    jumphost_id: 'jh-fixture', exit_ip: '203.0.113.9', route_id: route.route_id, verdict: 'pass' }));
  const out = tool('warroom_execute').run(c.svc, request(eng));
  assert.equal(out.state, 'running');
  assert.equal(c.svc.broker.adapter.lookup('host-reference').task_id, out.task_id);
  assert.notEqual(tool('warroom_preflight').run(c.svc, { engagement_id: eng.engagement_id }).verdict, 'blocked');
});

test('schema-valid native model wrapper dispatches an existing host authorization reference', async (t) => {
  // Native tools require a real parent context and host observation; this fake source remains inert.
  class ObservableFakeAdapter extends FakeAdapter { observe() { return null; } }
  const c = fresh(t, { adapter: new ObservableFakeAdapter(),
    hostDelivery: { deliver: async () => ({ status: 'pending' }) } });
  const eng = c.svc.broker.createEngagement({ user_message_id: 'trusted-wrapper-fixture', targets: ['target.example.test'] });
  const args = request(eng);
  const definition = toToolDefinition(dshTools(c.svc).find((d) => d.name === 'warroom_execute'));
  for (const field of ['command_id', 'engagement_id', 'auth_version', 'action_class', 'contract']) {
    assert.ok(Object.hasOwn(args, field), `model request must include schema-required ${field}`);
  }
  assert.equal(args.action_class, 'active');
  const out = await definition.execute(args, {
    agent: { id: 'inert-parent', session: { header: { id: 'inert-parent', createdAt: 1000 } } },
  });
  assert.equal(out.state, 'queued');
  assert.equal(c.svc.broker.adapter.lookup('host-reference'), null);
  await c.svc.tasks.tick();
  assert.equal(c.svc.broker.adapter.lookup('host-reference').task_id, out.task_id);
});

test('host authorization id/version/hash/scope survive reopening without a model engage call', (t) => {
  const c = fresh(t);
  const eng = c.svc.broker.createEngagement({ user_message_id: 'trusted-restart-fixture', targets: ['target.example.test'] });
  const before = c.svc.broker._auth(eng.engagement_id).row;
  close(c.svc);
  c.svc = createWarroomService({ home: c.home, adapterKind: 'fake' });
  const after = c.svc.broker._auth(eng.engagement_id).row;
  for (const key of ['id', 'auth_version', 'auth_hash', 'auth_object', 'target_scope', 'user_message_id']) assert.equal(after[key], before[key], key);
  assert.deepEqual(JSON.parse(after.target_scope), ['target.example.test']);
  assert.equal(tool('warroom_execute').run(c.svc, request(eng)).state, 'running');
});

test('trusted CLI engage remains compatible with model reference dispatch', (t) => {
  const c = fresh(t);
  const eng = JSON.parse(execFileSync(process.execPath, ['bin/warroom.mjs', 'engage', '--targets', 'target.example.test',
    '--user-msg', 'trusted-cli-fixture', '--home', c.home, '--json'], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: '', DSH_PROFILE_DIR: '', WARROOM_HOME: '' } }));
  assert.equal(eng.auth_version, 1);
  const { row } = c.svc.broker._auth(eng.engagement_id);
  assert.equal(row.user_message_id, 'trusted-cli-fixture');
  assert.match(row.auth_hash, /^[0-9a-f]{64}$/);
  assert.equal(tool('warroom_execute').run(c.svc, request(eng)).state, 'running');
});

test('model execution with no existing authorization cannot create an authorization record', (t) => {
  const c = fresh(t);
  assert.throws(() => tool('warroom_execute').run(c.svc, request({ engagement_id: 'eng_missing', auth_version: 1 })), { code: ERR.E_TASK_NOT_FOUND });
  assert.equal(c.svc.broker._eng('eng_missing').db.prepare('SELECT count(*) AS n FROM engagements').get().n, 0);
  assert.equal(c.svc.broker.adapter.tasks.size, 0);
});

for (const [label, overrides, change, code] of [
  ['scope mismatch', {}, { contract: { targets: ['outside.example.test'], action_class: 'active', resources: [], wire_cost: 0 } }, ERR.E_GATE_OUT_OF_SCOPE],
  ['version mismatch', {}, { auth_version: 2 }, ERR.E_GATE_AUTH_EXPIRED],
  ['closed window', { window_end: '2000-01-01T00:00:00.000Z' }, {}, ERR.E_GATE_WINDOW_CLOSED],
  ['class exceeds limit', { action_class_limit: 'readonly' }, {}, ERR.E_GATE_CLASS_EXCEEDS_LIMIT],
  ['destructive without approval', {}, { contract: { targets: ['target.example.test'], action_class: 'destructive', resources: [], wire_cost: 0 } }, ERR.E_GATE_DESTRUCTIVE_NEEDS_APPROVAL],
]) test(`existing model reference still refuses ${label}`, (t) => {
  const c = fresh(t);
  const eng = c.svc.broker.createEngagement({ user_message_id: 'trusted-negative-fixture', targets: ['target.example.test'], overrides });
  assert.throws(() => tool('warroom_execute').run(c.svc, request(eng, change)), { code });
  assert.equal(c.svc.broker.adapter.tasks.size, 0);
});

test('revoked authorization cannot be revived by a stale model reference', (t) => {
  const c = fresh(t);
  const eng = c.svc.broker.createEngagement({ user_message_id: 'trusted-revoke-fixture', targets: ['target.example.test'] });
  c.svc.broker.revoke(eng.engagement_id, 'fixture revocation');
  assert.throws(() => tool('warroom_execute').run(c.svc, request(eng)), { code: ERR.E_GATE_AUTH_EXPIRED });
  assert.equal(c.svc.broker.adapter.tasks.size, 0);
});
