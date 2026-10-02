// 真实挂载闭环 ④：apply 消费 allowlist 预设（toolPolicy）并接 DSH 工具门控。
// 单元（hermetic）：allowlist 源头过滤 + 向后兼容 + loadToolPolicy 读 preset 文件。
// 验收（本机 DSH 0.2.0-rc.2 + 官方 boot API，缺宝 SKIP）：主控会话工具目录 = 允许清单全集 warroom_*（与 TOOL_NAMES 同源），无内核工具。
import { test } from 'node:test';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const { default: entry, loadToolPolicy } = await import('../packages/warroom-plugin/src/dsh-entry.mjs');
const { TOOL_NAMES } = await import('../packages/warroom-plugin/src/tools.js');

function fakeTools() {
  const registered = [];
  return { registered, tools: { register: (d) => { registered.push(d.name); return () => {}; } }, on() {} };
}

/** 工具总数（与工具表同源，不再写死数字）。 */
const TOOLS_LEN = TOOLS.length;

test('allowlist 源头过滤：toolPolicy.allow 为子集时只注册允许集内的 warroom 工具', () => {
  const f = fakeTools();
  const subset = TOOL_NAMES.slice(0, 5);
  const svc = entry.apply({ tools: f.tools, on: f.on }, {
    home: '/tmp/wr-tp-1', toolPolicy: { mode: 'allowlist', allow: [...subset, 'skill'] },
  });
  assert.deepEqual([...f.registered].sort(), [...subset].sort(), '只应注册允许集内的 warroom 工具');
  assert.equal(svc.allowlistSize, 6);
  assert.equal(svc.registered.length, 5);
});

test('无 toolPolicy → 向后兼容：注册全部工具，gateStatus=no-policy', () => {
  const f = fakeTools();
  const svc = entry.apply({ tools: f.tools, on: f.on }, { home: '/tmp/wr-tp-2' });
  assert.equal(f.registered.length, TOOLS_LEN);
  assert.equal(svc.allowlistSize, null);
  assert.equal(svc.gateStatus, 'no-policy');
});

test('loadToolPolicy 从 config.preset 声明文件读取 toolPolicy', () => {
  const tp = loadToolPolicy({ preset: join(process.cwd(), 'presets', 'warroom.preset.json') });
  assert.equal(tp.mode, 'allowlist');
  assert.ok(Array.isArray(tp.allow) && tp.allow.includes('warroom_execute'));
  // 无路径 → null（向后兼容无策略）
  assert.equal(loadToolPolicy({}), null);
  // 显式给了路径却不可读 → 抛 E_PRESET_UNREADABLE（不得静默当无策略）
  assert.throws(
    () => loadToolPolicy({ preset: '/no/such/file.json' }),
    (e) => e && e.code === 'E_PRESET_UNREADABLE' && /不可读/.test(e.message));
});

// ---- 验收：本机真实 DSH 挂载后，枚举主控会话工具目录 ----
function findDshDir() {
  const cands = [
    process.env.DSH_PKG_DIR,
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(Boolean);
  return cands.find((d) => existsSync(join(d, 'lib', 'profile-boot.js'))) ?? null;
}
const dshDir = findDshDir();
const KERNEL = ['bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'apply_patch',
  'subagent', 'subagent_fork', 'subagent_control', 'list_agents',
  'workflow', 'job_list', 'job_output', 'job_kill', 'run_code', 'fs_read', 'fs_write'];

test('实挂：主控会话工具目录 = 允许清单全集 warroom_*（数量与 TOOL_NAMES 同源），无 bash/write/subagent/workflow/run_code 等内核工具', async (t) => {
  if (!dshDir) return t.skip('未找到本机 DSH（设置 DSH_PKG_DIR）');
  const { runProfile } = await import(pathToFileURL(join(dshDir, 'lib', 'profile-boot.js')).href);
  const dshRequire = createRequire(join(dshDir, 'package.json'));
  const { createLaunchEnvironmentSnapshot } = await import(
    pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-launch-environment')).href);
  const binJs = join(dshDir, 'lib', 'bin.js');

  const home = mkdtempSync(join(tmpdir(), 'wr-tp-'));
  const env = { ...process.env, DSH_HOME: home };
  delete env.DSH_PROFILE_DIR;
  execFileSync(process.execPath, [binJs, '--profile', 'web', '--dump-config'], { env, stdio: 'ignore' });
  execFileSync(process.execPath, ['scripts/deploy-dsh.mjs', '--apply', '--home', home], { env, stdio: 'ignore' });

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let booted;
  try {
    booted = await runProfile({
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]),
      profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0'],
    });
    const { ctx } = booted;
    if (ctx.get('loader')?.await) await ctx.get('loader').await();
    const ap = ctx.get('agentPresets');
    const tools = ctx.get('tools');

    const list = await ap.list();
    assert.equal(list.find((p) => p.id === 'warroom-gungnir')?.broken, undefined, '预设不得 broken');

    // retain 得到预设 standing 挂载 scope：会话的工具继承面即以此为锚（会话 own 层之上再无内核工具）
    const gen = await ap.retain('warroom-gungnir');
    const visible = [...tools.view(gen.mount.key).visible.keys()];
    gen.users--;

    const warroom = visible.filter((n) => n.startsWith('warroom_')).sort();
    assert.deepEqual(warroom, [...TOOL_NAMES].sort(), '必须恰好等于允许清单全集（TOOL_NAMES）');
    assert.equal(warroom.length, TOOL_NAMES.length);
    const kernelHit = visible.filter((n) => KERNEL.includes(n));
    assert.deepEqual(kernelHit, [], `工具目录不得含内核工具，实际命中：${kernelHit.join(', ')}`);
  } finally {
    try { await (booted?.shutdown?.shutdown?.(0) ?? booted?.ctx?.fiber?.dispose()); } catch { /* 卸载失败不阻断 */ }
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});
