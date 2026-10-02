// 交付清单：自动项按真实状态判定；人工项不打勾；可落盘为交付附件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { renderChecklist } from '../packages/warroom-core/src/checklist.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';
import { backupHome } from '../packages/warroom-core/src/maintenance.js';

const mk = (h) => new JumphostManager({
  globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store,
  listEngagements: () => h.broker.listEngagements(),
});

test('全自动项：未开工的战役几乎全是未勾选，且每条给原因', () => {
  const h = harness();
  const c = h.broker.checklist(h.eng.engagement_id);
  const byId = Object.fromEntries(c.items.map((i) => [i.id, i]));
  assert.equal(byId.auth.status, '✅', '授权冻结应通过');
  assert.equal(byId.egress.status, '⬜');
  assert.match(byId.egress.detail, /活跃 route 0/);
  assert.equal(byId.report.status, '⬜');
  assert.match(byId.report.detail, /尚未导出报告/);
  assert.equal(byId.evidence.status, '⬜');
  assert.equal(byId.backup.status, '⬜');
  assert.ok(c.manual >= 2, '人工确认项至少 2 条（控制面有效性 / IOC 附录）');
});

test('做完一轮后：出口/报告/证据/备份/收口等自动项转为通过', () => {
  const h = harness();
  const jm = mk(h);
  jm.importHosts([{ id: 'ck-jh', addr_v4: '203.0.113.90' }]);
  const acq = jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });
  h.broker.recordEgressCheck(h.eng.engagement_id, { jumphost_id: 'ck-jh', exit_ip: '203.0.113.90', route_id: acq.route_id });

  const ex = h.broker.execute({
    ...h.base, command_id: 'ck-1',
    contract: h.contract({
      fake_members: [
        { entity_type: 'asset', source_id: '10.0.0.5', revision_no: 1, content_hash: 'h1', payload: {} },
        { entity_type: 'chain', source_id: 'chain-ck', revision_no: 1, content_hash: 'h2', payload: { path: ['10.0.0.5', 'x'] } },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.settle(h.eng.engagement_id, ex.task_id);
  h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  // 证据索引检查的是证据目录内的 EVIDENCE_INDEX.md：默认位置是 <home>/engagements/<id>/evidence
  h.broker.exportEvidence(h.eng.engagement_id, {
    outDir: join(h.home, 'engagements', h.eng.engagement_id, 'evidence'),
  });
  backupHome({ home: h.home });
  jm.releaseRoute({ route_id: acq.route_id, engagementId: h.eng.engagement_id });

  const c = h.broker.checklist(h.eng.engagement_id);
  const byId = Object.fromEntries(c.items.map((i) => [i.id, i]));
  for (const id of ['auth', 'watermark', 'path', 'report', 'evidence', 'audit', 'backup', 'cleanup']) {
    assert.equal(byId[id].status, '✅', `${id} 应通过（${byId[id].detail}）`);
  }
  assert.equal(byId.egress.status, '⬜', '收口后无活跃出口 → 该项不再通过（如实）');
  assert.equal(byId.shell.status, '☐', '人工项不打勾');
  assert.ok(c.done >= 8, `通过项应 ≥8，实际 ${c.done}`);
});

test('报告漂移后：报告项如实转为未通过', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'ck-2', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.exportReport(h.eng.engagement_id, { format: 'md' });
  assert.equal(h.broker.checklist(h.eng.engagement_id).items.find((i) => i.id === 'report').status, '✅');

  const ex2 = h.broker.execute({ ...h.base, command_id: 'ck-3', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex2.task_id, h.adapter.collect(ex2.task_id));
  const after = h.broker.checklist(h.eng.engagement_id).items.find((i) => i.id === 'report');
  assert.equal(after.status, '⬜');
  assert.match(after.detail, /已漂移，需重出/);
});

test('渲染与落盘：勾选清单写进证据目录，含判定原则说明', () => {
  const h = harness();
  const text = renderChecklist(h.broker.checklist(h.eng.engagement_id));
  assert.match(text, /# 交付清单 · eng_/);
  assert.match(text, /自动判定：\*\*\d+\/\d+\*\* 项通过/);
  assert.match(text, /人工确认：\*\*\d+\*\* 项/);
  assert.match(text, /绝不打勾充数/);

  const r = h.broker.exportChecklist(h.eng.engagement_id);
  assert.ok(existsSync(r.path));
  assert.match(r.path, /DELIVERY_CHECKLIST\.md$/);
  assert.ok(r.total > 0 && r.manual >= 2);
});

test('CLI checklist 文本/JSON/落盘三路可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const text = execFileSync('node', ['bin/warroom.mjs', 'checklist', '--engagement', h.eng.engagement_id, '--home', h.home, '--text'],
    { encoding: 'utf8', env });
  assert.match(text, /交付清单/);
  const parsed = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'checklist', '--engagement', h.eng.engagement_id, '--home', h.home, '--json'],
    { encoding: 'utf8', env }));
  assert.ok(Array.isArray(parsed.items));
  const exp = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'checklist', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--write', '--json'], { encoding: 'utf8', env }));
  assert.ok(existsSync(exp.path));
  assert.match(readFileSync(exp.path, 'utf8'), /交付清单/);
});
