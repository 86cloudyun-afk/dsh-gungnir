// 工具文档生成与同步校验（防文档漂移）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { TOOLS } from '../packages/warroom-tools/src/index.js';

const run = (flag) => execFileSync('node', ['scripts/gen-docs.mjs', flag], { encoding: 'utf8' });

test('docs/TOOLS.md 与代码同步（--check 通过）', () => {
  const out = run('--check');
  assert.match(out, /工具文档同步/);
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
