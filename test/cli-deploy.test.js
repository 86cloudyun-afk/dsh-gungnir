// CLI 全子命令 + 部署脚本（dry-run）回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
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
  // 真实契约（dsh 0.2.0-rc.2）：一行 `@deepseek-ai/dsh-agent-preset` + 子插件清单
  assert.match(snippet, /id: preset-warroom-gungnir/);
  assert.match(snippet, /name: '@deepseek-ai\/dsh-agent-preset'/);
  assert.match(snippet, /packages\/warroom-plugin\/src\/dsh-entry\.mjs/);
  assert.match(snippet, /presets\/roles\/commander\.md/, '角色文本在运行期读文件');
  assert.match(snippet, /warroom\.preset\.json/, '声明文件可追溯');

  const home = mkdtempSync(join(tmpdir(), 'wr-deploy-'));
  const check = execFileSync('node', ['scripts/deploy-dsh.mjs', '--check', '--home', home], { encoding: 'utf8', env: nodeEnv() });
  assert.match(check, /预设文件可读（声明允许清单 \d+ 项）/);
  assert.match(check, /声明允许清单 == 实际注册工具（\d+ 个/);
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
 * patch 合并：必须始终产出**合法的顶层块序列 YAML**。
 * 真机故障（PR #138 复现）：DSH 首启存根是「注释头 + flow 空数组 `[]`」，
 * 直接追加 `- insert:` 会得到 `[]` 与块序列项混用 → dsh 报
 * "end of the stream or a document separator is expected"，整条挂载失效。
 */
test('patch 合并：[] 存根 / 空文件 / 已有块序列 三种现状都产出合法 YAML', async () => {
  const { mergeOverlay } = await import('../scripts/deploy-dsh.mjs');
  const snippet = '- insert:\n    - id: preset-warroom-gungnir\n';
  const valid = (text) => {
    const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (lines.length === 0) return false;
    assert.equal(lines.some((l) => l.trim() === '[]'), false, '不得残留 flow 空数组');
    assert.match(lines[0], /^-\s/, '首个有效行必须是块序列项');
    return true;
  };

  const stub = '# Your patch layer\n# keep it\n\n[]\n';
  const a = mergeOverlay(stub, snippet);
  assert.equal(valid(a), true);
  assert.match(a, /# Your patch layer/, '注释头保留');
  assert.match(a, /id: preset-warroom-gungnir/);

  const empty = '';
  assert.equal(valid(mergeOverlay(empty, snippet)), true);

  const existing = '- id: dsh-ops-console\n  name: dsh-ops-console\n';
  const c = mergeOverlay(existing, snippet);
  assert.equal(valid(c), true);
  assert.match(c, /dsh-ops-console/, '既有条目必须保留');
});

test('插件包按名挂载时可用：package name 与 default 插件 name 一致', async () => {
  const pkg = JSON.parse(readFileSync('packages/warroom-plugin/package.json', 'utf8'));
  const mod = await import('../packages/warroom-plugin/src/index.js');
  assert.equal(pkg.name, 'dsh-warroom');
  assert.equal(typeof mod.default, 'object', '必须暴露 default 导出（cordis 按包名取 . 入口的 default）');
  assert.equal(typeof mod.default.apply, 'function');
  assert.equal(mod.default.name, pkg.name, '插件名必须等于真实包名，否则宿主按 name 解析会 MODULE_NOT_FOUND');
  assert.match(execFileSync('node', ['scripts/deploy-dsh.mjs', '--print'], { encoding: 'utf8' }),
    /packages\/warroom-plugin\/src\/dsh-entry\.mjs/, '预设内按绝对路径挂载（不依赖包名解析）');
});

test('CI 友好：没有 dsh 可执行时 --check 仍成功（只影响 --verify）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-deploy-nobin-'));
  const profile = join(home, 'profiles', 'web');
  execFileSync('node', ['-e', `require('node:fs').mkdirSync(${JSON.stringify(profile)},{recursive:true})`]);
  // 复刻 CI runner：PATH 里只有 node，没有 dsh
  const binDir = mkdtempSync(join(tmpdir(), 'wr-binonly-'));
  symlinkSync(process.execPath, join(binDir, 'node'));
  const out = execFileSync('node', ['scripts/deploy-dsh.mjs', '--check', '--home', home],
    { encoding: 'utf8', env: { ...nodeEnv(), PATH: binDir, DSH_BIN: '' } });
  assert.match(out, /未找到 dsh 可执行（--verify 不可用；挂载仍可写入）/);
});

test('宿主新鲜度判定：patch 写了没重启必须被报出来（"没有啊"的根因）', async () => {
  const { hostStaleness } = await import('../scripts/deploy-dsh.mjs');
  const patch = Date.parse('2026-10-02T14:36:05Z');
  const old = Date.parse('2026-09-30T14:39:35Z');

  const stale = hostStaleness(old, patch);
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'host-started-before-patch');

  assert.equal(hostStaleness(patch + 60_000, patch).stale, false);
  assert.equal(hostStaleness(null, patch).stale, null, '取不到进程启动时刻时如实未知');
  assert.equal(hostStaleness(old, null).stale, null);
});

test('--check 在真实 profile 上会输出"宿主是否已重启"结论', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-deploy-stale-'));
  const profile = join(home, 'profiles', 'web');
  execFileSync('node', ['-e', `require('node:fs').mkdirSync(${JSON.stringify(profile)},{recursive:true})`]);
  const patch = join(profile, 'cordis.patch.yml');
  writeFileSync(patch, '- insert:\n    - id: preset-warroom-gungnir\n      name: x\n');
  const out = execFileSync('node', ['scripts/deploy-dsh.mjs', '--check', '--home', home],
    { encoding: 'utf8', env: { ...nodeEnv(), DSH_PORT: '1' } });   // 端口 1 上不会有宿主
  assert.match(out, /宿主未重启|无法判定宿主是否重启/, '必须给出明确结论，不能沉默');
});
test('宿主检测按端口收敛：别的 DSH_HOME 下同名 profile 的宿主在跑，也不误判本 profile 有宿主（flake 回归）', async () => {
  const { hostProcessStartMs } = await import('../scripts/deploy-dsh.mjs');
  // 造一个"看起来像 dsh web 宿主"的并行进程：命令行含 `bin.js --profile web`，但不监听任何端口
  // （复刻其它 DSH_HOME 下并行起的宿主——它们各绑随机端口，不是本次部署的目标端口）。
  // 修复前：目标端口无监听者 → 回落到全局 `pgrep -f --profile web` → 误命中此进程 → 返回非 null
  //         → 本应"无宿主"的部署偶发判成"有宿主"。修复后：回落收敛到目标端口 → 返回 null。
  const fakeDir = mkdtempSync(join(tmpdir(), 'wr-fakehost-'));
  const fakeBin = join(fakeDir, 'bin.js');
  writeFileSync(fakeBin, 'setInterval(() => {}, 1e9);\n');
  const child = spawn(process.execPath, [fakeBin, '--profile', 'web', '--host'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 400));   // 等 pgrep 能看到它
    // 目标端口（1，测试环境绝无监听者）上无宿主 → 尽管存在同名 profile 的进程，也必须判"无宿主"
    const started = hostProcessStartMs('web', 1);
    assert.equal(started, null, '目标端口无监听者时，不得误命中其它 home 的同名 profile 宿主');
  } finally {
    child.kill('SIGKILL');
  }
});
