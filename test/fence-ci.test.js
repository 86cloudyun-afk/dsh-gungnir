// 围栏验收的 CI 语义：daemon 不可用时默认 SKIP（退出 0），--require-daemon 时视为失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const daemonUp = () => {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
};

const runFence = (extra = []) => {
  try {
    const out = execFileSync('node', ['scripts/fence-verify.mjs', '--engagement', 'eng_ci_test', ...extra],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

test('本机无 daemon：默认 SKIP 退出 0，且明确说明原因', () => {
  if (daemonUp()) return; // 有 daemon 的机器走真实路径，本测试不适用
  const r = runFence([ '--json' ]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.result.status, 'skipped');
  assert.match(parsed.result.reason, /daemon/);
});

test('本机无 daemon：--require-daemon 必须失败（防静默通过）', () => {
  if (daemonUp()) return;
  const r = runFence(['--require-daemon']);
  assert.equal(r.code, 1);
  assert.match(r.out, /require-daemon/);
});

test('静态不变量在任何环境都必须通过（拓扑本身与 daemon 无关）', () => {
  const r = runFence(['--json']);
  const parsed = JSON.parse(r.out);
  assert.ok(parsed.plan.network.name.length > 0);
  assert.equal(parsed.plan.network.internal, true);
  assert.deepEqual(parsed.plan.task.networks, [parsed.plan.network.name]);
  assert.equal(parsed.plan.sidecar.networks.length, 2);
});
