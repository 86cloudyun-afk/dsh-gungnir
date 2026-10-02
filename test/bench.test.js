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

test('规模冒烟：扩展门（审计/JSON 报告/矩阵）在 N=2000 下过闸', () => {
  const r = run(['--n', '2000', '--json']);
  assert.equal(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.failed, 0);
  for (const k of ['audit_export_ms', 'json_report_ms', 'matrix_ms']) {
    assert.ok(typeof parsed.timings[k] === 'number', `缺少 ${k}`);
  }
});

test('规模冒烟：维护门（证据落盘 + 全库备份）在 N=3000 下过闸', () => {
  const r = run(['--n', '3000', '--json']);
  assert.equal(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.failed, 0);
  assert.ok(typeof parsed.timings.evidence_export_ms === 'number');
  assert.ok(typeof parsed.timings.backup_ms === 'number');
});
