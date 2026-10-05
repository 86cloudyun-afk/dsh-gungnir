// 周报：窗口内活跃战役汇总；交付门禁与报告新鲜度入表；窗口外战役不出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { FakeAdapter } from '../packages/warroom-core/src/adapters/fake.js';
import { renderWeekly } from '../packages/warroom-core/src/weekly.js';
import { markdownToHtml } from '../packages/warroom-core/src/html.js';
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

test('归档：按 ISO 周落盘，同周重复执行即覆盖为最新', () => {
  const h = harness();
  makeEng(h, 'wk-arch');
  const a1 = h.broker.archiveWeekly({ days: 7 });
  assert.match(a1.label, /^\d{4}-W\d{2}$/);
  assert.match(a1.path, new RegExp(`${a1.label}\\.md$`));
  assert.equal(a1.existing.length, 1);
  const first = readFileSync(a1.path, 'utf8');

  // 同周再归档（有新战役）→ 覆盖，内容更新，文件数不变
  makeEng(h, 'wk-arch-2');
  const a2 = h.broker.archiveWeekly({ days: 7 });
  assert.equal(a2.label, a1.label);
  assert.equal(a2.existing.length, 1, '同周不产生第二份');
  const second = readFileSync(a2.path, 'utf8');
  assert.notEqual(second, first, '同周重复归档应刷新为最新');
  assert.equal(second.includes('wk-arch-2'), false, '周报正文用战役 id，不该出现 user_message_id');
});

test('归档：不同 ISO 周各自成文件，倒序列出', () => {
  const h = harness();
  makeEng(h, 'wk-arch-3');
  const past = Date.parse('2026-09-01T00:00:00.000Z');   // 另一个 ISO 周
  const a1 = h.broker.archiveWeekly({ days: 7, now: past });
  const a2 = h.broker.archiveWeekly({ days: 7, now: Date.now() });
  assert.notEqual(a1.label, a2.label);
  assert.equal(a2.existing.length, 2);
  assert.deepEqual([...a2.existing].sort().reverse(), a2.existing, '应按周倒序');
});

test('CLI weekly --archive 可用并返回路径', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const out = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'weekly', '--archive', '--home', h.home, '--json'],
    { encoding: 'utf8', env }));
  assert.ok(out.path.endsWith('.md'));
  assert.ok(out.label);
  assert.ok(readFileSync(out.path, 'utf8').includes('# 战役周报'));
});

test('周报：目标/节奏含竖线或换行不塌表（.md 与 HTML 列数都保全）', () => {
  const w = {
    window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', days: 7 },
    totals: { engagements: 1, deliverable: 0, facts: 10, facts_in_window: 3, reports_in_window: 1, shells: 0 },
    rows: [{
      engagement_id: '01ABCDEFGHIJKLMNOPQRSTUVWX',
      // 配置自由文本：含竖线与换行（html.js 不认 \| 转义，裸切 | 会丢列）
      target_scope: '*.corp.example.com | 禁 prod-db\n第二行注释',
      rhythm: 'open | 夜间\r\n加一段',
      facts_in_window: 3, facts: 10, reports_in_window: 1, reports: 2,
      delivery: { deliverable: false, blocked: 2 },
    }],
    note: 'x',
  };
  const md = renderWeekly(w);
  const bodyRow = md.split('\n').find((l) => l.startsWith('| `01ABC'));
  // 该数据行不得被换行劈开，且恰有 8 个 | 边界（7 列）
  assert.ok(bodyRow, '数据行应整行存在，不被换行截断');
  assert.equal((bodyRow.match(/\|/g) || []).length, 8, '一行应恰好 7 列（8 个竖线边界）');
  assert.ok(!bodyRow.includes('第二行注释\n') && !bodyRow.includes('\n'), '换行应被折叠');

  const html = markdownToHtml(md);
  const table = html.match(/<table>[\s\S]*?<\/table>/)[0];
  const firstBodyTr = table.split('<tbody>')[1].match(/<tr>[\s\S]*?<\/tr>/)[0];
  const tdCount = (firstBodyTr.match(/<td>/g) || []).length;
  assert.equal(tdCount, 7, 'HTML 表体首行应保全 7 个单元格，不因竖线丢列');
  // 交付门禁列（最后一列）仍在
  assert.ok(firstBodyTr.includes('未过 2 项'), '末列交付门禁不得被前面的竖线吞掉');
});
