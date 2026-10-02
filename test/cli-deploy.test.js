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

/**
 * 轻量校验：overlay 必须能作为「顶层块序列」被 YAML 解析器接受——
 * 复刻 dsh 的 overlay 解析契约失败点：丢弃注释/空行后，首个有效行须是块序列项（`- `），
 * 且不得出现 flow 空数组 `[]` 与块序列项混用（旧实现正是在 `[]` 后拼 `- insert:`，
 * dsh 报 "end of the stream or a document separator is expected"）。
 */
function assertValidBlockSeqYaml(text) {
  const meaningful = text.split('\n').map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  assert.ok(meaningful.length > 0, 'overlay 不应为空');
  assert.ok(!meaningful.some((l) => l.trim() === '[]'), '不得残留 flow 空数组 [] 存根');
  assert.ok(meaningful[0].startsWith('- '), `顶层须为块序列，实际首行：${meaningful[0]}`);
}

test('deploy --apply 对 DSH 默认 [] 存根生成合法 YAML（不再 [] 后拼块序列）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-deploy-stub-'));
  const profile = join(home, 'profiles', 'web');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(profile, { recursive: true });
  const patch = join(profile, 'cordis.patch.yml');
  // 复刻 dsh web 首启生成的用户 overlay 存根：注释头 + flow 空数组 []
  writeFileSync(patch, '# Your patch layer for this dsh profile.\n# a top-level YAML array of loader patch entries.\n[]\n');

  execFileSync('node', ['scripts/deploy-dsh.mjs', '--apply', '--home', home], { encoding: 'utf8', env: nodeEnv() });
  const out = readFileSync(patch, 'utf8');
  assert.match(out, /id: warroom-gungnir/);
  assert.match(out, /- insert:/);
  assert.match(out, /# Your patch layer/, '原注释头应保留');
  assertValidBlockSeqYaml(out); // 关键：旧实现在此失败（[] 与块序列混用）

  // 幂等：对 [] 存根二次 apply 不重复插入、文件不变
  execFileSync('node', ['scripts/deploy-dsh.mjs', '--apply', '--home', home], { encoding: 'utf8', env: nodeEnv() });
  const out2 = readFileSync(patch, 'utf8');
  assert.equal(out, out2, '对 [] 存根的二次 apply 应幂等');
  assert.equal((out2.match(/id: warroom-gungnir/g) || []).length, 1, '不得重复插入同 id');
});

test('deploy --apply 对缺文件生成纯块序列（无 [] 残留）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-deploy-missing-'));
  const profile = join(home, 'profiles', 'web');
  execFileSync('node', ['-e', `require('node:fs').mkdirSync(${JSON.stringify(profile)},{recursive:true})`]);
  const patch = join(profile, 'cordis.patch.yml');
  // 不预建 patch 文件
  execFileSync('node', ['scripts/deploy-dsh.mjs', '--apply', '--home', home], { encoding: 'utf8', env: nodeEnv() });
  const out = readFileSync(patch, 'utf8');
  assert.match(out, /id: warroom-gungnir/);
  assertValidBlockSeqYaml(out);
});
