import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBridgeDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';
import { RedteamModeAdapter } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { createWarroomService } from '../packages/warroom-plugin/src/service.js';
import { dshTools } from '../packages/warroom-plugin/src/tools.js';
import { toToolDefinition } from '../packages/warroom-plugin/src/dsh-entry.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const once = (root, args = []) => spawnSync(process.execPath,
  ['scripts/dsh-bridge-responder.mjs', '--root', root, '--once', ...args], { encoding: 'utf8', timeout: 3000 });
const job = (root, id = 'inert') => {
  mkdirSync(join(root, 'outbox'), { recursive: true });
  writeFileSync(join(root, 'outbox', `${id}.job.json`), JSON.stringify({ protocol: 'gungnir-bridge/1',
    external_id: id, role: 'assess', background: true, contract: { task_id: id, generation: '1:1:1', resources: [] } }));
};
const until = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('inert fixture did not reach expected boundary');
};

test('host responder publishes generation on every source envelope and final sequence after facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-responder-'));
  job(root); const r = once(root); assert.equal(r.status, 0, r.stderr);
  for (const suffix of ['status', 'facts', 'probes']) {
    const result = read(join(root, 'inbox', `inert.${suffix}.json`));
    assert.equal(result.generation, '1:1:1');
    assert.equal(result.external_id, 'inert');
  }
  const state = read(join(root, 'inbox', 'inert.status.json'));
  assert.equal(state.state, 'done');
  assert.equal(state.event_seq, 2);
});

test('responder durable claim prevents duplicate executor action across process restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-claim-'));
  const executor = join(root, 'inert.mjs');
  writeFileSync(executor, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
export default {async run(job) { const path=${JSON.stringify(join(root, 'count'))};
writeFileSync(path,String(existsSync(path)?Number(readFileSync(path))+1:1));
return {generation:job.contract.generation,members:[],resources:[]}; }};`);
  job(root);
  assert.equal(once(root, ['--executor', executor]).status, 0);
  assert.equal(once(root, ['--executor', executor]).status, 0);
  assert.equal(readFileSync(join(root, 'count'), 'utf8'), '1');
});

test('completed source publication lost before host observation is replayed without executor rerun', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-publication-'));
  const executor = join(root, 'inert.mjs');
  writeFileSync(executor, "export default {run(job){return {generation:job.contract.generation,members:[],resources:[]}}};");
  job(root); assert.equal(once(root, ['--executor', executor]).status, 0);
  const original = read(join(root, 'inbox', 'inert.status.json'));
  unlinkSync(join(root, 'inbox', 'inert.status.json'));
  writeFileSync(executor, "export default {run(){throw new Error('REEXECUTED')}};");
  const restart = once(root, ['--executor', executor]);
  assert.doesNotMatch(restart.stderr, /REEXECUTED/);
  const restored = read(join(root, 'inbox', 'inert.status.json'));
  assert.equal(restored.state, 'done');
  assert.equal(restored.event_seq, original.event_seq);
  assert.equal(read(join(root, 'inbox', 'inert.facts.json')).event_seq, restored.event_seq);
});

test('second responder with a stale claimed snapshot cannot overwrite completion publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-publication-race-'));
  const executor = join(root, 'inert.mjs'); const preload = join(root, 'pause-claim.mjs');
  const started = join(root, 'started'); const releaseA = join(root, 'release-a');
  const paused = join(root, 'paused'); const releaseB = join(root, 'release-b');
  writeFileSync(executor, `import {existsSync,writeFileSync} from 'node:fs';
export default {async run(job){writeFileSync(${JSON.stringify(started)},'1');
while(!existsSync(${JSON.stringify(releaseA)})) await new Promise(r=>setTimeout(r,10));
return {generation:job.contract.generation,members:[],resources:[]}}};`);
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync; let once=false;
fs.readFileSync=function(path,...args){const value=read.call(this,path,...args);
if(!once&&String(path)===${JSON.stringify(join(root, 'claims', 'inert.json'))}){once=true;
fs.writeFileSync(${JSON.stringify(paused)},'1');
while(!fs.existsSync(${JSON.stringify(releaseB)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
return value;}; syncBuiltinESMExports();`);
  job(root);
  const a = spawn(process.execPath, ['scripts/dsh-bridge-responder.mjs', '--root', root,
    '--executor', executor, '--interval', '10'], { stdio: 'ignore' });
  const aExited = new Promise((r) => a.once('exit', r));
  let b; let bExited;
  try {
    await until(() => existsSync(started));
    b = spawn(process.execPath, ['--import', preload, 'scripts/dsh-bridge-responder.mjs', '--root', root, '--once'], { stdio: 'ignore' });
    bExited = new Promise((r) => b.once('exit', r)); await until(() => existsSync(paused));
    writeFileSync(releaseA, '1');
    await until(() => read(join(root, 'inbox', 'inert.status.json')).state === 'done');
    writeFileSync(releaseB, '1'); await bExited;
    assert.equal(read(join(root, 'inbox', 'inert.status.json')).state, 'done');
    once(root);
    assert.equal(read(join(root, 'inbox', 'inert.status.json')).state, 'done');
  } finally {
    writeFileSync(releaseA, '1'); writeFileSync(releaseB, '1');
    a.kill('SIGTERM'); await aExited;
    if (b && b.exitCode === null && b.signalCode === null) b.kill('SIGTERM');
    await bExited;
  }
});

test('claimed inert worker killed before receipt stays unknown after restart without rerunning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-crash-'));
  const executor = join(root, 'inert.mjs');
  writeFileSync(executor, `import {writeFileSync} from 'node:fs';
export default {async run(job) { writeFileSync(${JSON.stringify(join(root, 'started'))},'1');
await new Promise(()=>{}); return {generation:job.contract.generation,members:[],resources:[]}; }};`);
  job(root);
  const child = spawn(process.execPath, ['scripts/dsh-bridge-responder.mjs', '--root', root,
    '--executor', executor, '--interval', '10'], { stdio: 'ignore' });
  try { await until(() => existsSync(join(root, 'started'))); }
  finally { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
  writeFileSync(executor, "export default {run(){throw new Error('REEXECUTED')}};");
  const restarted = once(root, ['--executor', executor]);
  assert.doesNotMatch(restarted.stderr, /REEXECUTED/);
  assert.equal(read(join(root, 'inbox', 'inert.status.json')).state, 'unknown');
});

test('executor stop request never fabricates resource proof, including restart into echo mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-proof-'));
  const executor = join(root, 'inert.mjs');
  writeFileSync(executor, `export default {run(job) {return {generation:job.contract.generation,members:[],
resources:[{id:job.external_id+'-session',kind:'session',stopped:false}]}}};`);
  job(root); once(root, ['--executor', executor]);
  writeFileSync(join(root, 'outbox', 'inert.stop.json'), JSON.stringify({ protocol: 'gungnir-bridge/1',
    external_id: 'inert', generation: '1:1:1', action: 'stop' }));
  once(root); // A different configuration cannot turn real/executor resources into synthetic ones.
  assert.equal(read(join(root, 'inbox', 'inert.probes.json')).resources[0].stopped, false);
  assert.notEqual(read(join(root, 'inbox', 'inert.status.json')).state, 'confirmed_stopped');
});

test('echo stop publishes fresh sequenced proof beyond the requested source boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-echo-stop-')); job(root); once(root);
  writeFileSync(join(root, 'outbox', 'inert.stop.json'), JSON.stringify({ protocol: 'gungnir-bridge/1',
    external_id: 'inert', generation: '1:1:1', request_id: 'stop-one', after_event_seq: 2, action: 'stop' }));
  once(root);
  const status = read(join(root, 'inbox', 'inert.status.json'));
  const probes = read(join(root, 'inbox', 'inert.probes.json'));
  assert.equal(status.state, 'confirmed_stopped');
  assert.equal(probes.event_seq, status.event_seq); assert.ok(probes.event_seq > 2);
  assert.equal(probes.stop_request_id, 'stop-one');
});

test('executor proof from before cancellation cannot be relabeled as fresh stopped proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-old-stopped-'));
  const executor = join(root, 'inert.mjs');
  writeFileSync(executor, `export default {run(job){return {generation:job.contract.generation,members:[],
resources:[{id:job.external_id+'-session',kind:'session',stopped:true}]}}};`);
  job(root); once(root, ['--executor', executor]);
  writeFileSync(join(root, 'outbox', 'inert.stop.json'), JSON.stringify({ protocol: 'gungnir-bridge/1',
    external_id: 'inert', generation: '1:1:1', request_id: 'stop-one', after_event_seq: 2, action: 'stop' }));
  once(root);
  assert.equal(read(join(root, 'inbox', 'inert.status.json')).state, 'unresolved');
  assert.equal(read(join(root, 'inbox', 'inert.probes.json')).event_seq, 2);
});

test('fixture source with old generation cannot be rewrapped as current task facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-stale-fixture-'));
  const fixtures = join(root, 'fixtures'); mkdirSync(fixtures);
  writeFileSync(join(fixtures, 'inert.facts.json'), JSON.stringify({ generation: 'old', external_id: 'inert', members: [] }));
  writeFileSync(join(fixtures, 'inert.probes.json'), JSON.stringify({ generation: 'old', external_id: 'inert', resources: [] }));
  job(root); const r = once(root, ['--mode', 'fixture', '--fixture', fixtures]);
  assert.match(r.stderr, /generation|identity/);
  assert.equal(existsSync(join(root, 'inbox', 'inert.facts.json')), false);
});

test('inert worker remains running after tool returned and later completion reaches host ledger', async () => {
  const home = mkdtempSync(join(tmpdir(), 'host-e2e-'));
  const root = join(home, 'dsh-bridge');
  const driver = new FileBridgeDriver({ root, background: true });
  const notices = [];
  const svc = createWarroomService({ home, adapter: new RedteamModeAdapter({ driver }), autoStart: false,
    hostDelivery: { deliver: async (_o, n) => { notices.push(n); return { status: 'delivered', cursor: 1 }; } } });
  const eng = svc.broker.createEngagement({ user_message_id: 'inert', targets: ['example.test'] });
  const r = svc.broker.execute({ command_id: 'inert-e2e', engagement_id: eng.engagement_id, auth_version: 1,
    contract: { targets: ['example.test'], action_class: 'readonly', resources: [], wire_cost: 0 } },
  { deferDispatch: true, parent: { session_id: 'parent', created_at: 1000 } });
  assert.equal(r.state, 'queued');
  const executor = join(home, 'inert.mjs');
  writeFileSync(executor, `import {existsSync,writeFileSync} from 'node:fs';
export default {async run(job) {writeFileSync(${JSON.stringify(join(home, 'started'))},'1');
while(!existsSync(${JSON.stringify(join(home, 'release'))})) await new Promise(r=>setTimeout(r,10));
return {generation:job.contract.generation,members:[],resources:[]}; }};`);
  const child = spawn(process.execPath, ['scripts/dsh-bridge-responder.mjs', '--root', root,
    '--executor', executor, '--interval', '10'], { stdio: 'ignore' });
  try {
    await svc.tasks.tick(); await until(() => existsSync(join(home, 'started')));
    assert.equal(notices.length, 0);
    assert.ok(['queued', 'running', 'unknown'].includes(svc.broker._findCommand(r.task_id).state));
    // Independent user work can run while this inert worker owns no parent tool invocation.
    const status = toToolDefinition(dshTools(svc).find((t) => t.name === 'warroom_status'));
    const answer = await status.execute({ engagement_id: eng.engagement_id, task_id: r.task_id },
      { agent: { id: 'parent' }, signal: new AbortController().signal });
    assert.equal(answer.task_id, r.task_id);
    assert.equal(notices.length, 0, 'user request completed while worker still awaits release');
    writeFileSync(join(home, 'release'), '1');
    await until(() => { try { return read(driver._statusPath(r.task_id)).state === 'done'; } catch { return false; } });
    await svc.tasks.tick();
    assert.equal(svc.broker._findCommand(r.task_id).state, 'done');
    assert.equal(notices.length, 1);
  } finally {
    child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); await svc.tasks.dispose();
  }
});
