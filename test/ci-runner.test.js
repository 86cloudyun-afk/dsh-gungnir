// 单命令门禁：闸门清单、子集执行、失败传播（用最便宜的闸门做真跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const env = () => ({ ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' });
const run = (args) => {
  try {
    return { code: 0, out: execFileSync('node', ['scripts/ci.mjs', ...args], { encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { code: e.status, out: `${e.stdout ?? ''}`, err: `${e.stderr ?? ''}` }; }
};

test('--list 列出六道闸', () => {
  const r = run(['--list']);
  assert.equal(r.code, 0);
  for (const name of ['test', 'tool-schema', 'preset', 'fault-matrix', 'docs', 'self-review']) {
    assert.match(r.out, new RegExp(`^${name}\\b`, 'm'));
  }
});

test('--only 跑子集并给出汇总行（真跑最便宜的两道闸）', () => {
  const r = run(['--only', 'tool-schema,docs']);
  assert.equal(r.code, 0, r.out + (r.err ?? ''));
  assert.match(r.out, /=== 门禁汇总 ===/);
  assert.match(r.out, /\[✓\] tool-schema/);
  assert.match(r.out, /结论：全部通过/);
});

test('--quiet：只输出汇总，退出码仍真实反映成败（无需管道 tail）', () => {
  const ok = run(['--only', 'tool-schema,preset', '--quiet']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /=== 门禁汇总 ===/);
  assert.equal(ok.out.includes('=== tool-schema：'), false, 'quiet 模式不打印逐闸表头');
});

test('--only 无匹配 → 退出码 2 且提示可用闸门', () => {
  const r = run(['--only', 'nope']);
  assert.equal(r.code, 2);
  assert.match(r.err ?? r.out, /没匹配到任何闸门/);
});
