// 首启向导：建目录/配置/跳板示例/首战役，幂等且 --force 语义明确。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = () => ({ ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' });
const runInit = (home, extra = []) => JSON.parse(execFileSync('node',
  ['bin/warroom.mjs', 'init', '--home', home, '--json', ...extra], { encoding: 'utf8', env: env() }));

test('空目录：建 home + 写配置 + 打印下一步', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'wr-init-')), 'warroom');
  const r = runInit(home);
  assert.ok(existsSync(join(home, 'warroom.json')), '应写出配置');
  assert.equal(JSON.parse(readFileSync(join(home, 'warroom.json'), 'utf8')).rhythm, 'restricted');
  assert.ok(r.steps.some((s) => s.includes('家目录就绪')));
  assert.ok(r.next.some((n) => n.includes('doctor')));
});

test('带 --target：建首个战役并给演练提示', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'wr-init2-')), 'warroom');
  const r = runInit(home, ['--target', '10.0.0.0/24', '--rhythm', 'open']);
  assert.ok(r.steps.some((s) => s.includes('已建战役') && s.includes('rhythm=open')));
  assert.ok(r.next.some((n) => n.includes('wave --dry-run')));
});

test('--with-jumphost-sample 导入占位跳板；重复 init 不覆盖配置', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'wr-init3-')), 'warroom');
  const r1 = runInit(home, ['--with-jumphost-sample']);
  assert.ok(r1.steps.some((s) => s.includes('jh-sample')));
  const r2 = runInit(home, ['--with-jumphost-sample']);
  assert.ok(r2.steps.some((s) => s.includes('配置已存在，保留')), '重复 init 不应覆盖配置');
});
