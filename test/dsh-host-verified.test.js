// 真实挂载验收（闭环第⑤步 · A）：scripts/verify-host.mjs 必须用官方 boot API 真起 web profile，
// 断言 (1) 注册表无 broken + 预设在册；(2) retain 成功；(3) 工具目录 = 允许集（36 warroom_*，0 内核工具），
// 过了才打 HOST_VERIFIED。与 #143/#146 同风格：本机有官方宝时实跑、缺宝时如实 SKIP（不假装通过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 定位本机 @deepseek-ai/dsh（与 verify-host.mjs 同口径）。可用 DSH_PKG_DIR 覆盖。 */
function findDshDir() {
  const cands = [
    process.env.DSH_PKG_DIR,
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(Boolean);
  return cands.find((d) => existsSync(join(d, 'lib', 'profile-boot.js'))) ?? null;
}
const dshDir = findDshDir();

test('HOST_VERIFIED：真实挂载验收脚本在本机 DSH 上三项断言全过', (t) => {
  if (!dshDir) return t.skip('未找到本机 DSH（设置 DSH_PKG_DIR）');
  // --require-host：既然本测试已确认有宝，脚本就不得走 SKIP 分支（缺宝即失败，杜绝静默通过）
  const out = execFileSync(process.execPath,
    [join(root, 'scripts', 'verify-host.mjs'), '--json', '--require-host'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const start = out.indexOf('{');
  assert.ok(start >= 0, `脚本未产出 JSON：${out.slice(-400)}`);
  const result = JSON.parse(out.slice(start));
  assert.equal(result.ok, true, `验收未通过：${result.error ?? JSON.stringify(result)}`);
  assert.equal(result.dsh, '0.2.0-rc.2');
  assert.equal(result.warroom, 36, '必须恰好 36 个 warroom_*');
  assert.equal(result.checks.length, 3, '三项断言（无 broken+在册 / retain / 工具目录=允许集）');
});
