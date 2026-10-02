// 自审闸自我测试：闸门必须通过自身；且能识别写入的坏样本（临时文件，测后清理）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

const SCRIPT = 'scripts/self-review.mjs';

function run() {
  try {
    const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('自审闸对当前仓库通过（退出码 0）', () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /自审通过/);
});

test('自审闸有齿：注入真凭据形态与坏链接必须失败', () => {
  const bad = 'docs/__selfreview_bad.md';
  writeFileSync(bad, '# 坏样本\n\n[死链](__nope__.md)\n\n' + ['ghp', '_', 'Z'.repeat(24)].join('') + '\n');
  try {
    const r = run();
    assert.equal(r.code, 1, '含真凭据形态/死链时闸门必须失败');
    assert.match(r.out, /secrets|link/);
  } finally {
    if (existsSync(bad)) unlinkSync(bad);
  }
});
