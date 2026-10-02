#!/usr/bin/env node
// 真实挂载验收（闭环第⑤步 · A）：用官方 boot API 在本机真实 DSH 里启动 web profile，
// 断言 GUNGNIR 预设**真的挂得上、且工具目录就是允许清单**。过了才打 HOST_VERIFIED 标记。
//
// 这正是 docs/ACCEPTANCE.md §8-1 / ADR-001 首行自认的「真实 DSH 挂载层生效」唯一未闭环项——
// 之前只有宿主校验器 + schema 校验，没有在真实进程里跑过。本脚本把它真正关掉。
//
// 验收断言（全部用官方注册表/工具服务，不看日志、不发模型请求）：
//   (1) agentPresets.list() 里 warroom-gungnir 存在且 broken===undefined；**全表无任何 broken**
//       （broken 文本即 auditRows 的 "failed to import"/激活失败汇总）。
//   (2) retain('warroom-gungnir') 不抛（broken 预设会抛 agent-preset/invalid）。
//   (3) 主控会话继承锚（预设 standing mount scope）的可见工具目录 = 允许集：
//       恰好 36 个 warroom_*，且不含任何内核工具（bash/write/edit/subagent/workflow/run_code...）。
//
// 用法：
//   node scripts/verify-host.mjs                               # 本机发现 DSH；缺宝→SKIP（退出 0）
//   node scripts/verify-host.mjs --install-anchor <pkg.json>   # 显式指向官方 @deepseek-ai/dsh/package.json
//   node scripts/verify-host.mjs --require-host                # CI 用：缺宝→失败（不静默通过）
//   node scripts/verify-host.mjs --json                        # 机器可读结果
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'install-anchor': { type: 'string' },
    'require-host': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

/** 内核工具负样本：这些一旦出现在主控会话工具目录里，就是挂载层隔离被击穿。 */
const KERNEL = Object.freeze([
  'bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'apply_patch',
  'subagent', 'subagent_fork', 'subagent_control', 'list_agents',
  'workflow', 'job_list', 'job_output', 'job_kill', 'run_code', 'fs_read', 'fs_write',
]);

/** 判断一个路径是否就是官方 @deepseek-ai/dsh 的 package.json（fail-closed：名字不符即拒）。 */
function isAnchor(pkgJson) {
  try { return JSON.parse(readFileSync(pkgJson, 'utf8')).name === '@deepseek-ai/dsh'; }
  catch { return false; }
}

/**
 * 定位本机官方 DSH 安装目录（含 lib/profile-boot.js）。
 * 优先级：--install-anchor（显式 package.json，必须名实相符）> DSH_PKG_DIR > node 前缀下的全局安装。
 * @returns {{dir:string, anchor:string}|null}
 */
function resolveHost() {
  const anchorArg = v['install-anchor'] ?? process.env.DSH_INSTALL_ANCHOR;
  if (anchorArg) {
    const anchor = resolve(anchorArg);
    if (!isAnchor(anchor)) throw new Error(`UNVERIFIED: --install-anchor 必须指向 @deepseek-ai/dsh/package.json（得到：${anchor}）`);
    const dir = dirname(anchor);
    if (!existsSync(join(dir, 'lib', 'profile-boot.js'))) throw new Error(`UNVERIFIED: anchor 目录缺 lib/profile-boot.js：${dir}`);
    return { dir, anchor };
  }
  const cands = [
    process.env.DSH_PKG_DIR,
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(Boolean);
  for (const dir of cands) {
    if (existsSync(join(dir, 'lib', 'profile-boot.js')) && isAnchor(join(dir, 'package.json'))) {
      return { dir, anchor: join(dir, 'package.json') };
    }
  }
  return null;
}

/** 本预设声明的允许集里纯 warroom_* 部分（skill 由宿主提供、不在插件注册面）。 */
function declaredWarroom() {
  const decl = JSON.parse(readFileSync(join(root, 'presets', 'warroom.preset.json'), 'utf8'));
  return (decl?.toolPolicy?.allow ?? []).filter((n) => n.startsWith('warroom_')).sort();
}

async function verifyHost({ dir, anchor }) {
  const checks = [];
  const pass = (name) => { checks.push(name); if (!v.json) console.log(`HOST_PASS: ${name}`); };

  const { runProfile } = await import(pathToFileURL(join(dir, 'lib', 'profile-boot.js')).href);
  const dshRequire = createRequire(join(dir, 'package.json'));
  const { createLaunchEnvironmentSnapshot } = await import(
    pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-launch-environment')).href);
  const dshVersion = JSON.parse(readFileSync(anchor, 'utf8')).version;
  const binJs = join(dir, 'lib', 'bin.js');

  // 隔离 home：init shipped web profile → 写入本预设挂载行（真实契约路径，与部署脚本一致）
  const home = mkdtempSync(join(tmpdir(), 'wr-hostverify-'));
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  delete env.DSH_PROFILE_DIR;
  execFileSync(process.execPath, [binJs, '--profile', 'web', '--dump-config'], { env, stdio: 'ignore' });
  execFileSync(process.execPath, [join(root, 'scripts', 'deploy-dsh.mjs'), '--apply', '--home', home], { env, stdio: 'ignore' });

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let booted;
  try {
    booted = await runProfile({
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]),
      profile: 'web', patchFiles: [], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    });
    const { ctx } = booted;
    if (ctx.get('loader')?.await) await ctx.get('loader').await();

    const ap = ctx.get('agentPresets');
    if (!ap) throw new Error('UNVERIFIED: agentPresets 注册表不可用（宿主契约变化？）');

    // (1) 全表无 broken + 本预设在册
    const list = await ap.list();
    const broken = list.filter((p) => p.broken !== undefined);
    if (broken.length > 0) throw new Error(`预设装配失败（broken）：${broken.map((p) => `${p.id}: ${p.broken}`).join(' | ')}`);
    const self = list.find((p) => p.id === 'warroom-gungnir');
    if (!self) throw new Error('预设 warroom-gungnir 未出现在 list()（挂载行未生效）');
    pass(`注册表无 broken（${list.length} 预设）且 warroom-gungnir 在册`);

    // (2) retain 成功（broken 会抛 agent-preset/invalid）
    const gen = await ap.retain('warroom-gungnir');
    try {
      if (gen.mount.presetId !== 'warroom-gungnir') throw new Error(`retain 返回了非预期预设：${gen.mount.presetId}`);
      pass('retain 成功绑定预设 standing 挂载');

      // (3) 主控会话继承锚的可见工具目录 = 允许集
      const tools = ctx.get('tools');
      const visible = [...tools.view(gen.mount.key).visible.keys()];
      const warroom = visible.filter((n) => n.startsWith('warroom_')).sort();
      const want = declaredWarroom();
      const missing = want.filter((n) => !warroom.includes(n));
      const extra = warroom.filter((n) => !want.includes(n));
      if (missing.length || extra.length) {
        throw new Error(`warroom 工具目录与允许清单不符：缺 ${missing.join(',') || '无'}｜多 ${extra.join(',') || '无'}`);
      }
      const kernelHit = visible.filter((n) => KERNEL.includes(n));
      if (kernelHit.length) throw new Error(`工具目录含内核工具（隔离被击穿）：${kernelHit.join(', ')}`);
      pass(`工具目录 = 允许集（${warroom.length} 个 warroom_*，0 内核工具；可见共 ${visible.length}）`);

      return { ok: true, dsh: dshVersion, node: process.version, checks, warroom: warroom.length, visible: visible.length };
    } finally { gen.users--; }
  } finally {
    try { await (booted?.shutdown?.shutdown?.(0) ?? booted?.ctx?.fiber?.dispose()); } catch { /* 卸载失败不阻断清理 */ }
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  }
}

let host;
try { host = resolveHost(); }
catch (e) {
  // anchor 明确给错（名实不符）始终是硬失败，无论是否 --require-host
  console.error(`HOST_FAILED: ${e.message}`);
  process.exit(1);
}

if (!host) {
  const msg = '未找到本机官方 DSH（设置 DSH_PKG_DIR 或 --install-anchor <@deepseek-ai/dsh/package.json>）';
  if (v['require-host']) { console.error(`HOST_FAILED: ${msg}（--require-host 下缺宝即失败，拒绝静默通过）`); process.exit(1); }
  if (v.json) console.log(JSON.stringify({ ok: null, skipped: true, reason: msg }, null, 2));
  else console.log(`HOST_SKIPPED: ${msg}`);
  process.exit(0);
}

try {
  const result = await verifyHost(host);
  if (v.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`HOST_VERIFIED: DSH ${result.dsh}, Node ${result.node}, ${result.checks.length} 项断言全过`);
  process.exit(0);
} catch (e) {
  if (v.json) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  else console.error(`HOST_FAILED: ${e.message}`);
  process.exit(1);
}
