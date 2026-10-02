#!/usr/bin/env node
// DSH 侧应答器（参考实现）：消费 gungnir-bridge/1 协议，把 job 变成"执行层"的回执。
// 真实部署时，本进程运行在 DSH host 平面：onJob 里调红队模式的插件服务派单；
// 离线/彩排用 `--mode echo`（按 contract 生成回执）或 `--mode fixture <dir>`（读预置回执）。
//
// 用法：node scripts/dsh-bridge-responder.mjs --root <home>/dsh-bridge [--mode echo|fixture] [--interval 50] [--once]
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

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
/** 已被要求停止的任务：其执行体结束后**不得**把状态写回 done（停了就是停了）。 */
const stopRequested = new Set();

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
  const factsPath = join(dir, `${job.external_id}.facts.json`);
  const probesPath = join(dir, `${job.external_id}.probes.json`);
  const facts = readJson(factsPath);
  const probes = readJson(probesPath);
  if (!facts && !probes) {
    // fail-closed：夹具缺失时**不要**假装"零事实零资源"（那会让主控以为任务干净结束）
    throw new Error(`fixture 模式缺少夹具文件：${factsPath} / ${probesPath}`);
  }
  return { members: facts?.members ?? [], resources: probes?.resources ?? [] };
}

async function loadExecutor() {
  if (!v.executor) return null;
  const mod = await import(pathToFileURL(resolve(v.executor)).href);
  const ex = mod.default ?? mod;
  if (typeof ex?.run !== 'function') throw new Error(`执行器 ${v.executor} 未导出 run(job)`);
  if (v.verbose) process.stdout.write(`[executor] ${ex.name ?? v.executor} loaded\n`);
  return ex;
}

const writeStatus = (id, state, extra = {}) => atomicWrite(join(inbox, `${id}.status.json`), {
  protocol: 'gungnir-bridge/1', external_id: id, state, updated_at: new Date().toISOString(), ...extra,
});

/**
 * 处理一个 job：**先确认，再异步执行**。
 *
 * 为什么必须这样（真机教训）：桥侧等待状态文件的默认上限只有 `bridgeTimeoutMs`（2 秒），
 * 而真实工具（subfinder/httpx/nuclei）要跑几十秒到几分钟。旧实现"跑完才写状态" →
 * 每次真派单都被判成超时/派单丢失，看起来就像"开不了战"。
 * 现在：立刻写 `running`（派单秒回），执行完再写 facts/probes + `done`；
 * 失败写 `failed` 且**不写 facts**（fail-closed，绝不假装成功）。
 */
async function handleJob(job, { wait = false } = {}) {
  const key = `job:${job.external_id}`;
  if (handled.has(key)) return;               // 幂等：同 external_id 只处理一次
  handled.add(key);
  // 常驻模式：立刻确认（派单方不必等工具跑完，桥默认只等 2s）；
  // 单次模式（--once，测试/彩排用）：不写中间态，跑完再落终态。
  if (!wait) writeStatus(job.external_id, 'running');
  if (v.verbose) console.log(`[job] ${job.external_id} role=${job.role} accepted`);
  const run = (async () => {
    try {
      let members; let resources;
      if (executor) {
        // 真实执行器：失败即抛错（fail-closed），不写"看起来成功"的回执
        const out = await executor.run(job);
        members = out.members ?? [];
        resources = out.resources ?? [];
      } else if (v.mode === 'fixture') {
        ({ members, resources } = fixtureReceipts(job));
      } else {
        ({ members, resources } = echoReceipts(job));
      }
      if (stopRequested.has(job.external_id)) {
        // 执行期间收到了停止请求：**不写事实、不写 done**；把资源如实标记为已停止后写 confirmed_stopped。
        // 没有资源可证时只写状态、不造证据（主控仍会因"无停止证明"停在 unresolved，符合 ADR-003）。
        if (resources.length > 0) {
          atomicWrite(join(inbox, `${job.external_id}.probes.json`),
            { protocol: 'gungnir-bridge/1', resources: resources.map((r) => ({ ...r, stopped: true })) });
        }
        writeStatus(job.external_id, 'confirmed_stopped');
        return;
      }
      atomicWrite(join(inbox, `${job.external_id}.facts.json`), { protocol: 'gungnir-bridge/1', members });
      atomicWrite(join(inbox, `${job.external_id}.probes.json`), { protocol: 'gungnir-bridge/1', resources });
      writeStatus(job.external_id, 'done', { members: members.length });
      if (v.verbose) console.log(`[job] ${job.external_id} done members=${members.length} resources=${resources.length}`);
    } catch (e) {
      // 失败：明确状态 + 不写 facts；由主控 reconcile 定论（绝不自动重试）
      writeStatus(job.external_id, 'failed', { detail: String(e?.message ?? e).slice(0, 500) });
      process.stderr.write(`[job] ${job.external_id} failed: ${e?.message ?? e}\n`);
    }
  })();
  if (wait) await run;                        // 单次模式：等执行体结束再返回
}

function handleStop(stop) {
  const key = `stop:${stop.external_id}`;
  if (handled.has(key)) return;
  handled.add(key);
  stopRequested.add(stop.external_id);
  const cur = readJson(join(inbox, `${stop.external_id}.probes.json`)) ?? { resources: [] };
  const stopped = (cur.resources ?? []).map((r) => ({ ...r, stopped: true }));
  atomicWrite(join(inbox, `${stop.external_id}.probes.json`), { protocol: 'gungnir-bridge/1', resources: stopped });
  atomicWrite(join(inbox, `${stop.external_id}.status.json`), {
    protocol: 'gungnir-bridge/1', external_id: stop.external_id, state: 'confirmed_stopped',
    updated_at: new Date().toISOString(),
  });
  if (v.verbose) console.log(`[stop] ${stop.external_id} → confirmed_stopped`);
}

async function tick() {
  for (const f of readdirSync(outbox)) {
    if (f.endsWith('.job.json')) {
      const job = readJson(join(outbox, f));
      if (job?.protocol === 'gungnir-bridge/1') {
        try {
          await handleJob(job, { wait: Boolean(v.once) });
        } catch (e) {
          handled.delete(`job:${job.external_id}`);   // 失败允许重试；不写假回执
          process.stderr.write(`[job-error] ${job.external_id}: ${e.message}\n`);
        }
      }
    } else if (f.endsWith('.stop.json')) {
      const stop = readJson(join(outbox, f));
      if (stop?.protocol === 'gungnir-bridge/1') handleStop(stop);
    }
  }
}

const executor = await loadExecutor();

if (v.once) {
  await tick();
} else {
  const interval = Number(v.interval);
  console.log(`[responder] root=${v.root} mode=${v.mode} interval=${interval}ms（Ctrl-C 退出）`);
  setInterval(() => { tick(); }, interval);
  tick();
}
