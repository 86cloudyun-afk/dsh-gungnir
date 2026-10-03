// Inert file evidence only: no driver constructor, dispatch, responder, listener or model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBridgeDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-identity-inert-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const driver = Object.assign(Object.create(FileBridgeDriver.prototype), {
    inbox: root, outbox: root, background: false, generations: new Map([['target-task', '1:1:1']]),
    timeoutMs: 1000, pollMs: 1,
  });
  return { driver, root };
}
const methods = [
  { method: 'statusOf', suffix: 'status', fields: { state: 'running', generation: '1:1:1' } },
  { method: 'collectReceipt', suffix: 'facts', fields: { generation: '1:1:1', members: [
    { entity_type: 'asset', source_id: 'inert-foreign-record', revision_no: 1, content_hash: 'inert-hash', payload: { label: 'literal fixture data' } },
  ] } },
  { method: 'collectFacts', suffix: 'facts', fields: { generation: '1:1:1', members: [{ payload: { label: 'literal fixture data' } }] } },
];
for (const { method, suffix, fields } of methods) for (const [name, external_id, code] of [
  ['foreign', 'another-task', 'E_APPROVAL_MISMATCH'],
  ['missing', undefined, 'E_GATE_MISSING_TUPLE'],
  ['empty', '', 'E_GATE_MISSING_TUPLE'],
  ['numeric', 7, 'E_GATE_MISSING_TUPLE'],
  ['object', { id: 'target-task' }, 'E_GATE_MISSING_TUPLE'],
]) {
  test(`${method} rejects ${name} external identity without returning or rewriting evidence`, (t) => {
    const { driver, root } = fixture(t);
    const path = join(root, `target-task.${suffix}.json`);
    const original = JSON.stringify({ external_id, ...fields });
    writeFileSync(path, original);
    assert.throws(() => driver[method]('target-task'), { code });
    assert.equal(readFileSync(path, 'utf8'), original);
  });
}
for (const { method, suffix, fields } of methods) test(`${method} preserves correctly bound source evidence`, (t) => {
  const { driver, root } = fixture(t);
  writeFileSync(join(root, `target-task.${suffix}.json`), JSON.stringify({ external_id: 'target-task', ...fields }));
  const result = driver[method]('target-task');
  assert.deepEqual(result, method === 'collectFacts' ? fields.members
    : method === 'statusOf' ? { ...fields, event_seq: undefined } : fields);
});
for (const value of ['null', '[]', '{invalid JSON']) test(`bridge evidence ${value} is rejected explicitly`, (t) => {
  const { driver, root } = fixture(t);
  writeFileSync(join(root, 'target-task.status.json'), value);
  assert.throws(() => driver.statusOf('target-task'), { code: 'E_GATE_MISSING_TUPLE' });
});
test('an absent status remains unknown and absent facts never fabricate a generation', (t) => {
  const { driver } = fixture(t);
  assert.equal(driver.statusOf('target-task'), null);
  assert.deepEqual(driver.collectReceipt('target-task'), { generation: undefined, members: [] });
  assert.deepEqual(driver.collectFacts('target-task'), []);
});
test('synchronous status wait rejects foreign identity instead of acknowledging another task', (t) => {
  const { driver, root } = fixture(t);
  const path = join(root, 'target-task.status.json');
  writeFileSync(path, JSON.stringify({ external_id: 'another-task', state: 'done' }));
  assert.throws(() => driver._awaitFile(path, 'spawn', 'target-task'), { code: 'E_APPROVAL_MISMATCH' });
});
test('legacy stop probes cannot confirm another task resources', (t) => {
  const { driver, root } = fixture(t);
  writeFileSync(join(root, 'target-task.probes.json'), JSON.stringify({ external_id: 'another-task', generation: '1:1:1',
    resources: [{ id: 'target-task-session', kind: 'session', stopped: true }] }));
  assert.throws(() => driver.probes('target-task'), { code: 'E_APPROVAL_MISMATCH' });
});
test('background observation keeps its existing foreign-evidence rejection', (t) => {
  const { driver, root } = fixture(t);
  driver.background = true;
  writeFileSync(join(root, 'target-task.status.json'), JSON.stringify({ external_id: 'another-task', state: 'done', generation: '1:1:1', event_seq: 1 }));
  assert.equal(driver.observationOf('target-task'), null);
});
