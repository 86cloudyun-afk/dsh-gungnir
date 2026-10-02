#!/usr/bin/env node
// 部署到本机 DSH profile：把 GUNGNIR 作为**预设**接入（ADR-001 D1：隔离在挂载层）。
//
// 真实契约（dsh 0.2.0-rc.2）：预设 = profile patch 里一行 `@deepseek-ai/dsh-agent-preset`，
// 其 `config.plugins` 是该预设要挂载的子插件清单。**只有被挂载的工具才存在**——
// 这正是允许清单语义，不需要提示词层配合。
//
// 用法：
//   node scripts/deploy-dsh.mjs --check                # 环境/文件/宿主/幂等性检查
//   node scripts/deploy-dsh.mjs --print                # 打印将写入 patch 层的 YAML
//   node scripts/deploy-dsh.mjs --apply                # 备份后写入（幂等；只由脚本改 patch 层）
//   node scripts/deploy-dsh.mjs --verify [--patch f]   # 用 dsh --dump-config 验证装配（**不需要重启**）
//
// 生效条件：host 平面变更需重启 `dsh web`（请在操作员自己的终端执行；agent 不重启宿主的 web 进程）
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: 'boolean' }, print: { type: 'boolean' }, apply: { type: 'boolean' },
    verify: { type: 'boolean' }, home: { type: 'string' }, profile: { type: 'string' },
    role: { type: 'string' }, patch: { type: 'string' }, json: { type: 'boolean', default: false },
  },
});

const PRESET_ID = 'warroom-gungnir';
const ROW_ID = `preset-${PRESET_ID}`;
const profileName = v.profile ?? process.env.DSH_PROFILE ?? 'web';
// 优先级：显式 --home > 环境变量（测试与多环境必须能定向，避免误写真实 profile——曾真实发生）
const home = v.home ?? process.env.DSH_HOME ?? null;
const profileDir = home ? join(home, 'profiles', profileName) : (process.env.DSH_PROFILE_DIR ?? null);
const patchPath = profileDir ? join(profileDir, 'cordis.patch.yml') : null;
const role = v.role ?? 'commander';
const roleFile = join(root, 'presets', 'roles', `${role}.md`);

/** 生成要写入 profile patch 的 YAML（真实契约）。 */
function buildSnippet() {
  // 角色文本在**运行期**从仓库文件读入（!!js 在 loader 作用域求值）：
  // 避免把长 markdown 塞进 YAML 标量（多级缩进会直接把 patch 变成非法 YAML）。
  const roleExpr = `process.getBuiltinModule('node:fs').readFileSync('${roleFile}','utf8')`;
  return `# GUNGNIR 预设（由 scripts/deploy-dsh.mjs 生成；声明文件：${join(root, 'presets', 'warroom.preset.json')}，
# 角色：${join(root, 'presets', 'roles', `${role}.md`)}）
- insert:
    - id: ${ROW_ID}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${PRESET_ID}
        name: 红队指挥（GUNGNIR）
        description: 攻击路径合成的战役指挥框架。工具目录为允许清单：只有 warroom_* 可见，无 bash/文件写/进程/委派工具。
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: !!js "${roleExpr}"
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: ${PRESET_ID}
            name: ${join(root, 'packages', 'warroom-plugin', 'src', 'dsh-entry.mjs')}
            config:
              role: ${role}
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
`;
}

function dshBin() {
  const candidates = [process.env.DSH_BIN, 'dsh'].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

const snippet = buildSnippet();
const findings = [];
if (v.print) { process.stdout.write(snippet); process.exit(0); }

const bin = dshBin();
findings.push(`仓库根：${root}`);
findings.push(`profile：${profileDir ?? '(未设置 DSH_HOME/--home，或 DSH_PROFILE_DIR)'}（profile=${profileName}）`);
findings.push(existsSync(join(root, 'packages', 'warroom-plugin', 'src', 'dsh-entry.mjs'))
  ? '✓ 挂载入口存在（packages/warroom-plugin/src/dsh-entry.mjs）'
  : '✗ 挂载入口缺失');
findings.push(existsSync(roleFile) ? `✓ 角色文件可读（${role}）` : `✗ 角色文件缺失：${roleFile}`);
const presetFile = join(root, 'presets', 'warroom.preset.json');
let declaredAllow = null;
if (existsSync(presetFile)) {
  try {
    const decl = JSON.parse(readFileSync(presetFile, 'utf8'));
    declaredAllow = decl?.toolPolicy?.allow ?? [];
    findings.push(`✓ 预设文件可读（声明允许清单 ${declaredAllow.length} 项）`);
    // 与**代码里真实注册的工具集合**比对（不是与文本比对）
    const { TOOLS } = await import(pathToFileURL(join(root, 'packages', 'warroom-tools', 'src', 'index.js')).href);
    const actual = new Set(TOOLS.map((t) => t.name));
    const declared = new Set(declaredAllow.filter((n) => n !== 'skill'));   // skill 由宿主提供
    const missing = [...declared].filter((n) => !actual.has(n));
    const extra = [...actual].filter((n) => !declared.has(n));
    findings.push(missing.length === 0 && extra.length === 0
      ? `✓ 声明允许清单 == 实际注册工具（${actual.size} 个；skill 由宿主提供）`
      : `✗ 声明与实现不一致：声明缺 ${missing.join(', ') || '无'}｜代码多 ${extra.join(', ') || '无'}`);
  } catch (e) {
    findings.push(`✗ 预设文件无法解析：${e.message}`);
  }
} else findings.push(`✗ 预设文件缺失：${presetFile}`);
findings.push(bin ? `✓ dsh 可用（${bin}）` : '✗ 找不到 dsh 可执行（--verify 不可用）');

let already = false;
if (patchPath && existsSync(patchPath)) {
  const cur = readFileSync(patchPath, 'utf8');
  already = cur.includes(`id: ${ROW_ID}`) || cur.includes(`id: ${PRESET_ID}\n`);
  findings.push(already ? '✓ patch 层已包含本预设行' : '· patch 层尚无本预设行（--apply 可写入）');
} else if (patchPath) {
  findings.push(`· patch 文件不存在：${patchPath}（--apply 会创建）`);
}

if (v.apply) {
  if (!patchPath) { console.error('✗ 未指定 profile（设置 DSH_HOME/DSH_PROFILE_DIR 或用 --home）'); process.exit(2); }
  if (already) {
    findings.push('✓ 幂等：已存在，未改动');
  } else {
    const backup = `${patchPath}.bak-warroom-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const cur = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
    if (existsSync(patchPath)) copyFileSync(patchPath, backup);
    writeFileSync(patchPath, `${cur.trimEnd()}\n\n${snippet}`, 'utf8');
    findings.push(`✓ 已写入 patch 层（备份：${existsSync(backup) ? backup : '无原文件'}）`);
    findings.push('· 生效需重启 dsh web（host 平面变更）——请在**你的终端**执行，勿从 agent 工具调用发起');
  }
}

let verify = null;
if (v.verify) {
  if (!bin) { findings.push('✗ --verify 需要 dsh 可执行'); }
  else {
    // 优先验证"真实文件"；给了 --patch 则验证覆盖层（用于 apply 前预演）
    const patchArg = v.patch ? [] : [];
    let overlay = v.patch ?? null;
    if (!overlay && !already && !v.apply) {
      overlay = join(mkdtempSync(join(tmpdir(), 'wr-patch-')), 'warroom-preset.yml');
      writeFileSync(overlay, snippet, 'utf8');
      findings.push(`· 尚未写入真实 patch：用临时覆盖层预演（${overlay}）`);
    }
    const args = ['--profile', profileName, '--dump-config', ...(overlay ? ['--patch', overlay] : [])];
    const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const hit = out.includes(`id: ${PRESET_ID}`) && out.includes(ROW_ID);
    verify = { ok: r.status === 0 && hit, status: r.status, preset_found: hit, via: overlay ? 'overlay' : 'profile' };
    findings.push(verify.ok
      ? `✓ 装配验证通过（${verify.via}）：预设 ${PRESET_ID} 已被宿主接受`
      : `✗ 装配验证失败（退出码 ${r.status}，preset_found=${hit}）`);
  }
}

if (v.json) console.log(JSON.stringify({ profileDir, profile: profileName, already, verify, findings }, null, 2));
else console.log(findings.join('\n'));
process.exitCode = findings.some((f) => f.startsWith('✗')) ? 1 : 0;
