// doctor 体检：结构与退出码（不依赖具体环境结果，只断言契约）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';

const run = (args) => {
  try {
    const out = execFileSync('node', ['scripts/doctor.mjs', ...args], { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};

test('未开工的 home：不失败，给出提示项', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-doc-empty-'));
  const r = run(['--home', home, '--json']);
  const parsed = JSON.parse(r.out);
  assert.ok(Array.isArray(parsed.checks) && parsed.checks.length >= 4);
  assert.equal(parsed.failed, 0);
  assert.ok(parsed.warned >= 1, '空 home 应有提示项（如尚无战役）');
});

test('有战役数据的 home：完整性检查通过、秘密密钥权限被检查', () => {
  const h = harness();
  h.broker.secrets.put('doctor-secret', { label: 'k' });
  const r = run(['--home', h.home, '--json']);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.failed, 0, JSON.stringify(parsed.checks));
  assert.ok(parsed.checks.some((c) => c.name.includes('战役库完整性') && c.status === 'ok'));
  assert.ok(parsed.checks.some((c) => c.name.includes('秘密密钥权限') && c.status === 'ok'));
});

test('CLI doctor 可用（文本模式）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-doc-cli-'));
  const out = execFileSync('node', ['bin/warroom.mjs', 'doctor', '--home', home],
    { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
  assert.match(out, /warroom doctor/);
  assert.match(out, /结论/);
});
