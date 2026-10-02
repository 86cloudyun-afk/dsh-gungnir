// 跨进程端到端：GUNGNIR（本测试进程）↔ 应答器（子进程），仅经 spool 文件通信。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
    assert.equal(ex.state, 'running', '应答器应在超时前回执');

    const col = broker.collect(eng.engagement_id, ex.task_id, adapter.collect(ex.task_id));
    assert.equal(col.accepted, true);
    assert.equal(broker._eng(eng.engagement_id).store.effectiveCount(), 1);

    // 两阶段停止：请求 → 应答器写回停止探针 → 再次 cancel 得 confirmed_stopped
    const c1 = broker.cancel(eng.engagement_id, ex.task_id, 'test');
    assert.ok(['unresolved', 'confirmed_stopped'].includes(c1.state));
    await waitFor(() => (adapter.manifestOf(ex.task_id) ?? []).every((p) => p.check() === true));
    const c2 = broker.cancel(eng.engagement_id, ex.task_id, 'test');
    assert.equal(c2.state, 'confirmed_stopped');
  } finally {
    child.kill('SIGTERM');
  }
});

test('应答器幂等：重复 job 文件不产生第二份回执副作用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-responder-idem-'));
  const child = startResponder(root, ['--once']);
  await new Promise((r) => child.on('exit', r));

  const job = {
    protocol: 'gungnir-bridge/1', external_id: 'idem-1', role: 'recon', contract: { resources: [], fake_members: [] },
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
    members: [{ entity_type: 'vuln', source_id: 'v-fx', revision_no: 1, content_hash: 'h-fx', payload: { id: 'CVE-DEMO' } }],
  }));
  writeFileSync(join(fixtures, 'fx-1.probes.json'), JSON.stringify({
    resources: [{ id: 'fx-1-session', kind: 'session', stopped: true }],
  }));

  const child = startResponder(root, ['--once', '--mode', 'fixture', '--fixture', fixtures]);
  await new Promise((r) => child.on('exit', r));

  const job = { protocol: 'gungnir-bridge/1', external_id: 'fx-1', role: 'vuln', contract: { resources: [], fake_members: [] } };
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
    protocol: 'gungnir-bridge/1', external_id: 'fx-1', role: 'recon', contract: { resources: ['container'], fake_members: [] },
  }));
  const r = spawnSync('node', [
    'scripts/dsh-bridge-responder.mjs', '--root', root, '--mode', 'fixture', '--once',
  ], { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
  assert.equal(r.status, 0, '单次模式错误不致命，但要留痕');
  assert.match(`${r.stdout}${r.stderr}`, /job-error|缺少夹具文件/);
  assert.equal(existsSync(join(root, 'inbox', 'fx-1.probes.json')), false, '不得写"零资源"的假回执');
  void out;
});
