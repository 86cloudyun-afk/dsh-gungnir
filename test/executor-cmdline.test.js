// GUNGNIR_EXECUTOR_CMD argv 解析：空格路径 / JSON 数组 / 引号 / fail-closed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCmdline } from '../executors/parse-cmdline.mjs';

test('parseCmdline：无空格向后兼容（空白分词）', () => {
  assert.deepEqual(parseCmdline('node script.mjs --json'), ['node', 'script.mjs', '--json']);
  assert.deepEqual(parseCmdline('  /usr/bin/node   a.mjs  '), ['/usr/bin/node', 'a.mjs']);
});

test('parseCmdline：双引号保留空格路径', () => {
  assert.deepEqual(
    parseCmdline('"/opt/node versions/node" "/tmp/my script.mjs" --flag'),
    ['/opt/node versions/node', '/tmp/my script.mjs', '--flag'],
  );
});

test('parseCmdline：单引号与转义引号', () => {
  assert.deepEqual(parseCmdline("'/opt/a b/node' 'x y.mjs'"), ['/opt/a b/node', 'x y.mjs']);
  assert.deepEqual(parseCmdline('"/opt/say \\"hi\\"" arg'), ['/opt/say "hi"', 'arg']);
});

test('parseCmdline：JSON 数组（推荐有空格时使用）', () => {
  const raw = JSON.stringify(['/opt/node versions/node', '/tmp/boom script.mjs', '--json']);
  assert.deepEqual(parseCmdline(raw), ['/opt/node versions/node', '/tmp/boom script.mjs', '--json']);
});

test('parseCmdline：fail-closed（空 / 未闭合引号 / 非法 JSON / 空数组）', () => {
  assert.throws(() => parseCmdline(''), /为空/);
  assert.throws(() => parseCmdline('   '), /为空/);
  assert.throws(() => parseCmdline('"/opt/node'), /引号未闭合/);
  assert.throws(() => parseCmdline('[not-json'), /JSON 数组非法/);
  assert.throws(() => parseCmdline('[]'), /非空字符串列表/);
  assert.throws(() => parseCmdline('["", "a"]'), /非空字符串/);
  assert.throws(() => parseCmdline('[1, "a"]'), /非空字符串/);
});

test('执行器集成：JSON 数组 + 含空格脚本路径 → 诊断包装仍见 exit=9 与 stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-argv-space-'));
  const spaced = join(dir, 'boom script.mjs');
  writeFileSync(spaced, `process.stderr.write('具体原因: 工具没装\\n'); process.exit(9);`);
  // 用 JSON 数组保留 process.execPath 与含空格脚本的边界（不再依赖 split(' ')）
  process.env.GUNGNIR_EXECUTOR_CMD = JSON.stringify([process.execPath, spaced]);
  try {
    const mod = await import('../executors/dsh-redteam-executor.mjs?' + Date.now()); // bust cache if any
    await assert.rejects(
      () => mod.default.run({ external_id: 'x', role: 'recon', contract: { targets: ['t'] } }),
      (e) => /exit=9/.test(e.message) && /具体原因/.test(e.message),
    );
  } finally {
    delete process.env.GUNGNIR_EXECUTOR_CMD;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('执行器集成：引号分词 + 含空格脚本路径同样可诊断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-argv-q-'));
  const spaced = join(dir, 'boom script.mjs');
  writeFileSync(spaced, `process.stderr.write('具体原因: 引号路径\\n'); process.exit(7);`);
  // 双引号包裹两侧；execPath 本身通常无空格，也一并加引号以覆盖解析路径
  process.env.GUNGNIR_EXECUTOR_CMD = `"${process.execPath}" "${spaced}"`;
  try {
    const mod = await import('../executors/dsh-redteam-executor.mjs?' + Date.now() + 'q');
    await assert.rejects(
      () => mod.default.run({ external_id: 'y', role: 'recon', contract: { targets: ['t'] } }),
      (e) => /exit=7/.test(e.message) && /引号路径/.test(e.message),
    );
  } finally {
    delete process.env.GUNGNIR_EXECUTOR_CMD;
    rmSync(dir, { recursive: true, force: true });
  }
});
