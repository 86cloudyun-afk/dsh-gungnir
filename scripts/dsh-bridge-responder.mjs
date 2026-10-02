#!/usr/bin/env node
// DSH 侧应答器（参考实现）：消费 gungnir-bridge/1 协议，把 job 变成"执行层"的回执。
// 真实部署时，本进程运行在 DSH host 平面：onJob 里调红队模式的插件服务派单；
// 离线/彩排用 `--mode echo`（按 contract 生成回执）或 `--mode fixture <dir>`（读预置回执）。
//
// 用法：node scripts/dsh-bridge-responder.mjs --root <home>/dsh-bridge [--mode echo|fixture] [--interval 50] [--once]
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' }, mode: { type: 'string', default: 'echo' },
    fixture: { type: 'string' }, interval: { type: 'string', default: '50' },
    once: { type: 'boolean', default: false }, verbose: { type: 'boolean', default: false },
  },
});

if (!v.root) {
  console.error('用法：node scripts/dsh-bridge-responder.mjs --root <home>/dsh-bridge [--mode echo|fixture] [--once]');
  process.exit(2);
}
const outbox = join(v.root, 'outbox');
const inbox = join(v.root, 'inbox');
mkdirSync(outbox, { recursive: true });
mkdirSync(inbox, { recursive: true });

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
function atomicWrite(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

const sha = (s) => `sha256:${createHash('sha256').update(String(s)).digest('hex')}`;
const handled = new Set();

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
  return { members, resources };
}

/** fixture 模式：从目录读 <external_id>.facts.json / .probes.json（预置回执）。 */
function fixtureReceipts(job) {
  const dir = v.fixture ?? join(v.root, 'fixtures');
  const facts = readJson(join(dir, `${job.external_id}.facts.json`)) ?? { members: [] };
  const probes = readJson(join(dir, `${job.external_id}.probes.json`)) ?? { resources: [] };
  return { members: facts.members ?? [], resources: probes.resources ?? [] };
}

function handleJob(job) {
  const key = `job:${job.external_id}`;
  if (handled.has(key)) return;               // 幂等：同 external_id 只处理一次
  handled.add(key);
  const { members, resources } = v.mode === 'fixture' ? fixtureReceipts(job) : echoReceipts(job);
  atomicWrite(join(inbox, `${job.external_id}.status.json`), {
    protocol: 'gungnir-bridge/1', external_id: job.external_id, state: 'running',
    updated_at: new Date().toISOString(),
  });
  atomicWrite(join(inbox, `${job.external_id}.facts.json`), { protocol: 'gungnir-bridge/1', members });
  atomicWrite(join(inbox, `${job.external_id}.probes.json`), { protocol: 'gungnir-bridge/1', resources });
  if (v.verbose) console.log(`[job] ${job.external_id} role=${job.role} members=${members.length} resources=${resources.length}`);
}

function handleStop(stop) {
  const key = `stop:${stop.external_id}`;
  if (handled.has(key)) return;
  handled.add(key);
  const cur = readJson(join(inbox, `${stop.external_id}.probes.json`)) ?? { resources: [] };
  const stopped = (cur.resources ?? []).map((r) => ({ ...r, stopped: true }));
  atomicWrite(join(inbox, `${stop.external_id}.probes.json`), { protocol: 'gungnir-bridge/1', resources: stopped });
  atomicWrite(join(inbox, `${stop.external_id}.status.json`), {
    protocol: 'gungnir-bridge/1', external_id: stop.external_id, state: 'confirmed_stopped',
    updated_at: new Date().toISOString(),
  });
  if (v.verbose) console.log(`[stop] ${stop.external_id} → confirmed_stopped`);
}

function tick() {
  for (const f of readdirSync(outbox)) {
    if (f.endsWith('.job.json')) {
      const job = readJson(join(outbox, f));
      if (job?.protocol === 'gungnir-bridge/1') handleJob(job);
    } else if (f.endsWith('.stop.json')) {
      const stop = readJson(join(outbox, f));
      if (stop?.protocol === 'gungnir-bridge/1') handleStop(stop);
    }
  }
}

if (v.once) {
  tick();
} else {
  const interval = Number(v.interval);
  console.log(`[responder] root=${v.root} mode=${v.mode} interval=${interval}ms（Ctrl-C 退出）`);
  setInterval(tick, interval);
  tick();
}
