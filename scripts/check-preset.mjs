#!/usr/bin/env node
// 预设校验：允许清单必须覆盖全部工具、拒绝清单必须含危险项、角色文件齐备且含必备段落。
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../packages/warroom-tools/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_ROLE_SECTIONS = ['目标函数'];
const REQUIRED_DENY = ['bash', 'write', 'edit', 'subagent', 'workflow', 'redteam_*', 'ops_*'];

export function checkPreset() {
  const errors = [];
  const presetPath = join(root, 'presets', 'warroom.preset.json');
  if (!existsSync(presetPath)) return ['缺少 presets/warroom.preset.json'];
  const preset = JSON.parse(readFileSync(presetPath, 'utf8'));

  if (preset.toolPolicy?.mode !== 'allowlist') errors.push('toolPolicy.mode 必须是 allowlist');
  const allow = new Set(preset.toolPolicy?.allow ?? []);
  for (const t of TOOLS) {
    if (!allow.has(t.name)) errors.push(`工具 ${t.name} 不在允许清单中（智能体将看不到它）`);
  }
  for (const d of REQUIRED_DENY) {
    if (!(preset.toolPolicy?.deny ?? []).includes(d)) errors.push(`拒绝清单缺少危险项 ${d}`);
  }
  if (preset.subagent?.maxDepth !== 1) errors.push('subagent.maxDepth 必须为 1（叶子代理）');
  for (const deny of ['subagent', 'subagent_fork', 'workflow']) {
    if (!(preset.subagent?.denyTools ?? []).includes(deny)) errors.push(`subagent.denyTools 缺少 ${deny}`);
  }
  if (!Array.isArray(preset.roles) || preset.roles.length < 3) errors.push('至少需要 3 个角色（v0.1：commander/recon/chain）');

  for (const [role, rel] of Object.entries(preset.roleFiles ?? {})) {
    const p = join(root, rel);
    if (!existsSync(p)) { errors.push(`角色文件缺失：${rel}`); continue; }
    const body = readFileSync(p, 'utf8');
    if (!body.startsWith(`# 角色：`)) errors.push(`${rel} 缺少角色标题行`);
    if (role === 'commander' || role === 'recon' || role === 'chain') {
      if (!body.includes(REQUIRED_ROLE_SECTIONS[0])) errors.push(`${rel} 缺少「目标函数」段落`);
    }
  }
  return errors;
}

const ranDirectly = process.argv[1] && process.argv[1].endsWith('check-preset.mjs');
if (ranDirectly) {
  const errors = checkPreset();
  if (errors.length === 0) console.log('[✓] 预设校验通过（允许清单闭合 / 角色文件齐备）');
  else {
    console.error(`[✗] 预设校验失败（${errors.length} 项）：`);
    for (const e of errors) console.error(`    - ${e}`);
    process.exitCode = 1;
  }
}
