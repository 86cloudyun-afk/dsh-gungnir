// 工具文档生成与同步校验（防文档漂移）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { TOOLS } from '../packages/warroom-tools/src/index.js';

const run = (flag) => execFileSync('node', ['scripts/gen-docs.mjs', flag], { encoding: 'utf8' });

test('docs/TOOLS.md 与代码同步（--check 通过）', () => {
  const out = run('--check');
  assert.match(out, /同步（24 个工具）|工具文档与 schema 导出同步/);
});

test('生成内容覆盖全部工具与约定', () => {
  const text = readFileSync('docs/TOOLS.md', 'utf8');
  for (const t of TOOLS) assert.ok(text.includes(`\`${t.name}\``), `缺少 ${t.name}`);
  assert.match(text, /自动生成，勿手改/);
  assert.match(text, /新增工具必须/);
});

test('漂移会被检出（写入后 --check 必须失败）', () => {
  const bak = 'docs/TOOLS.md.bak-test';
  copyFileSync('docs/TOOLS.md', bak);
  try {
    writeFileSync('docs/TOOLS.md', readFileSync('docs/TOOLS.md', 'utf8') + '\n漂移内容\n');
    let failed = false;
    try { run('--check'); } catch (e) { failed = true; assert.match(String(e.stderr), /不一致/); }
    assert.equal(failed, true, '文档被改动后 --check 必须失败');
  } finally {
    copyFileSync(bak, 'docs/TOOLS.md');
    unlinkSync(bak);
  }
  assert.ok(existsSync('docs/TOOLS.md'));
});

test('机器可读 schema 导出：结构与同步校验', () => {
  const raw = readFileSync('docs/tools.schema.json', 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema, 'gungnir-tools/1');
  assert.equal(parsed.tools.length, TOOLS.length);
  assert.ok(parsed.tools.every((t) => t.name && t.input_schema && typeof t.in_allowlist === 'boolean'));
  assert.equal(parsed.preset.allowlist_mode, 'allowlist');

  // 漂移检出：写入后 --check 必须失败
  const bak = 'docs/tools.schema.json.bak-test';
  copyFileSync('docs/tools.schema.json', bak);
  try {
    writeFileSync('docs/tools.schema.json', raw.replace('gungnir-tools/1', 'gungnir-tools/0'));
    let failed = false;
    try { run('--check'); } catch (e) { failed = true; assert.match(String(e.stderr), /tools\.schema\.json/); }
    assert.equal(failed, true);
  } finally {
    copyFileSync(bak, 'docs/tools.schema.json');
    unlinkSync(bak);
  }
});
