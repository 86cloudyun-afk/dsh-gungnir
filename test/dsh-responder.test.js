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

const waitFor = async (fn, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

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
  const child = startResponder(root);

  try {
    const adapter = new RedteamModeAdapter({
      driver: new DshRedteamDriver({ root, timeoutMs: 2000, pollMs: 25 }),
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
    // 常驻应答器：立刻回 running；若任务瞬间完成（echo 执行器），此处已是 done——两者都算回执及时
    assert.ok(['running', 'done'].includes(ex.state), `应答器应在超时前回执（实得 ${ex.state}）`);

    await waitFacts(root, ex.task_id);
    const col = broker.collect(eng.engagement_id, ex.task_id, adapter.collect(ex.task_id));
    assert.equal(col.accepted, true);
    assert.equal(broker._eng(eng.engagement_id).store.effectiveCount(), 1);

    // cancel 先请求，再等待 echo 所有模拟资源的实际停止回执。
    const c1 = broker.cancel(eng.engagement_id, ex.task_id, 'test');
    assert.ok(['unresolved', 'confirmed_stopped', 'done'].includes(c1.state));
    assert.equal(await waitFor(() => (adapter.manifestOf(ex.task_id) ?? []).every((p) => p.check() === true)), true);
    const c2 = broker.cancel(eng.engagement_id, ex.task_id, 'test');
    assert.ok(['confirmed_stopped', 'done'].includes(c2.state), `已完成任务的 cancel 实得 ${c2.state}`);
  } finally {
    child.kill('SIGTERM');
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
  writeFileSync(slow, `
export default { name: 'slow', async run(job) {
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

    // 首轮：停止是"请求"，此时还没有停止证明（执行体仍在跑）→ unresolved（ADR-003：停止证明要实测）
    const c1 = broker.cancel(eng.engagement_id, ex.task_id, 'stop-test');
    assert.equal(c1.state, 'unresolved', `首轮应为请求态，实得 ${c1.state}`);

    // 执行体结束不等于资源停止：源仍报告 stopped:false，不能伪造确认。
    await new Promise((r) => setTimeout(r, 1900));
    const c2 = broker.cancel(eng.engagement_id, ex.task_id, 'stop-test');
    assert.equal(c2.state, 'unresolved', '源残留资源必须维持 unresolved');

    const st = JSON.parse(readFileSync(join(root, 'inbox', `${ex.task_id}.status.json`), 'utf8'));
    assert.equal(st.state, 'unresolved', '不得复活成 done 或伪造 confirmed_stopped');
    const probes = JSON.parse(readFileSync(join(root, 'inbox', `${ex.task_id}.probes.json`), 'utf8'));
    assert.equal(probes.resources[0].stopped, false, '保留实际源的残留资源证据');
  } finally {
    child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
});
