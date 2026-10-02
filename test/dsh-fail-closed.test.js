// 真实挂载闭环⑤·fail-closed（框架第 5 原则「宁拒不裸奔」）：
// 挂载/激活失败或工具目录不达允许集时，必须**拒绝进入 warroom 会话**，而非静默降级裸退到
// http://127.0.0.1:3080。拦截点 = agent-preset 挂载契约：apply() 抛错 → auditRows 判该行
// failed → mountPreset 抛 → generation broken → registry.retain() 抛 agent-preset/invalid →
// select()（开会前选预设的唯一路径）reject → 该 warroom 会话被拒。
//
// 单元（hermetic）：apply() 在各 fail-closed 条件下抛错；failClosed:false 可显式降级。
// 验收（本机 DSH 0.2.0-rc.2 + 官方 boot API，缺宝 SKIP）：
//   正例——健康预设在 fail-closed 默认开启下仍干净挂载（无回归）；
//   负例——注入 allow:[] 的预设在 list() 里 broken 且 retain() 抛（= 开会被拒）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { default: entry } = await import('../packages/warroom-plugin/src/dsh-entry.mjs');
const { TOOL_NAMES } = await import('../packages/warroom-plugin/src/tools.js');

function fakeTools() {
  const registered = [];
  return { registered, tools: { register: (d) => { registered.push(d.name); return () => {}; } }, on() {} };
}
const fullAllow = [...TOOL_NAMES, 'skill'];

// ---- 单元：fail-closed 条件 ----
test('fail-closed：声明 toolPolicy 但 allow 为空数组 → apply 抛（拒绝挂载）', () => {
  assert.throws(
    () => entry.apply({ tools: fakeTools().tools, on() {} }, { home: '/tmp/wr-fc-1', toolPolicy: { mode: 'allowlist', allow: [] } }),
    /allow 非法|非空数组/);
});

test('fail-closed：声明 toolPolicy 但 allow 缺失/非数组 → apply 抛', () => {
  assert.throws(
    () => entry.apply({ tools: fakeTools().tools, on() {} }, { home: '/tmp/wr-fc-2', toolPolicy: { mode: 'allowlist' } }),
    /allow 非法|非空数组/);
});

test('fail-closed：策略在 force 但 registry 缺失（零工具注册）→ apply 抛（堵住"看似挂上却空目录"）', () => {
  // 旧逻辑用 registered.length>0 守卫会跳过完整性检查 → 静默降级；现在必须抛。
  assert.throws(
    () => entry.apply({ on() {} }, { home: '/tmp/wr-fc-3', toolPolicy: { mode: 'allowlist', allow: fullAllow } }),
    /挂载不完整|fail-closed/);
});

test('fail-closed 默认开启 + 健康子集 → 不抛，只注册允许集内 warroom 工具（无回归）', () => {
  const f = fakeTools();
  const subset = TOOL_NAMES.slice(0, 5);
  const svc = entry.apply({ tools: f.tools, on() {} }, { home: '/tmp/wr-fc-4', toolPolicy: { mode: 'allowlist', allow: [...subset, 'skill'] } });
  assert.deepEqual([...f.registered].sort(), [...subset].sort());
  assert.equal(svc.failClosed, true);
});

test('failClosed:false → 显式关闭 fail-closed：空 allow 不抛（可控降级旁路，仅显式选择时）', () => {
  const f = fakeTools();
  const svc = entry.apply({ tools: f.tools, on() {} }, { home: '/tmp/wr-fc-5', toolPolicy: { mode: 'allowlist', allow: [] }, failClosed: false });
  assert.equal(svc.failClosed, false);
  assert.equal(f.registered.length, 0);
});

test('无 toolPolicy（向后兼容）→ 不受 fail-closed 影响，注册全部 36', () => {
  const f = fakeTools();
  const svc = entry.apply({ tools: f.tools, on() {} }, { home: '/tmp/wr-fc-6' });
  assert.equal(f.registered.length, 36);
  assert.equal(svc.failClosed, true);
});

test('fail-closed：config.preset 指向不存在文件 → apply 抛（堵住路径失效静默无策略）', () => {
  assert.throws(
    () => entry.apply({ tools: fakeTools().tools, on() {} }, {
      home: '/tmp/wr-fc-7', preset: '/no/such/warroom.preset.json',
    }),
    (e) => e && e.code === 'E_PRESET_UNREADABLE' && /不可读/.test(e.message));
});

test('fail-closed：config.preset 文件可读但无 toolPolicy 字段 → apply 抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-fc-empty-'));
  const preset = join(dir, 'empty.preset.json');
  writeFileSync(preset, JSON.stringify({ id: 'empty', version: '0.0.0' }));
  assert.throws(
    () => entry.apply({ tools: fakeTools().tools, on() {} }, { home: '/tmp/wr-fc-8', preset }),
    /未提供 toolPolicy|fail-closed/);
});

test('failClosed:false → preset 不可读时降级为无策略（显式旁路）', () => {
  const f = fakeTools();
  const svc = entry.apply({ tools: f.tools, on() {} }, {
    home: '/tmp/wr-fc-9', preset: '/no/such/warroom.preset.json', failClosed: false,
  });
  assert.equal(svc.failClosed, false);
  assert.equal(svc.gateStatus, 'no-policy');
  assert.equal(f.registered.length, 36);
});

// ---- 验收：本机真实 DSH 挂载 ----
function findDshDir() {
  const cands = [
    process.env.DSH_PKG_DIR,
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(Boolean);
  return cands.find((d) => existsSync(join(d, 'lib', 'profile-boot.js'))) ?? null;
}
const dshDir = findDshDir();

async function bootProbe(home, env) {
  const { runProfile } = await import(pathToFileURL(join(dshDir, 'lib', 'profile-boot.js')).href);
  const dshRequire = createRequire(join(dshDir, 'package.json'));
  const { createLaunchEnvironmentSnapshot } = await import(
    pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-launch-environment')).href);
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
    const list = await ap.list();
    const w = list.find((p) => p.id === 'warroom-gungnir');
    let retainThrew = false; let retainMsg = '';
    try { const g = await ap.retain('warroom-gungnir'); g.users--; }
    catch (e) { retainThrew = true; retainMsg = e.message; }
    return { broken: w?.broken, retainThrew, retainMsg };
  } finally {
    try { await (booted?.shutdown?.shutdown?.(0) ?? booted?.ctx?.fiber?.dispose()); } catch { /* 清理尽力 */ }
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
}

function initHome(prefix) {
  const binJs = join(dshDir, 'lib', 'bin.js');
  const home = mkdtempSync(join(tmpdir(), prefix));
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  delete env.DSH_PROFILE_DIR;
  execFileSync(process.execPath, [binJs, '--profile', 'web', '--dump-config'], { env, stdio: 'ignore' });
  return { home, env };
}

test('实挂正例：fail-closed 默认开启下，健康预设仍干净挂载（list 无 broken + retain 成功，无回归）', async (t) => {
  if (!dshDir) return t.skip('未找到本机 DSH（设置 DSH_PKG_DIR）');
  const { home, env } = initHome('wr-fc-ok-');
  execFileSync(process.execPath, [join(root, 'scripts', 'deploy-dsh.mjs'), '--apply', '--home', home], { env, stdio: 'ignore' });
  const r = await bootProbe(home, env);
  assert.equal(r.broken, undefined, `健康预设不应 broken：${r.broken ?? ''}`);
  assert.equal(r.retainThrew, false, `健康预设 retain 不应抛：${r.retainMsg}`);
});

test('实挂负例：toolPolicy.allow 置空 → 预设 broken 且 retain 抛（= select 拒绝进入 warroom 会话）', async (t) => {
  if (!dshDir) return t.skip('未找到本机 DSH（设置 DSH_PKG_DIR）');
  const { home, env } = initHome('wr-fc-neg-');
  // 取部署脚本生成的真实行，向 warroom 子插件 config 注入 inline toolPolicy（allow:[] 触发 fail-closed）
  let snippet = execFileSync(process.execPath,
    [join(root, 'scripts', 'deploy-dsh.mjs'), '--print', '--home', home], { env, encoding: 'utf8' });
  snippet = snippet.replace(/(\n {14}preset: .+\n)/,
    '$1              toolPolicy:\n                mode: allowlist\n                allow: []\n');
  assert.match(snippet, /allow: \[\]/, '注入 inline toolPolicy 失败');
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), snippet, 'utf8');
  const r = await bootProbe(home, env);
  assert.ok(r.broken !== undefined, '置空 allow 的预设必须 broken（挂载被拒）');
  assert.match(r.broken, /fail-closed|allow 非法/);
  assert.equal(r.retainThrew, true, 'retain 必须抛（= 开会路径拒绝进入 warroom 会话）');
});
