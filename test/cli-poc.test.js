// CLI 知识库子命令：与工具同一实现；未脱敏拒收；检索排序可切。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = () => ({ ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' });
const run = (home, args) => JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'poc', ...args, '--home', home, '--json'],
  { encoding: 'utf8', env: env() }));

test('poc add / search / use / stats 全链路可用', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-cli-poc-'));
  const added = run(home, ['add', '--code', 'CLI-POC-1', '--title', '未授权后台', '--category', 'unauth',
    '--body', '请求 http://TARGET/admin 返回 200']);
  assert.equal(added.code, 'CLI-POC-1');

  const searched = run(home, ['search', '--q', '未授权']);
  assert.equal(searched.count, 1);
  assert.equal(searched.rows[0].code, 'CLI-POC-1');
  assert.ok(typeof searched.rows[0].score === 'number', '应带相关度分');

  const used = run(home, ['use', '--code', 'CLI-POC-1', '--engagement', 'eng_cli', '--asset', 'HOST', '--result', 'hit']);
  assert.equal(used.result, 'hit');

  const usage = run(home, ['usage', '--engagement', 'eng_cli']);
  assert.equal(usage.total, 1);
  assert.equal(usage.by_result.hit, 1);

  const stats = run(home, ['stats']);
  assert.ok(stats.total >= 1);
});

test('未脱敏内容被拒（非零退出），--allow-unsanitized 才放行', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-cli-poc2-'));
  let code = 0;
  try {
    execFileSync('node', ['bin/warroom.mjs', 'poc', 'add', '--code', 'LEAK-1', '--title', '带内网',
      '--category', 'other', '--body', '内网 192.168.1.10', '--home', home, '--json'],
    { encoding: 'utf8', env: env(), stdio: 'pipe' });
  } catch (e) { code = e.status; }
  assert.notEqual(code, 0, '未脱敏必须失败');

  const ok = run(home, ['add', '--code', 'LEAK-1', '--title', '带内网（已登记理由）', '--category', 'other',
    '--body', '内网 192.168.1.10', '--allow-unsanitized', '--note', '实验室环境，已完成授权']);
  assert.equal(ok.code, 'LEAK-1');
});

test('search --sort hits 生效', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-cli-poc3-'));
  run(home, ['add', '--code', 'S-1', '--title', 'ssrf 打点', '--category', 'ssrf', '--body', 'TARGET']);
  run(home, ['add', '--code', 'S-2', '--title', 'ssrf 打点二', '--category', 'ssrf', '--body', 'TARGET']);
  for (let i = 0; i < 3; i += 1) run(home, ['use', '--code', 'S-1', '--engagement', 'e1', '--result', 'hit']);
  const rows = run(home, ['search', '--q', 'ssrf', '--sort', 'hits']).rows;
  assert.equal(rows[0].code, 'S-1');
});
