// 真实挂载基底验收（agent-preset + config.plugins 主线）：预设必须**干净 activate**。
// 用官方 boot API 探测（不看日志）：agentPresets.list() 无 broken + retain() 可绑定。
// 回归根因：dsh-entry 曾用 ctx.provide('warroom') 发布进 root realm → 泄漏 → 整挂被拒。
// 依赖本机 DSH 0.2.0-rc.2；宿主不可用时如实 SKIP（不假装通过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** 定位本机 @deepseek-ai/dsh（nvm/global 安装：node 前缀下的 lib/node_modules）。可用 DSH_PKG_DIR 覆盖。 */
function findDshDir() {
  const cands = [
    process.env.DSH_PKG_DIR,
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(Boolean);
  return cands.find((d) => existsSync(join(d, 'lib', 'profile-boot.js'))) ?? null;
}

const dshDir = findDshDir();

test('真实挂载基底：预设干净 activate（list() 无 broken + retain 成功绑定）', async (t) => {
  if (!dshDir) return t.skip('未找到本机 DSH（设置 DSH_PKG_DIR 指向 @deepseek-ai/dsh）');
  const { runProfile } = await import(pathToFileURL(join(dshDir, 'lib', 'profile-boot.js')).href);
  // 用宿主自带的快照构造器生成忠实的 environment（带 get/getFrom），避免假 env 触发无关 host 行报错
  const dshRequire = createRequire(join(dshDir, 'package.json'));
  const { createLaunchEnvironmentSnapshot } = await import(
    pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-launch-environment')).href
  );
  const binJs = join(dshDir, 'lib', 'bin.js');

  const home = mkdtempSync(join(tmpdir(), 'wr-iso-'));
  const env = { ...process.env, DSH_HOME: home };
  delete env.DSH_PROFILE_DIR;

  // 1) 初始化 shipped web profile（生成 cordis.yml/package.json 等）
  execFileSync(process.execPath, [binJs, '--profile', 'web', '--dump-config'], { env, stdio: 'ignore' });
  // 2) 写入本预设挂载行（agent-preset + config.plugins）
  execFileSync(process.execPath, ['scripts/deploy-dsh.mjs', '--apply', '--home', home], { env, stdio: 'ignore' });

  // 3) 用官方 boot API 启动并探测。runProfile 读 process.env.DSH_HOME。
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let booted;
  try {
    booted = await runProfile({
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]),
      profile: 'web',
      patchFiles: [],
      args: ['--no-open', '--port', '0'], // 0 = OS 选空闲端口，避免占用冲突
    });
    const { ctx } = booted;
    if (ctx.get('loader')?.await) await ctx.get('loader').await();

    const ap = ctx.get('agentPresets');
    assert.ok(ap, 'agentPresets 服务应存在');

    const list = await ap.list();
    const w = list.find((p) => p.id === 'warroom-gungnir');
    assert.ok(w, '预设 warroom-gungnir 应在 list() 中');
    assert.equal(w.broken, undefined, `预设不得 broken（isolate-realm 泄漏回归）：${w.broken ?? ''}`);

    // retain 不抛 = 预设可被 agent 绑定运行（broken 预设会抛 agent-preset/invalid）
    const gen = await ap.retain('warroom-gungnir');
    assert.equal(gen.mount.presetId, 'warroom-gungnir');
    gen.users--;
  } finally {
    try { await (booted?.shutdown?.shutdown?.(0) ?? booted?.ctx?.fiber?.dispose()); } catch { /* 卸载失败不阻断 */ }
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
});
