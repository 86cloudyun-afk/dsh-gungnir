// 执行层落地演练：fake 与 bridge 两模式都必须全链路通过（桥模式真起应答器）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const run = (args = []) => {
  try {
    const out = execFileSync('node', ['scripts/executor-drill.mjs', ...args],
      { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: `${e.stdout ?? ''}`, err: `${e.stderr ?? ''}` }; }
};

test('fake 模式：离线演练全链路通过', () => {
  const r = run(['--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, 'fake');
  assert.ok(parsed.steps >= 10, `步骤数应 ≥10，实际 ${parsed.steps}`);
  const names = parsed.detail.map((s) => s.name);
  for (const must of ['开工：冻结授权对象', '取出口', '派单', '回执入库', '结项', '一键交付']) {
    assert.ok(names.some((n) => n.includes(must)), `缺步骤：${must}`);
  }
});

test('bridge 模式：真起应答器子进程，跨进程链路通过', () => {
  const r = run(['--mode', 'bridge', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.mode, 'bridge');
  assert.equal(parsed.ok, true);
  assert.ok(parsed.detail.some((s) => s.name.includes('桥 + 应答器子进程')));
});

test('文本模式：人类可读的逐步输出与结论行', () => {
  const r = run([]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[✓\] 宿主启动/);
  assert.match(r.out, /演练结论：全链路通过/);
  assert.match(r.out, /步 · \d+ms/);
});
