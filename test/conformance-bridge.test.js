// 一致性套件 × 真实桥接 adapter：跨进程执行层也要满足同一份 SPI 契约。
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
    const adapter = new RedteamModeAdapter({ driver: new DshRedteamDriver({ root, timeoutMs: 6000, pollMs: 25 }) });
    const results = await runConformance(adapter, { commandIdPrefix: 'confbridge', awaitStopMs: 1200 });
    const summary = summarize(results);
    assert.equal(summary.failed.length, 0,
      `桥接 adapter 未通过：\n${summary.failed.join('\n')}`);
    assert.ok(summary.total >= 5, `套件项数 ${summary.total}`);
  } finally {
    responder.kill('SIGTERM');
  }
});
