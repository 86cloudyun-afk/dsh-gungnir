#!/usr/bin/env node
// DSH 侧应答器（参考实现）：消费 gungnir-bridge/1 协议，把 job 变成"执行层"的回执。
// 真实部署时，本进程运行在 DSH host 平面：onJob 里调红队模式的插件服务派单；
// 离线/彩排用 `--mode echo`（按 contract 生成回执）或 `--mode fixture <dir>`（读预置回执）。
//
// 用法：node scripts/dsh-bridge-responder.mjs --root <home>/dsh-bridge [--mode echo|fixture] [--interval 50] [--once]
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { assertSafeSegment } from '../packages/warroom-core/src/paths.js';

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' }, mode: { type: 'string', default: 'echo' },
    fixture: { type: 'string' }, interval: { type: 'string', default: '50' },
    once: { type: 'boolean', default: false }, verbose: { type: 'boolean', default: false },
    executor: { type: 'string' },   // 执行器插件路径（export default { name, run(job) }）
  },
});

if (!v.root) {
  console.error('用法：node scripts/dsh-bridge-responder.mjs --root <home>/dsh-bridge [--mode echo|fixture] [--once]');
  process.exit(2);
}
const outbox = join(v.root, 'outbox');
const inbox = join(v.root, 'inbox');
const claims = join(v.root, 'claims');
mkdirSync(outbox, { recursive: true });
mkdirSync(inbox, { recursive: true });
mkdirSync(claims, { recursive: true });

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
function atomicWrite(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(obj, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

const sha = (s) => `sha256:${createHash('sha256').update(String(s)).digest('hex')}`;
const handled = new Set();
const active = new Set();

function nextSequence(job) {
  const prior = readJson(join(inbox, `${job.external_id}.status.json`));
  return prior?.generation === job.contract.generation && Number.isSafeInteger(prior.event_seq)
    ? prior.event_seq + 1 : 1;
}

function publish(job, state, event_seq = nextSequence(job)) {
  atomicWrite(join(inbox, `${job.external_id}.status.json`), {
    protocol: 'gungnir-bridge/1', external_id: job.external_id,
    generation: job.contract.generation, event_seq, state, updated_at: new Date().toISOString(),
  });
}

function claim(job) {
  const path = join(claims, `${job.external_id}.json`);
  const record = { external_id: job.external_id, generation: job.contract.generation,
    mode: executor ? 'executor' : v.mode, state: 'claimed', background: job.background === true,
    owner_pid: process.pid };
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); }
  finally { closeSync(fd); }
  // Durably publish the claim before calling an executor; do not recover by rerunning.
  const dir = openSync(claims, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return record;
}

function ownerGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // Only exclusion between responder writers; this is never resource-stop evidence.
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

/** echo 模式：按 contract.fake_members 生成事实；会话/容器资源按 contract.resources 推导。 */
function echoReceipts(job) {
  const c = job.contract ?? {};
  const members = (c.fake_members ?? []).map((m) => ({
    entity_type: m.entity_type, source_id: m.source_id, revision_no: m.revision_no,
    content_hash: m.content_hash ?? sha(JSON.stringify(m.payload ?? {})),
    payload: m.payload ?? {},
  }));
  const resources = [
    { id: `${job.external_id}-session`, kind: 'session', stopped: false },
    ...((c.resources ?? []).includes('container') ? [{ id: `${job.external_id}-container`, kind: 'container', stopped: false }] : []),
  ];
  return { generation: c.generation, external_id: job.external_id, members, resources };
}

/** fixture 模式：从目录读 <external_id>.facts.json / .probes.json（预置回执）。 */
function fixtureReceipts(job) {
  const dir = v.fixture ?? join(v.root, 'fixtures');
  const factsPath = join(dir, `${job.external_id}.facts.json`);
  const probesPath = join(dir, `${job.external_id}.probes.json`);
  const facts = readJson(factsPath);
  const probes = readJson(probesPath);
  if (!facts && !probes) {
    // fail-closed：夹具缺失时**不要**假装"零事实零资源"（那会让主控以为任务干净结束）
    throw new Error(`fixture 模式缺少夹具文件：${factsPath} / ${probesPath}`);
  }
  if ([facts, probes].some((receipt) => !receipt || receipt.generation !== job.contract.generation ||
      receipt.external_id !== job.external_id)) throw new Error('fixture source identity/generation mismatch');
  return { generation: facts.generation, external_id: facts.external_id,
    members: facts.members ?? [], resources: probes.resources ?? [], stop_request_id: probes.stop_request_id };
}

async function loadExecutor() {
  if (!v.executor) return null;
  const mod = await import(pathToFileURL(resolve(v.executor)).href);
  const ex = mod.default ?? mod;
  if (typeof ex?.run !== 'function') throw new Error(`执行器 ${v.executor} 未导出 run(job)`);
  if (v.verbose) process.stdout.write(`[executor] ${ex.name ?? v.executor} loaded\n`);
  return ex;
}

async function handleJob(job) {
  assertSafeSegment(job.external_id, 'external_id');
  if (typeof job.contract?.generation !== 'string' || !job.contract.generation) throw new Error('source generation required');
  const key = `job:${job.external_id}`;
  if (handled.has(key)) return;
  handled.add(key);
  const claimed = claim(job);
  if (!claimed) {
    const claimPath = join(claims, `${job.external_id}.json`);
    let previous = readJson(claimPath);
    if (previous?.generation !== job.contract.generation) throw new Error('claimed task identity/generation mismatch');
    if (previous.state !== 'completed') {
      // An active exclusive claimant owns publication. A second process only observes.
      // After proving the writer dead, reload its final record; it cannot race another write.
      if (!ownerGone(previous.owner_pid)) return;
      previous = readJson(claimPath);
      if (previous?.generation !== job.contract.generation) throw new Error('claimed task identity/generation mismatch');
    }
    if (previous.state !== 'completed') publish(job, 'unknown');
    else if (previous.final_event && !previous.cancel_requested &&
        readJson(join(outbox, `${job.external_id}.stop.json`))?.generation !== job.contract.generation) {
      const current = readJson(join(inbox, `${job.external_id}.status.json`));
      const facts = readJson(join(inbox, `${job.external_id}.facts.json`));
      const probes = readJson(join(inbox, `${job.external_id}.probes.json`));
      const { state, event_seq } = previous.final_event;
      const sourceMatches = [facts, probes].every((source) => source?.external_id === job.external_id &&
        source.generation === job.contract.generation && source.event_seq === event_seq);
      if (sourceMatches && (!current || current.generation !== job.contract.generation || current.event_seq < event_seq)) {
        publish(job, state, event_seq);
      }
    }
    return;
  }
  // Daemon CLI jobs retain #162 fast acknowledgment; --once drains legacy work.
  if (!v.once || job.background) publish(job, 'running');
  const stop = readJson(join(outbox, `${job.external_id}.stop.json`));
  if (stop?.generation === job.contract.generation) { handleStop(stop); return; }
  let result;
  if (executor) {
    result = await executor.run(job);
  } else if (v.mode === 'fixture') {
    result = fixtureReceipts(job);
  } else {
    result = echoReceipts(job);
  }
  if (result?.generation !== job.contract.generation ||
      (result.external_id !== undefined && result.external_id !== job.external_id)) {
    throw new Error('executor source identity/generation mismatch');
  }
  const { members, resources } = result;
  if (!Array.isArray(members) || !Array.isArray(resources)) throw new Error('source members/resources arrays required');
  const event_seq = nextSequence(job);
  const envelope = { protocol: 'gungnir-bridge/1', external_id: job.external_id, generation: result.generation, event_seq };
  // Final status is the publication boundary, after both durable source envelopes.
  atomicWrite(join(inbox, `${job.external_id}.facts.json`), { ...envelope, members });
  atomicWrite(join(inbox, `${job.external_id}.probes.json`), { ...envelope, resources, stop_request_id: result.stop_request_id });
  const current = readJson(join(claims, `${job.external_id}.json`)) ?? claimed;
  const stopped = readJson(join(outbox, `${job.external_id}.stop.json`));
  const cancelled = current.cancel_requested || stopped?.generation === job.contract.generation;
  const state = cancelled ? 'unresolved' : (!v.once || job.background) ? 'done' : 'running';
  atomicWrite(join(claims, `${job.external_id}.json`), { ...current, state: 'completed', final_event: { state, event_seq } });
  publish(job, state, event_seq);
  if (v.verbose) console.log(`[job] ${job.external_id} role=${job.role} members=${members.length} resources=${resources.length}`);
}

function handleStop(stop) {
  assertSafeSegment(stop.external_id, 'external_id');
  const key = `stop:${stop.external_id}`;
  if (handled.has(key)) return;
  const claimed = readJson(join(claims, `${stop.external_id}.json`));
  if (!claimed || !stop.generation || claimed.generation !== stop.generation) return;
  handled.add(key);
  atomicWrite(join(claims, `${stop.external_id}.json`), { ...claimed, cancel_requested: true });
  const cur = readJson(join(inbox, `${stop.external_id}.probes.json`));
  let resources = cur?.generation === stop.generation && cur?.external_id === stop.external_id ? cur.resources ?? [] : [];
  const job = { external_id: stop.external_id, contract: { generation: stop.generation } };
  const event_seq = nextSequence(job);
  let proofSeq = cur?.event_seq;
  // Only this responder's echo resources are simulated. Executor/fixture proof is never invented.
  if (claimed.mode === 'echo' && resources.length) {
    resources = resources.map((r) => ({ ...r, stopped: true }));
    proofSeq = event_seq;
    atomicWrite(join(inbox, `${stop.external_id}.probes.json`), { ...cur, event_seq, resources, stop_request_id: stop.request_id });
  }
  const fresh = !claimed.background || (Number.isSafeInteger(stop.after_event_seq) &&
    Number.isSafeInteger(proofSeq) && proofSeq > stop.after_event_seq &&
    typeof stop.request_id === 'string' && !!stop.request_id &&
    (claimed.mode === 'echo' || cur?.stop_request_id === stop.request_id));
  const state = fresh && resources.length && resources.every((r) => r.stopped === true) ? 'confirmed_stopped' : 'unresolved';
  publish(job, state, event_seq);
  if (v.verbose) console.log(`[stop] ${stop.external_id} → ${state}`);
}

function tick() {
  for (const f of readdirSync(outbox)) {
    if (f.endsWith('.job.json')) {
      const job = readJson(join(outbox, f));
      if (job?.protocol === 'gungnir-bridge/1') {
        const work = handleJob(job).catch((e) => {
          // A claimed action may have run. Failures never release its durable idempotency key.
          if ((!v.once || job.background) && typeof job.contract?.generation === 'string' &&
              /^[A-Za-z0-9_-]+$/.test(job.external_id)) publish(job, 'unknown');
          process.stderr.write(`[job-error] ${job.external_id}: ${e.message}\n`);
        });
        active.add(work); work.finally(() => active.delete(work));
      }
    } else if (f.endsWith('.stop.json')) {
      const stop = readJson(join(outbox, f));
      if (stop?.protocol === 'gungnir-bridge/1') {
        try { handleStop(stop); } catch (e) { process.stderr.write(`[stop-error] ${e.code ?? 'invalid-stop'}\n`); }
      }
    }
  }
}

const executor = await loadExecutor();

if (v.once) {
  tick(); await Promise.all(active);
} else {
  const interval = Number(v.interval);
  console.log(`[responder] root=${v.root} mode=${v.mode} interval=${interval}ms（Ctrl-C 退出）`);
  setInterval(tick, interval);
  tick();
}
