// 示例执行器命令 + 端到端：GUNGNIR ↔ 应答器 ↔ 执行器命令（三个进程）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { RedteamModeAdapter } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { DshRedteamDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';

test('example-role-cmd：按 role 产出占位事实与资源（stdin→stdout 契约）', () => {
  const job = JSON.stringify({
    protocol: 'gungnir-bridge/1', external_id: 'ex-1', role: 'chain',
    contract: { targets: ['10.0.0.5'], action_class: 'active', resources: ['container'], generation: '1:1:1' },
  });
  const r = spawnSync('node', ['executors/example-role-cmd.mjs'], { input: job, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.members[0].entity_type, 'chain');
  assert.equal(out.members[0].source_id, 'ex-1-chain');
  assert.equal(out.resources.length, 2, 'session + container');
});

test('三方端到端：GUNGNIR（测试进程）↔ 应答器（子进程）↔ 执行器命令（孙进程）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-exec-e2e-'));
  const root = join(home, 'dsh-bridge');
  mkdirSync(root, { recursive: true });

  const responder = spawn('node', [
    'scripts/dsh-bridge-responder.mjs', '--root', root, '--interval', '25',
    '--executor', 'executors/dsh-redteam-executor.mjs',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GUNGNIR_EXECUTOR_CMD: 'node executors/example-role-cmd.mjs' },
  });

  try {
    const adapter = new RedteamModeAdapter({ driver: new DshRedteamDriver({ root, timeoutMs: 3000, pollMs: 25 }) });
    const broker = new Broker({ home, adapter });
    const eng = broker.createEngagement({ user_message_id: 'um-exec', targets: ['10.0.0.0/24'], overrides: { rhythm: 'open' } });

    const ex = broker.execute({
      command_id: 'exec-e2e-1', engagement_id: eng.engagement_id, auth_version: 1,
      contract: { targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0, intent: 'recon' },
    });
    assert.equal(ex.state, 'running', '执行器应在超时前回执');

    const receipt = adapter.collect(ex.task_id);
    assert.equal(receipt.members.length, 1);
    const ingested = broker.collect(eng.engagement_id, ex.task_id, receipt);
    assert.equal(ingested.accepted, true);
    assert.equal(broker._eng(eng.engagement_id).store.effectiveCount(), 1);

    // 账本结项（执行器报告终态）→ 报告可导出
    broker.settle(eng.engagement_id, ex.task_id);
    const rep = broker.exportReport(eng.engagement_id, { format: 'both' });
    assert.ok(rep.paths.markdown && rep.paths.json);
  } finally {
    responder.kill('SIGTERM');
  }
});
