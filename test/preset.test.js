// 预设校验的正负样本（CI 闸）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import { checkPreset } from '../scripts/check-preset.mjs';

test('预设校验通过：允许清单覆盖全部工具、拒绝清单完整、角色文件齐备', () => {
  const errors = checkPreset();
  assert.equal(errors.length, 0, errors.join('\n'));
});

test('允许清单与工具集一一对应（新增工具必须显式进清单）', () => {
  const preset = JSON.parse(readFileSync(new URL('../presets/warroom.preset.json', import.meta.url), 'utf8'));
  const allow = new Set(preset.toolPolicy.allow);
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names.filter((n) => !allow.has(n)), []);
});

test('拒绝清单覆盖危险能力（bash/文件写/委派/直调红队与ops）', () => {
  const preset = JSON.parse(readFileSync(new URL('../presets/warroom.preset.json', import.meta.url), 'utf8'));
  for (const d of ['bash', 'write', 'edit', 'subagent', 'subagent_fork', 'workflow', 'redteam_*', 'ops_*']) {
    assert.ok(preset.toolPolicy.deny.includes(d), `deny 缺 ${d}`);
  }
  assert.equal(preset.subagent.maxDepth, 1);
});

test('三角色提示词都含目标函数段落（提示词不是边界，但必须自洽）', () => {
  for (const rel of ['presets/roles/commander.md', 'presets/roles/recon.md', 'presets/roles/chain.md']) {
    const body = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.match(body, /目标函数/);
    assert.match(body, /warroom_execute|不执行|你没有/);
  }
});
