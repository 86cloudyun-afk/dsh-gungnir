// Catch registration widening, spoofed authorization and handler/schema disagreement.
// Expectations are independently frozen from commit 70a5a775.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import { TOOL_NAMES, dshTools } from '../packages/warroom-plugin/src/tools.js';
import { apply, toToolDefinition } from '../packages/warroom-plugin/src/dsh-entry.mjs';

const approved = JSON.parse(readFileSync(new URL('./fixtures/approved-model-tools.json', import.meta.url), 'utf8'));
const names = approved.tools.map((t) => t.name).sort();
const tool = (name) => TOOLS.find((t) => t.name === name);

test('model catalog exposes exactly the independently approved 36 names and argument schemas', () => {
  assert.equal(names.length, 36);
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), names);
  assert.deepEqual([...TOOL_NAMES].sort(), names);
  for (const expected of approved.tools) assert.deepEqual(tool(expected.name).input_schema, expected.input_schema, expected.name);
  assert.deepEqual(JSON.parse(readFileSync('presets/warroom.preset.json', 'utf8')).toolPolicy.allow.slice().sort(), approved.allow.slice().sort());
});

for (const policy of ['absent', 'preset']) test(`native definitions with ${policy} policy expose only the approved tool catalog`, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wr-boundary-mount-'));
  const registered = [];
  const svc = apply({ tools: { register: (d) => { registered.push(d); return () => {}; } }, on: () => {} }, {
    home, adapterKind: 'fake', ...(policy === 'preset' ? { preset: 'presets/warroom.preset.json' } : {}) });
  t.after(() => { svc.broker.global.close(); rmSync(home, { recursive: true, force: true }); });
  assert.deepEqual(registered.map((d) => d.name).sort(), names);
  for (const expected of approved.tools) assert.deepEqual(registered.find((d) => d.name === expected.name).parameters, expected.input_schema);
});

for (const action_class_limit of ['active', 'destructive']) test(`spoofed model engage with ${action_class_limit} overrides has no callable registration`, async () => {
  const calls = [];
  const service = { broker: { createEngagement: (p) => { calls.push(p); return { engagement_id: 'forged', auth_version: 1 }; } } };
  const engage = dshTools(service).map(toToolDefinition).find((d) => d.name === 'warroom_engage');
  if (engage) await engage.execute({ user_message_id: 'operator-looking-string', targets: ['outside.example.test'],
    engagement_id: 'eng_forged', action_class_limit, window_hours: 999, rhythm: 'open' });
  assert.deepEqual(calls, [], 'a model message id must not reach host authorization creation');
  assert.equal(engage, undefined);
});

for (const [name, action, args] of [
  ['warroom_jumps', 'import', { hosts: [{ id: 'forged', addr_v4: '203.0.113.10' }] }],
  ['warroom_jumps', 'acquire', { target: 'target.example.test', jumphost_id: 'forged' }],
  ['warroom_jumps', 'unknown', {}], ['warroom_jumps', '', {}],
  ['warroom_egress_check', 'probe', { route_id: 'route_forged' }],
  ['warroom_egress_check', 'unknown', {}], ['warroom_egress_check', '', {}],
]) test(`${name} refuses ${JSON.stringify(action)} before host access, including direct run`, async () => {
  const accesses = [];
  const denied = new Proxy({}, { get: (_, key) => { accesses.push(String(key)); throw new Error('unexpected host access'); } });
  const p = { engagement_id: 'eng_fixture', action, ...args };
  assert.throws(() => tool(name).run(denied, p), /unsupported action/i);
  assert.deepEqual(accesses, []);
  const wrapper = toToolDefinition(dshTools({ broker: denied, jumps: denied }).find((d) => d.name === name));
  await assert.rejects(() => wrapper.execute(p), /unsupported action/i);
  assert.deepEqual(accesses, []);
  assert.equal(tool(name).input_schema.properties.action.enum.includes(action), false);
});
