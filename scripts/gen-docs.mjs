#!/usr/bin/env node
// 工具文档生成与同步校验：docs/TOOLS.md 必须与代码（TOOLS + 预设允许清单）一致。
// 用法：node scripts/gen-docs.mjs [--write] [--check]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../packages/warroom-tools/src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'docs', 'TOOLS.md');
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');

const preset = JSON.parse(readFileSync(join(repoRoot, 'presets', 'warroom.preset.json'), 'utf8'));
const allow = new Set(preset.toolPolicy.allow);
const roles = preset.roles ?? [];

const typeOf = (s) => {
  if (!s) return '-';
  if (s.type === 'object') {
    const req = new Set(s.required ?? []);
    const props = Object.entries(s.properties ?? {})
      .map(([k, v]) => `${k}${req.has(k) ? '*' : ''}:${Array.isArray(v.enum) ? v.enum.join('|') : v.type ?? '?'}`)
      .join(', ');
    return `{ ${props} }`;
  }
  return s.type ?? '-';
};

const lines = [];
lines.push('# 工具清单（自动生成，勿手改）');
lines.push('');
lines.push(`> 由 \`node scripts/gen-docs.mjs --write\` 生成；CI 用 \`--check\` 校验同步（防文档漂移）。`);
lines.push(`> 工具数：**${TOOLS.length}**；全部在预设允许清单中：**${TOOLS.every((t) => allow.has(t.name)) ? '是' : '否'}**；角色：${roles.join(' / ')}`);
lines.push('');
lines.push('| 工具 | 说明 | 参数（* = 必填） | 在允许清单 |');
lines.push('|---|---|---|---|');
for (const t of TOOLS) {
  lines.push(`| \`${t.name}\` | ${t.description} | \`${typeOf(t.input_schema)}\` | ${allow.has(t.name) ? '✅' : '❌'} |`);
}
lines.push('');
lines.push('## 约定');
lines.push('');
lines.push('- 副作用只能经 `warroom_execute`（服务端 broker 校验四元组）；其余工具为查询/登记。');
lines.push('- 新增工具必须：进 `presets/warroom.preset.json` 的 allow（否则预设闸失败），并重跑本生成器。');
lines.push('- 秘密相关工具只到 `secret_ref` 粒度，解析（resolve）只存在于 host 侧，无对应工具。');
lines.push('');
const content = lines.join('\n');

// 机器可读导出：供外部集成（DSH 挂载、MCP 桥、审计工具）消费
const schemaTarget = join(repoRoot, 'docs', 'tools.schema.json');
const schemaExport = {
  schema: 'gungnir-tools/1',
  generated_from: 'packages/warroom-tools/src/index.js',
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    in_allowlist: allow.has(t.name),
  })),
  preset: { id: preset.id, roles: preset.roles, allowlist_mode: preset.toolPolicy.mode },
};
const schemaContent = JSON.stringify(schemaExport, null, 2) + '\n';

if (write) {
  writeFileSync(target, content, 'utf8');
  writeFileSync(schemaTarget, schemaContent, 'utf8');
  console.log(`[✓] 已写入 docs/TOOLS.md 与 docs/tools.schema.json（${TOOLS.length} 个工具）`);
} else if (check) {
  const problems = [];
  if (!existsSync(target)) problems.push('docs/TOOLS.md 不存在');
  else if (readFileSync(target, 'utf8') !== content) problems.push('docs/TOOLS.md 与代码不一致');
  if (!existsSync(schemaTarget)) problems.push('docs/tools.schema.json 不存在');
  else if (readFileSync(schemaTarget, 'utf8') !== schemaContent) problems.push('docs/tools.schema.json 与代码不一致');
  if (problems.length) {
    console.error(`[✗] ${problems.join('；')}——运行 \`node scripts/gen-docs.mjs --write\` 后提交`);
    process.exit(1);
  }
  console.log(`[✓] 工具文档与 schema 导出同步（${TOOLS.length} 个工具）`);
} else {
  process.stdout.write(content);
}
