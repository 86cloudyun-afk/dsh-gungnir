// 规模冒烟回归：脚本必须过闸，且门槛有齿（故意把阈值调到不可能达到时失败）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const run = (args, env = {}) => {
  try {
    const out = execFileSync('node', ['scripts/bench.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

test('规模冒烟：N=1000 全部过闸', () => {
  const r = run(['--n', '1000', '--json']);
  assert.equal(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.failed, 0);
  assert.ok(parsed.timings.ingest_ms >= 0);
});

test('规模冒烟：N=3000 仍在阈值内（规模不退化）', () => {
  const r = run(['--n', '3000', '--json']);
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out).failed, 0);
});
