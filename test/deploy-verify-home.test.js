// 回归：deploy --verify 必须把 --home 透传给它 spawn 的 dsh。
// 否则 dsh 会按自身 DSH_HOME dump 另一套 profile，误报 preset_found=false。
// 依赖本机 dsh 可执行；不可用时如实 SKIP。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// nvm/global 安装：dsh 可执行与 node 同目录。可用 DSH_BIN 覆盖。
const dshBin = process.env.DSH_BIN ?? join(dirname(process.execPath), 'dsh');

test('deploy --verify 把 --home 透传给 spawn 的 dsh（验证的是 --home 指定的 profile）', async (t) => {
  if (!existsSync(dshBin)) return t.skip('未找到 dsh 可执行（设置 DSH_BIN）');

  const home = mkdtempSync(join(tmpdir(), 'wr-verify-'));
  const initEnv = { ...process.env, DSH_HOME: home, DSH_BIN: dshBin };
  delete initEnv.DSH_PROFILE_DIR;
  // 初始化 shipped web profile + 写入本预设行
  execFileSync(dshBin, ['--profile', 'web', '--dump-config'], { env: initEnv, stdio: 'ignore' });
  execFileSync(process.execPath, ['scripts/deploy-dsh.mjs', '--apply', '--home', home], { env: initEnv, stdio: 'ignore' });

  // 关键：--verify 的环境**不含** DSH_HOME，只用 --home 指定目标；修复后 spawn 的 dsh 应验证该 profile。
  const verifyEnv = { ...process.env, DSH_BIN: dshBin };
  delete verifyEnv.DSH_HOME;
  delete verifyEnv.DSH_PROFILE_DIR;
  const out = execFileSync(process.execPath, ['scripts/deploy-dsh.mjs', '--verify', '--home', home], { encoding: 'utf8', env: verifyEnv });
  assert.match(out, /装配验证通过/, `--verify 应命中 --home 指定 profile 的预设，实际输出：\n${out}`);
});
