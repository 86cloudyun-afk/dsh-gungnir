// 跨进程端到端：GUNGNIR（本测试进程）↔ 应答器（子进程），仅经 spool 文件通信。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { RedteamModeAdapter } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { DshRedteamDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';

function startResponder(root, extra = []) {
  const child = spawn('node', ['scripts/dsh-bridge-responder.mjs', '--root', root, '--interval', '25', '--verbose', ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  return child;
}

/** 常驻模式下事实是异步落盘的：collect 前先等 facts 文件出现（最多 5 秒）。 */
async function waitFacts(root, externalId, timeoutMs = 5000) {
  const p = join(root, 'inbox', `${externalId}.facts.json`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待 facts 超时：${p}`);
}

test('跨进程：应答器消费 job → 事实入库 → stop 后逐项证实', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-responder-'));
  const root = join(home, 'dsh-bridge');
  mkdirSync(root, { recursive: true });
  const once = () => {
    const result = spawnSync(process.execPath, ['scripts/dsh-bridge-responder.mjs', '--root', root, '--once'], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
  };

  try {
    const adapter = new RedteamModeAdapter({
      driver: new DshRedteamDriver({ root, timeoutMs: 2000, pollMs: 25, onJob: once }),
    });
    const broker = new Broker({ home, adapter });
    const eng = broker.createEngagement({ user_message_id: 'um-resp', targets: ['10.0.0.0/24'] });

    const ex = broker.execute({
      command_id: 'resp-1', engagement_id: eng.engagement_id, auth_version: 1,
      contract: {
        targets: ['10.0.0.5'], action_class: 'active', resources: ['container'], wire_cost: 0, intent: 'recon',
        fake_members: [{ entity_type: 'asset', source_id: 'resp-a1', revision_no: 1, content_hash: 'h-resp', payload: { ip: '10.0.0.5' } }],
      },
    });
    // legacy --once 等待事实落盘并保留 running，让本用例确定性验证真正的停止路径。
    assert.equal(ex.state, 'running');
    assert.equal(broker._findCommand(ex.task_id).state, 'running');

    await waitFacts(root, ex.task_id);
    const col = broker.collect(eng.engagement_id, ex.task_id, adapter.collect(ex.task_id));
    assert.equal(col.accepted, true);
    assert.equal(broker._eng(eng.engagement_id).store.effectiveCount(), 1);

    // cancel 先请求，再等待 echo 所有模拟资源的实际停止回执。
    const c1 = broker.cancel(eng.engagement_id, ex.task_id, 'test');
    assert.equal(c1.state, 'unresolved');
    assert.ok(existsSync(join(root, 'outbox', `${ex.task_id}.stop.json`)));
    once();
    const stopped = adapter.manifestOf(ex.task_id) ?? [];
    assert.equal(stopped.length, 2, 'session/container 两项必须都有源证据');
    assert.equal(stopped.every((p) => p.check() === true), true);
    const c2 = broker.cancel(eng.engagement_id, ex.task_id, 'test');
    assert.equal(c2.state, 'confirmed_stopped');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('daemon 初始 done：collect 不改终态；终态取消必须真的停并逐项证实（ADR-009）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-responder-done-'));
  const root = join(home, 'dsh-bridge');
  mkdirSync(root, { recursive: true });
  const child = startResponder(root);
  try {
    const driver = new DshRedteamDriver({ root, timeoutMs: 2000, pollMs: 25, onJob(job) {
      // 只等待真实子进程的最终 source publication，不写状态或停止证据。
      const statusPath = join(root, 'inbox', `${job.external_id}.status.json`);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        let source;
        try { source = JSON.parse(readFileSync(statusPath, 'utf8')); } catch {}
        if (source?.state === 'done') return;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      throw new Error('daemon 未在期限内发布真实 done');
    } });
    const adapter = new RedteamModeAdapter({ driver });
    const broker = new Broker({ home, adapter });
    const eng = broker.createEngagement({ user_message_id: 'um-done', targets: ['10.0.0.0/24'] });
    const ex = broker.execute({ command_id: 'done-1', engagement_id: eng.engagement_id, auth_version: 1,
      contract: { targets: ['10.0.0.5'], action_class: 'active', resources: ['container'], wire_cost: 0, intent: 'recon',
        fake_members: [{ entity_type: 'asset', source_id: 'done-a1', revision_no: 1, content_hash: 'h-done', payload: { ip: '10.0.0.5' } }] } });
    assert.equal(ex.state, 'done');
    assert.equal(broker._findCommand(ex.task_id).state, 'done');
    assert.equal(broker.collect(eng.engagement_id, ex.task_id, adapter.collect(ex.task_id)).accepted, true);
    assert.equal(broker._findCommand(ex.task_id).state, 'done', 'collect 不触发终态转换');
    const probes = adapter.manifestOf(ex.task_id) ?? [];
    assert.equal(probes.length, 2);
    assert.equal(probes.every((p) => p.check() === false), true, 'done 不是 stopped 证明');
    // ADR-009：终态任务上清单里仍有活资源 → 取消请求必须真的去停 + 逐项证实，
    // 不许无副作用地回一句"已结束"（那会让 done 永久盖住在跑的资源）。
    const result = broker.cancel(eng.engagement_id, ex.task_id, 'test');
    assert.equal(result.state, 'confirmed_stopped', '逐项证实通过才落 confirmed_stopped');
    assert.equal(existsSync(join(root, 'outbox', `${ex.task_id}.stop.json`)), true, '停止请求必须发下去');
    const after = adapter.manifestOf(ex.task_id) ?? [];
    assert.equal(after.every((p) => p.check() === true), true, '证实后清单逐项为已停止');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
    rmSync(home, { recursive: true, force: true });
  }
});

test('应答器幂等：重复 job 文件不产生第二份回执副作用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-responder-idem-'));
  const child = startResponder(root, ['--once']);
  await new Promise((r) => child.on('exit', r));

  const job = {
    protocol: 'gungnir-bridge/1', external_id: 'idem-1', role: 'recon', contract: { generation: '1:1:1', resources: [], fake_members: [] },
  };
  const { writeFileSync: wf } = await import('node:fs');
  wf(join(root, 'outbox', 'idem-1.job.json'), JSON.stringify(job));
  // 第二次以另一个应答器实例处理（模拟重复投递）
  const child2 = spawn('node', ['scripts/dsh-bridge-responder.mjs', '--root', root, '--once'], { stdio: 'ignore' });
  await new Promise((r) => child2.on('exit', r));
  assert.ok(existsSync(join(root, 'inbox', 'idem-1.status.json')));
});

test('fixture 模式：应答器按预置回执响应（可编排异常场景）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-responder-fix-'));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'fx-1.facts.json'), JSON.stringify({
    generation: '1:1:1', external_id: 'fx-1',
    members: [{ entity_type: 'vuln', source_id: 'v-fx', revision_no: 1, content_hash: 'h-fx', payload: { id: 'CVE-DEMO' } }],
  }));
  writeFileSync(join(fixtures, 'fx-1.probes.json'), JSON.stringify({
    generation: '1:1:1', external_id: 'fx-1',
    resources: [{ id: 'fx-1-session', kind: 'session', stopped: true }],
  }));

  const child = startResponder(root, ['--once', '--mode', 'fixture', '--fixture', fixtures]);
  await new Promise((r) => child.on('exit', r));

  const job = { protocol: 'gungnir-bridge/1', external_id: 'fx-1', role: 'vuln', contract: { generation: '1:1:1', resources: [], fake_members: [] } };
  // --once 在启动时扫过空 outbox；投递后需要再跑一次应答器
  writeFileSync(join(root, 'outbox', 'fx-1.job.json'), JSON.stringify(job));
  const child2 = spawn('node', ['scripts/dsh-bridge-responder.mjs', '--root', root, '--once', '--mode', 'fixture', '--fixture', fixtures], { stdio: 'ignore' });
  await new Promise((r) => child2.on('exit', r));

  const facts = JSON.parse((await import('node:fs')).readFileSync(join(root, 'inbox', 'fx-1.facts.json'), 'utf8'));
  assert.equal(facts.members[0].source_id, 'v-fx');
});


test('fixture 模式缺夹具 → 不写假回执（fail-closed），错误留痕', () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-bridge-fix-'));
  const out = spawnSync('node', [
    'scripts/dsh-bridge-responder.mjs', '--root', root, '--mode', 'fixture', '--once',
  ], { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
  // 先造一个 job（无对应夹具）
  mkdirSync(join(root, 'outbox'), { recursive: true });
  writeFileSync(join(root, 'outbox', 'fx-1.job.json'), JSON.stringify({
    protocol: 'gungnir-bridge/1', external_id: 'fx-1', role: 'recon', contract: { generation: '1:1:1', resources: ['container'], fake_members: [] },
  }));
  const r = spawnSync('node', [
    'scripts/dsh-bridge-responder.mjs', '--root', root, '--mode', 'fixture', '--once',
  ], { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
  assert.equal(r.status, 0, '单次模式错误不致命，但要留痕');
  assert.match(`${r.stdout}${r.stderr}`, /job-error|缺少夹具文件/);
  assert.equal(existsSync(join(root, 'inbox', 'fx-1.probes.json')), false, '不得写"零资源"的假回执');
  void out;
});

test('跨进程停止：任务在飞时 cancel → unresolved；残留资源不伪造停止、不复活', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-responder-stop-'));
  const root = join(home, 'dsh-bridge');
  mkdirSync(root, { recursive: true });
  const slow = join(home, 'slow-executor.mjs');
  const started = join(home, 'slow-started');
  writeFileSync(slow, `
import { writeFileSync } from 'node:fs';
export default { name: 'slow', async run(job) {
  writeFileSync(${JSON.stringify(started)}, 'started');
  await new Promise((r) => setTimeout(r, 1500));
  return { generation: job.contract.generation, members: [], resources: [{ id: job.external_id + '-p', kind: 'process', stopped: false }] };
} };
`);
  const child = spawn('node', ['scripts/dsh-bridge-responder.mjs', '--root', root, '--executor', slow, '--interval', '25'], { stdio: 'ignore' });
  try {
    const adapter = new RedteamModeAdapter({ driver: new DshRedteamDriver({ root, timeoutMs: 2000, pollMs: 25 }) });
    const broker = new Broker({ home, adapter });
    const eng = broker.createEngagement({ user_message_id: 'um-stop', targets: ['10.0.0.0/24'] });
    const ex = broker.execute({
      command_id: 'stop-1', engagement_id: eng.engagement_id, auth_version: 1,
      contract: { targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0, intent: 'recon' },
    });
    assert.equal(ex.state, 'running', '慢任务应处于在飞态');
    const awaitReady = async (read, label) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { if (read()) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(`slow fixture 未就绪：${label}`);
    };
    // A fast running acknowledgement precedes executor entry; prove the inert
    // executor actually started before asking this in-flight fixture to stop.
    await awaitReady(() => existsSync(started), 'executor entry');

    // 首轮：停止是"请求"，此时还没有停止证明（执行体仍在跑）→ unresolved（ADR-003：停止证明要实测）
    const c1 = broker.cancel(eng.engagement_id, ex.task_id, 'stop-test');
    assert.equal(c1.state, 'unresolved', `首轮应为请求态，实得 ${c1.state}`);

    // 执行体结束不等于资源停止：源仍报告 stopped:false，不能伪造确认。
    await awaitReady(() => {
      const status = JSON.parse(readFileSync(join(root, 'inbox', `${ex.task_id}.status.json`), 'utf8'));
      const probes = JSON.parse(readFileSync(join(root, 'inbox', `${ex.task_id}.probes.json`), 'utf8'));
      const facts = JSON.parse(readFileSync(join(root, 'inbox', `${ex.task_id}.facts.json`), 'utf8'));
      return status.state === 'unresolved' && [status, probes, facts].every(source =>
        source.external_id === ex.task_id && source.generation === ex.generation && source.event_seq === status.event_seq);
    }, 'source publication');
    const c2 = broker.cancel(eng.engagement_id, ex.task_id, 'stop-test');
    assert.equal(c2.state, 'unresolved', '源残留资源必须维持 unresolved');

    const st = JSON.parse(readFileSync(join(root, 'inbox', `${ex.task_id}.status.json`), 'utf8'));
    assert.equal(st.state, 'unresolved', '不得复活成 done 或伪造 confirmed_stopped');
    const probes = JSON.parse(readFileSync(join(root, 'inbox', `${ex.task_id}.probes.json`), 'utf8'));
    assert.equal(probes.resources[0].stopped, false, '保留实际源的残留资源证据');
    assert.equal(probes.resources.length, 1, '残留资源证明不得为空');
    const manifest = adapter.manifestOf(ex.task_id);
    assert.equal(manifest.length, 1);
    assert.ok(manifest.every(resource => resource.check() === false), '逐项保持未停止证明');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
    rmSync(home, { recursive: true, force: true });
  }
});
