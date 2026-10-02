// 外部门禁脚本：退出码语义（0/1/2）与 JSON 输出；结论与 checklist 同源。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { backupHome } from '../packages/warroom-core/src/maintenance.js';

const env = () => ({ ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' });
const run = (args, extraEnv = {}) => {
  try {
    const out = execFileSync('node', ['scripts/gate-check.mjs', ...args], { encoding: 'utf8', env: { ...env(), ...extraEnv } });
    return { code: 0, out, err: '' };
  } catch (e) { return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' }; }
};

test('用法缺失 → 退出码 2 并提示参数', () => {
  const r = run([], { WARROOM_HOME: '', WARROOM_ENGAGEMENT: '' });
  assert.equal(r.code, 2);
  assert.match(r.err, /需要 --home\/--engagement 或环境变量/);
});

test('未交付 → 1 并列出未过项；补齐后 → 0', () => {
  const h = harness();
  const first = run(['--home', h.home, '--engagement', h.eng.engagement_id, '--json']);
  assert.equal(first.code, 1);
  const parsed = JSON.parse(first.out);
  assert.equal(parsed.deliverable, false);
  assert.ok(parsed.blocked.some((b) => b.startsWith('report：')));

  // 补齐：事实 + 报告 + 证据 + 备份
  const ex = h.broker.execute({ ...h.base, command_id: 'gc-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.settle(h.eng.engagement_id, ex.task_id);
  h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  h.broker.exportEvidence(h.eng.engagement_id, {
    outDir: join(h.home, 'engagements', h.eng.engagement_id, 'evidence'),
  });
  backupHome({ home: h.home });

  const second = run(['--home', h.home, '--engagement', h.eng.engagement_id, '--json']);
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal(JSON.parse(second.out).deliverable, true);
});

test('环境变量接法可用；结论与 checklist 同源（不出现两套判定）', () => {
  const h = harness();
  const r = run([], { WARROOM_HOME: h.home, WARROOM_ENGAGEMENT: h.eng.engagement_id, GUNGNIR_GATE_PROFILE: 'progress' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /门禁结论（progress）：✅ 通过/);

  const c = h.broker.checklist(h.eng.engagement_id, { profile: 'progress' });
  assert.equal(c.deliverable, true, '脚本结论应与 checklist 一致');
});

test('家目录不存在 → 2（前置错误，不是"门禁未通过"）', () => {
  const r = run(['--home', join(mkdtempSync(join(tmpdir(), 'wr-gc-')), 'nope'), '--engagement', 'eng_x']);
  assert.equal(r.code, 2);
  assert.match(r.err, /家目录不存在/);
});
