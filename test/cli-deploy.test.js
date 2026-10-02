// CLI 全子命令 + 部署脚本（dry-run）回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 隔离执行：清掉真实 DSH 环境变量，避免误写操作员的 profile（曾真实发生，见 PR 描述）。 */
function nodeEnv() {
  const env = { ...process.env };
  delete env.DSH_PROFILE_DIR;
  delete env.DSH_HOME;
  return env;
}

function cli(home, args) {
  return JSON.parse(execFileSync('node', ['bin/warroom.mjs', ...args, '--home', home, '--json'], { encoding: 'utf8', env: nodeEnv() }));
}

test('CLI shell / spray / metrics 子命令可用', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-cli2-'));
  const eng = cli(home, ['engage', '--target', '10.0.0.0/24']);

  const proof = cli(home, ['shell', 'proof', '--engagement', eng.engagement_id, '--proof', 'root@10.0.0.5']);
  assert.equal(proof.highest_proof, 'root@10.0.0.5');
  assert.equal(proof.current_validity, 'unknown');
  const verified = cli(home, ['shell', 'verify', '--engagement', eng.engagement_id, '--validity', 'likely']);
  assert.equal(verified.current_validity, 'likely');

  const check1 = cli(home, ['spray', 'check', '--engagement', eng.engagement_id,
    '--credential-ref', 'sec_1', '--service', 'ssh', '--account', 'root']);
  assert.deepEqual(check1, { locked: false, tried: false });
  cli(home, ['spray', 'record', '--engagement', eng.engagement_id,
    '--credential-ref', 'sec_1', '--service', 'ssh', '--account', 'root', '--result', 'fail']);
  const check2 = cli(home, ['spray', 'check', '--engagement', eng.engagement_id,
    '--credential-ref', 'sec_1', '--service', 'ssh', '--account', 'root']);
  assert.equal(check2.tried, true);

  const ex = cli(home, ['exec', '--engagement', eng.engagement_id, '--command-id', 'cli-m1',
    '--target', '10.0.0.5', '--class', 'active']);
  const m = cli(home, ['metrics', '--engagement', eng.engagement_id, '--command-id', 'cli-m1',
    '--tokens-in', '100', '--tokens-out', '20', '--wall-time-ms', '5000', '--verified-facts', '2', '--role', 'recon']);
  assert.equal(m.tokens_in, 100);
  assert.equal(m.by_role.recon.verified, 2);
  void ex;
});

test('deploy 脚本：--print 输出合法挂载片段；--check 报告 profile 状态', () => {
  const snippet = execFileSync('node', ['scripts/deploy-dsh.mjs', '--print'], { encoding: 'utf8' });
  assert.match(snippet, /id: warroom-gungnir/);
  assert.match(snippet, /preset: .*warroom\.preset\.json/);

  const home = mkdtempSync(join(tmpdir(), 'wr-deploy-'));
  const check = execFileSync('node', ['scripts/deploy-dsh.mjs', '--check', '--home', home], { encoding: 'utf8', env: nodeEnv() });
  assert.match(check, /预设文件可读/);
});

test('deploy 脚本 --apply 幂等且先备份', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-deploy2-'));
  const profile = join(home, 'profiles', 'web');
  execFileSync('node', ['-e', `require('node:fs').mkdirSync(${JSON.stringify(profile)},{recursive:true})`]);
  const patch = join(profile, 'cordis.patch.yml');
  writeFileSync(patch, '# 原有内容\n- insert:\n    - id: dsh-ops-console\n      name: dsh-ops-console\n');

  execFileSync('node', ['scripts/deploy-dsh.mjs', '--apply', '--home', home], { encoding: 'utf8', env: nodeEnv() });
  const after1 = readFileSync(patch, 'utf8');
  assert.equal(existsSync(join(profile, 'cordis.patch.yml.bak-warroom-')), false, '备份名精确检查见下');
  assert.match(after1, /dsh-ops-console/, '原有内容必须保留');
  assert.match(after1, /warroom-gungnir/);

  // 幂等：再跑一次不重复插入
  execFileSync('node', ['scripts/deploy-dsh.mjs', '--apply', '--home', home], { encoding: 'utf8', env: nodeEnv() });
  const after2 = readFileSync(patch, 'utf8');
  assert.equal(after1, after2, '重复 apply 不得改动文件');
  const { readdirSync } = await import('node:fs');
  const backups = readdirSync(profile).filter((f) => f.startsWith('cordis.patch.yml.bak-warroom-'));
  assert.equal(backups.length, 1, '首次 apply 应留一份备份，第二次（幂等）不留新备份');
});

test('deploy --print 的挂载 name 等于真实包名 dsh-warroom（防名不匹配回归）', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../packages/warroom-plugin/package.json', import.meta.url), 'utf8'));
  const snippet = execFileSync('node', ['scripts/deploy-dsh.mjs', '--print'], { encoding: 'utf8' });
  // 片段里的 name 必须正是真实包名（否则 dsh 挂载 require.resolve → MODULE_NOT_FOUND）
  assert.match(snippet, new RegExp(`name:\\s*${pkg.name}(\\s|$)`, 'm'));
  assert.doesNotMatch(snippet, /dsh-warroom-preset/, '不得再出现错误包名 dsh-warroom-preset');
});
