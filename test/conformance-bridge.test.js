// 一致性套件 × 跨进程 echo 桥接 fixture：不运行真实执行器或模型。
// 这是"协议就绪"的硬证据：连 cancel/幂等/资源清单这些细节都过（不是只有 fake adapter 过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConformance, summarize } from '../packages/warroom-core/src/adapters/conformance.js';
import { RedteamModeAdapter } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { DshRedteamDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';

test('桥接 adapter 通过一致性套件（跨进程 + 幂等 + 停止证实）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-conf-bridge-'));
  const responder = spawn('node', [
    // echo 模式：应答器按契约回报它持有的资源（session/container），一致性套件才能验到"停止证实"
    'scripts/dsh-bridge-responder.mjs', '--root', root, '--interval', '25', '--mode', 'echo',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const driver = new DshRedteamDriver({ root, timeoutMs: 6000, pollMs: 25 });
    const adapter = new RedteamModeAdapter({ driver });
    const awaitState = (taskId, expected) => {
      const deadline = Date.now() + driver.timeoutMs;
      while (Date.now() < deadline) {
        const status = driver.statusOf(taskId);
        if (status?.state === expected) return status;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, driver.pollMs);
      }
      assert.fail(`echo fixture 未发布 ${expected}`);
    };
    const dispatch = adapter.dispatch.bind(adapter);
    adapter.dispatch = (commandId, contract) => {
      const result = dispatch(commandId, contract);
      // Fast running acknowledgement is not receipt readiness. Let this echo fixture
      // finish publishing its source envelopes before the suite asks it to stop.
      const status = awaitState(result.task_id, 'done');
      const facts = driver._readTaskEvidence(driver._factsPath(result.task_id), result.task_id);
      const probes = driver._readTaskEvidence(driver._probesPath(result.task_id), result.task_id);
      for (const source of [status, facts, probes]) {
        assert.equal(source.generation, contract.generation);
        assert.equal(source.event_seq, status.event_seq);
      }
      assert.ok(facts.members.length > 0);
      assert.ok(probes.resources.length > 0);
      return result;
    };
    const results = await runConformance(adapter, { commandIdPrefix: 'confbridge', awaitStopMs: 1200 });
    const summary = summarize(results);
    assert.equal(summary.failed.length, 0,
      `桥接 adapter 未通过：\n${summary.failed.join('\n')}`);
    assert.ok(summary.total >= 5, `套件项数 ${summary.total}`);
    awaitState('confbridge-task', 'confirmed_stopped');
    const stopped = adapter.manifestOf('confbridge-task');
    assert.ok(stopped.length > 0);
    assert.ok(stopped.every(resource => resource.check() === true));
  } finally {
    responder.kill('SIGTERM');
  }
});
