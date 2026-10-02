#!/usr/bin/env node
// 部署到本机 DSH profile：生成/校验收据行（cordis.patch.yml）并同步预设与角色文件。
// 用法：
//   node scripts/deploy-dsh.mjs --check          # 只检查（profile 路径、patch 层现状、预设可读）
//   node scripts/deploy-dsh.mjs --print          # 打印应写入 patch 层的 YAML 片段
//   node scripts/deploy-dsh.mjs --apply          # 备份后写入 patch 层（幂等，已存在则跳过）
// 设计约束（框架 §11）：patch 层是全局单文件，多方维护冲突高发 → 只允许脚本改，禁止手编。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: v } = parseArgs({
  args: process.argv.slice(2),
  options: { check: { type: 'boolean' }, print: { type: 'boolean' }, apply: { type: 'boolean' }, home: { type: 'string' } },
});

// 优先级：显式 --home > 环境变量。测试与多环境必须能定向，避免误写真实 profile（曾真实发生）。
const profileDir = v.home ? join(v.home, 'profiles', 'web') : (process.env.DSH_PROFILE_DIR ?? null);
if (process.env.DSH_PROFILE_DIR && v.home && resolve(v.home) !== resolve(process.env.DSH_HOME ?? '')) {
  console.log(`[i] 使用 --home 覆盖环境 DSH_PROFILE_DIR（原值 ${process.env.DSH_PROFILE_DIR}）`);
}
const patchPath = profileDir ? join(profileDir, 'cordis.patch.yml') : null;
const presetId = 'warroom-gungnir';

const yamlSnippet = `- insert:
    - id: ${presetId}
      name: dsh-warroom
      config:
        preset: ${join(root, 'presets', 'warroom.preset.json')}
        rolesDir: ${join(root, 'presets', 'roles')}
        home: !!js dshHomePath('warroom')
`;

function report(lines) { console.log(lines.join('\n')); }

if (v.print) {
  process.stdout.write(yamlSnippet);
  process.exit(0);
}

const findings = [];
findings.push(`仓库根：${root}`);
findings.push(`profile：${profileDir ?? '(未设置 DSH_PROFILE_DIR，可用 --home 指定)'}`);
if (!existsSync(join(root, 'presets', 'warroom.preset.json'))) findings.push('✗ 预设文件缺失');
else findings.push('✓ 预设文件可读');
if (!existsSync(join(root, 'presets', 'roles'))) findings.push('✗ 角色目录缺失');
else findings.push('✓ 角色目录可读');

let already = false;
if (patchPath && existsSync(patchPath)) {
  const cur = readFileSync(patchPath, 'utf8');
  already = cur.includes(presetId);
  findings.push(already ? '✓ patch 层已包含本预设行' : '· patch 层尚无本预设行（--apply 可写入）');
} else if (patchPath) {
  findings.push(`· patch 文件不存在：${patchPath}`);
}

if (v.apply) {
  if (!patchPath) { console.error('✗ 未指定 profile（设置 DSH_PROFILE_DIR 或用 --home）'); process.exit(2); }
  if (already) { findings.push('✓ 幂等：已存在，未改动（避免重复挂载）'); }
  else {
    const backup = `${patchPath}.bak-warroom-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (existsSync(patchPath)) copyFileSync(patchPath, backup);
    const cur = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
    writeFileSync(patchPath, `${cur.trimEnd()}\n\n${yamlSnippet}`, 'utf8');
    findings.push(`✓ 已写入 patch 层（备份：${existsSync(patchPath) ? backup : '无原文件'}）`);
    findings.push('· 生效需重启 dsh web（host 平面变更；请在**你的终端**执行，勿从 agent 工具调用发起）');
  }
}

report(findings);
process.exitCode = findings.some((f) => f.startsWith('✗')) ? 1 : 0;
