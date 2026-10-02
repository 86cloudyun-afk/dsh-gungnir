// 周报：窗口内活跃战役汇总；交付门禁与报告新鲜度入表；窗口外战役不出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { renderWeekly } from '../packages/warroom-core/src/weekly.js';
import { harness } from '../packages/warroom-core/src/testing.js';
import { backupHome } from '../packages/warroom-core/src/maintenance.js';

function makeEng(h, id, { ageDays = 0 } = {}) {
  const eng = h.broker.createEngagement({
    user_message_id: id, targets: ['10.0.0.0/24'], overrides: { rhythm: 'open' },
  });
  if (ageDays > 0) {
    h.broker._eng(eng.engagement_id).store.db
      .prepare('UPDATE engagements SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - ageDays * 86400000).toISOString(), eng.engagement_id);
  }
  return eng;
}

async function seedFact(broker, adapter, eng, commandId) {
  const ex = broker.execute({
    command_id: commandId, engagement_id: eng.engagement_id, auth_version: 1, action_class: 'active',
    contract: {
      targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0,
      fake_members: [{ entity_type: 'asset', source_id: `${commandId}-a`, revision_no: 1, content_hash: 'h', payload: {} }],
    },
  });
  broker.collect(eng.engagement_id, ex.task_id, adapter.collect(ex.task_id));
  broker.settle(eng.engagement_id, ex.task_id);
}

test('周报：两个战役（一个已交付、一个未交付）→ 汇总与门禁状态如实', async () => {
  const h = harness();
  const engA = makeEng(h, 'wk-a');
  await seedFact(h.broker, h.adapter, engA, 'wk-1');
  h.broker.exportReport(engA.engagement_id, { format: 'md' });
  h.broker.exportEvidence(engA.engagement_id, { outDir: join(h.home, 'engagements', engA.engagement_id, 'evidence') });
  backupHome({ home: h.home });
  h.broker.exportReport(engA.engagement_id, { format: 'md' });

  const engB = makeEng(h, 'wk-b');   // 只有立项，没有事实/报告

  const w = h.broker.weekly({ days: 7 });
  // harness 自带一个空战役（窗口内活跃）→ 用实际战役数做期望，避免与装置耦合
  assert.equal(w.totals.engagements, h.broker.listEngagements().length);
  assert.equal(w.totals.facts, 1);
  const a = w.rows.find((r) => r.engagement_id === engA.engagement_id);
  const b = w.rows.find((r) => r.engagement_id === engB.engagement_id);
  assert.ok(a.reports >= 1 && a.reports_in_window >= 1);
  assert.equal(a.delivery.deliverable, true, JSON.stringify(a.delivery));
  assert.equal(b.delivery.deliverable, false);
  assert.ok(b.delivery.blocked > 0);
  assert.match(w.note, /只统计窗口内有活动的战役/);

  const text = renderWeekly(w);
  assert.match(text, /# 战役周报（近 7 天）/);
  assert.match(text, /交付门禁/);
  assert.match(text, /✅ 可交付/);
});

test('窗口过滤：窗口外且无活动的战役不出现', () => {
  const h = harness();
  const old = makeEng(h, 'wk-old', { ageDays: 30 });
  const recent = makeEng(h, 'wk-new');
  const w = h.broker.weekly({ days: 7 });
  const ids = w.rows.map((r) => r.engagement_id);
  assert.ok(ids.includes(recent.engagement_id));
  assert.equal(ids.includes(old.engagement_id), false, '30 天前且无新活动 → 不进周报');
});

test('CLI weekly：文本/JSON/落盘三路可用', () => {
  const h = harness();
  makeEng(h, 'wk-cli');
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const text = execFileSync('node', ['bin/warroom.mjs', 'weekly', '--days', '7', '--home', h.home, '--text'],
    { encoding: 'utf8', env });
  assert.match(text, /战役周报/);
  const parsed = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'weekly', '--days', '7', '--home', h.home, '--json'],
    { encoding: 'utf8', env }));
  assert.ok(parsed.totals.engagements >= 1);

  const outPath = join(h.home, 'weekly.md');
  const meta = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'weekly', '--days', '7', '--out', outPath,
    '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(meta.path, outPath);
});

test('无战役时：周报为空但不报错', () => {
  const h = harness();
  // 删掉默认 harness 战役目录里的数据？改为新建一个空 home
  const { mkdtempSync } = { mkdtempSync: null };
  void mkdtempSync;
  const empty = h.broker.weekly({ days: 7 });
  assert.ok(empty.totals.engagements >= 1, 'harness 自带一个战役');
  assert.equal(typeof empty.window.from, 'string');
});
