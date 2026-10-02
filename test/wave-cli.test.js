// CLI 波次：会议文件 → 派单 → 结项 → 报告可查（并验证依赖顺序）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = (home, args) => JSON.parse(execFileSync('node', ['bin/warroom.mjs', ...args, '--home', home, '--json'],
  { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } }));

test('warroom wave：纪要落库、依赖顺序、事实入库', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-wave-cli-'));
  const eng = cli(home, ['engage', '--target', '10.0.0.0/24', '--rhythm', 'open']);
  const plan = join(home, 'wave.json');
  writeFileSync(plan, JSON.stringify({
    title: '链前会议 #1', notes: 'recon → chain', decisions: ['rhythm=open'],
    tasks: [
      { id: 'A', role: 'recon', targets: ['10.0.0.5'], intent: 'recon' },
      { id: 'B', role: 'chain', targets: ['10.0.0.5'], intent: 'assess', depends_on: ['A'] },
    ],
  }));

  const r = cli(home, ['wave', '--engagement', eng.engagement_id, '--meeting', plan]);
  assert.equal(r.facts_inserted, 2);
  assert.equal(r.order.at(-1), 'B', 'B 依赖 A，应最后派发');
  assert.equal(r.meetings, 1);

  // 任务全部结项（账本终态），报告可导出
  const st = cli(home, ['status', '--engagement', eng.engagement_id, '--task', r.tasks[0].task_id]);
  assert.equal(st.ledger_state, 'done');
  const rep = cli(home, ['report', '--engagement', eng.engagement_id, '--format', 'both']);
  assert.ok(rep.paths.markdown && rep.paths.json);
});
