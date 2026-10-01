// CLI 冒烟：离线真实链路（engange → exec → status → collect → report），全 JSON 输出可解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'bin/warroom.mjs';

function run(home, args) {
  const out = execFileSync('node', [CLI, ...args, '--home', home, '--json'], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('CLI 全链路：engage → exec → status → collect → report', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-cli-'));
  const eng = run(home, ['engage', '--target', '10.0.0.0/24', '--rhythm', 'open']);
  assert.ok(eng.engagement_id.startsWith('eng_'));
  assert.equal(eng.auth_version, 1);

  const ex = run(home, ['exec', '--engagement', eng.engagement_id, '--command-id', 'cli-1',
    '--target', '10.0.0.5', '--class', 'active', '--wire', '2', '--resources', 'container']);
  assert.equal(ex.state, 'running');

  const st = run(home, ['status', '--engagement', eng.engagement_id, '--task', ex.task_id]);
  assert.equal(st.ledger_state, 'running');
  assert.equal(st.manifest.length, 2);

  const col = run(home, ['collect', '--engagement', eng.engagement_id, '--task', ex.task_id]);
  assert.equal(col.accepted, true);

  const rep = run(home, ['report', '--engagement', eng.engagement_id]);
  assert.ok(rep.path.endsWith('.md'));
  assert.ok(rep.watermark.seq >= 1);
});

test('CLI 门闸生效：destructive 无批准被拒（非零退出）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-cli-'));
  const eng = run(home, ['engage', '--target', '10.0.0.0/24']);
  let failed = false;
  try {
    run(home, ['exec', '--engagement', eng.engagement_id, '--command-id', 'cli-d1',
      '--target', '10.0.0.5', '--action-class', 'destructive']);
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /E_GATE_DESTRUCTIVE_NEEDS_APPROVAL/);
  }
  assert.equal(failed, true);
});

test('CLI 跳板与秘密子命令可跑', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-cli-'));
  const eng = run(home, ['engage', '--target', '10.0.0.0/24']);
  const imp = run(home, ['jump', 'import', '--id', 'jh-cli', '--addr-v4', '203.0.113.9']);
  assert.equal(imp.imported, 'jh-cli');
  const acq = run(home, ['jump', 'acquire', '--engagement', eng.engagement_id, '--target', '10.0.0.5']);
  assert.match(acq.socks, /^socks5:\/\//);

  const sec = run(home, ['secret', 'put', '--plaintext', 'cli-secret-123', '--label', 'cli']);
  assert.ok(sec.secret_ref.startsWith('sec_'));
  const status = run(home, ['secret', 'status', '--engagement', eng.engagement_id]);
  assert.equal(status.secrets.length, 1);
  assert.equal(JSON.stringify(status).includes('cli-secret-123'), false, 'CLI 状态视图不得含明文');
});
