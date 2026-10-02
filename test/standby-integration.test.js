// Inert integration regressions: no real executor, network, target or model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const responder = 'scripts/dsh-bridge-responder.mjs';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const until = async (predicate, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('inert responder did not reach expected boundary');
};
function fixture(id, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'standby-integration-'));
  mkdirSync(join(root, 'outbox'));
  const job = { protocol: 'gungnir-bridge/1', external_id: id, role: 'assess',
    contract: { generation: '1:7:1', resources: [] }, ...extra };
  writeFileSync(join(root, 'outbox', `${id}.job.json`), JSON.stringify(job));
  return { root, job, status: join(root, 'inbox', `${id}.status.json`),
    facts: join(root, 'inbox', `${id}.facts.json`), probes: join(root, 'inbox', `${id}.probes.json`),
    claim: join(root, 'claims', `${id}.json`), executor: join(root, 'inert.mjs') };
}
function daemon(f) {
  return spawn(process.execPath, [responder, '--root', f.root, '--executor', f.executor, '--interval', '10'], { stdio: 'ignore' });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}
function runOnce(f) {
  const result = spawnSync(process.execPath, [responder, '--root', f.root, '--once', '--executor', f.executor],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('integration: legacy daemon acknowledges a >2s inert job with source generation before completion', async () => {
  const f = fixture('legacy-slow');
  writeFileSync(f.executor, `export default {async run(job) {
    await new Promise(r=>setTimeout(r,2200));
    return {generation:job.contract.generation,members:[],resources:[]}; }};`);
  const child = daemon(f);
  try {
    await until(() => existsSync(f.status), 1500);
    const ack = read(f.status);
    assert.equal(ack.state, 'running');
    assert.equal(ack.generation, f.job.contract.generation);
    assert.ok(Number.isSafeInteger(ack.event_seq));
    assert.equal(existsSync(f.facts), false, 'ack precedes inert completion');
    await until(() => read(f.status).state === 'done');
    for (const p of [f.facts, f.probes]) {
      assert.equal(read(p).generation, ack.generation);
      assert.equal(read(p).event_seq, read(f.status).event_seq);
    }
    assert.equal(read(f.claim).state, 'completed');
  } finally { await stop(child); rmSync(f.root, { recursive: true, force: true }); }
});

test('integration: daemon cancellation never fabricates stopping a source residual resource', async () => {
  const f = fixture('legacy-residual'); const release = join(f.root, 'release');
  const started = join(f.root, 'started');
  writeFileSync(f.executor, `import {existsSync,writeFileSync} from 'node:fs';
    export default {async run(job) { writeFileSync(${JSON.stringify(started)},'1');
    while(!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10));
    return {generation:job.contract.generation,members:[],resources:[{id:'inert-resource',kind:'process',stopped:false}]}; }};`);
  const child = daemon(f);
  try {
    await until(() => existsSync(f.status) && existsSync(started));
    const ack = read(f.status);
    writeFileSync(join(f.root, 'outbox', 'legacy-residual.stop.json'), JSON.stringify({
      protocol: 'gungnir-bridge/1', external_id: f.job.external_id, generation: f.job.contract.generation,
      request_id: 'cancel-original', after_event_seq: ack.event_seq ?? 0 }));
    await until(() => ['unresolved', 'confirmed_stopped'].includes(read(f.status).state));
    writeFileSync(release, '1');
    await until(() => existsSync(f.probes) && read(f.probes).resources.length === 1);
    assert.equal(read(f.probes).resources[0].stopped, false);
    assert.equal(read(f.status).state, 'unresolved');
    assert.equal(read(f.claim).cancel_requested, true);
  } finally { writeFileSync(release, '1'); await stop(child); rmSync(f.root, { recursive: true, force: true }); }
});

test('integration: ambiguous daemon failure remains unknown and its claim prevents restart reexecution', async () => {
  const f = fixture('legacy-error'); const count = join(f.root, 'count');
  writeFileSync(f.executor, `import {appendFileSync} from 'node:fs';
    export default {run() {appendFileSync(${JSON.stringify(count)},'x');throw new Error('inert ambiguous failure');}};`);
  const child = daemon(f);
  try {
    await until(() => existsSync(f.status) && ['unknown', 'failed'].includes(read(f.status).state));
    assert.equal(read(f.status).state, 'unknown');
    assert.equal(existsSync(f.facts), false);
    assert.equal(existsSync(f.claim), true);
    await stop(child); runOnce(f);
    assert.equal(readFileSync(count, 'utf8'), 'x');
    assert.equal(read(f.status).state, 'unknown');
  } finally { await stop(child); rmSync(f.root, { recursive: true, force: true }); }
});

test('integration: legacy --once drains inert work and preserves synchronous running receipt', () => {
  const f = fixture('legacy-once'); const finished = join(f.root, 'finished');
  try {
    writeFileSync(f.executor, `import {writeFileSync} from 'node:fs';export default {async run(job) {
      await new Promise(r=>setTimeout(r,100));writeFileSync(${JSON.stringify(finished)},'1');
      return {generation:job.contract.generation,members:[],resources:[]};}};`);
    runOnce(f);
    assert.equal(existsSync(finished), true);
    assert.equal(read(f.status).state, 'running');
    assert.equal(read(f.claim).state, 'completed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('integration: old source generation is not restamped and rejected work is not rerun', () => {
  const f = fixture('old-generation', { background: true }); const count = join(f.root, 'count');
  try {
    writeFileSync(f.executor, `import {appendFileSync} from 'node:fs';export default {run() {
      appendFileSync(${JSON.stringify(count)},'x');return {generation:'1:7:0',members:[],resources:[]};}};`);
    runOnce(f); runOnce(f);
    assert.equal(readFileSync(count, 'utf8'), 'x');
    assert.equal(read(f.status).state, 'unknown');
    assert.equal(existsSync(f.facts), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('integration: source receipt without generation cannot create facts', () => {
  const f = fixture('missing-generation', { background: true });
  try {
    writeFileSync(f.executor, 'export default {run(){return {members:[],resources:[]}}};');
    runOnce(f);
    assert.equal(read(f.status).state, 'unknown');
    assert.equal(existsSync(f.facts), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
