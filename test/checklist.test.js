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

test('交付门禁：未完成必过项 → deliverable=false 且列出未过项', () => {
  const h = harness();
  const c = h.broker.checklist(h.eng.engagement_id);
  assert.equal(c.profile, 'delivery');
  assert.equal(c.deliverable, false);
  assert.ok(c.gate.length >= 5, `必过项应 ≥5，实际 ${c.gate.length}`);
  assert.ok(c.blocked.some((b) => b.startsWith('report：')), JSON.stringify(c.blocked));
  const text = renderChecklist(c);
  assert.match(text, /\*\*门禁口径（delivery）\*\*/);
  assert.match(text, /未过：/);
});

test('进度口径宽松：未开工也 deliverable=true（只盯异常态）', () => {
  const h = harness();
  const c = h.broker.checklist(h.eng.engagement_id, { profile: 'progress' });
  assert.equal(c.profile, 'progress');
  assert.ok(c.gate.length < 5);
  assert.equal(c.deliverable, true, '进度口径：没干活不算异常（不要求报告/证据/备份）');
});

test('CLI --strict：必过项未全通过即非零退出；达成后零退出', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const runStrict = () => {
    try {
      const out = execFileSync('node', ['bin/warroom.mjs', 'checklist', '--engagement', h.eng.engagement_id,
        '--home', h.home, '--strict', '--json'], { encoding: 'utf8', env });
      return { code: 0, parsed: JSON.parse(out) };
    } catch (e) { return { code: e.status, parsed: JSON.parse(e.stdout ?? '{}') }; }
  };
  assert.equal(runStrict().code, 1, '未交付前 strict 应非零');

  // 先落事实（水位必过项需要 seq>0），再补齐报告/证据/备份
  const ex = h.broker.execute({ ...h.base, command_id: 'ck-strict-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.settle(h.eng.engagement_id, ex.task_id);
  h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  h.broker.exportEvidence(h.eng.engagement_id, { outDir: join(h.home, 'engagements', h.eng.engagement_id, 'evidence') });
  backupHome({ home: h.home });
  const after = runStrict();
  assert.equal(after.code, 0, JSON.stringify(after.parsed.blocked));
  assert.equal(after.parsed.deliverable, true);
});

test('人工确认留痕：确认前是待办；确认后带署名与结论（机器仍不自动判定）', () => {
  const h = harness();
  const before = h.broker.checklist(h.eng.engagement_id);
  const shellItem = before.items.find((i) => i.id === 'shell');
  assert.equal(shellItem.status, '☐');
  assert.equal(shellItem.pending_confirmation, true);

  const rec = h.broker.confirmChecklistItem(h.eng.engagement_id, {
    itemId: 'shell', by: 'yg', note: '人工复核：当前可控性 unknown（未复验）',
  });
  assert.equal(rec.item_id, 'shell');
  assert.ok(rec.at);

  const after = h.broker.checklist(h.eng.engagement_id);
  const shellAfter = after.items.find((i) => i.id === 'shell');
  assert.equal(shellAfter.status, '✅');
  assert.equal(shellAfter.confirmed.by, 'yg');
  assert.match(shellAfter.confirmed.note, /未复验/);
  assert.equal(shellAfter.pending_confirmation, undefined);

  // 审计留痕可查
  const audit = h.broker.audit(h.eng.engagement_id, { decision: 'checklist_confirm' });
  assert.equal(audit.rows.length, 1);

  // 渲染：待办段的说明与人工标记
  const text = renderChecklist(before);
  assert.match(text, /（人工）/);
  assert.match(text, /待人工确认/);
  assert.match(text, /--confirm <id>/);
});

test('自动判定计数只含自动项：人工确认不计入 done（done ≤ total，不倒挂）', () => {
  const h = harness();
  const autoOk = (c) => c.items.filter((i) => !i.manual && i.status === '✅').length;

  const before = h.broker.checklist(h.eng.engagement_id);
  assert.equal(before.done, autoOk(before), 'done 应只统计自动判定通过项');
  assert.ok(before.done <= before.total, `done(${before.done}) 不得超过 total(${before.total})`);

  // 确认两个人工项（控制面有效性 / IOC 附录）→ 它们翻成 ✅，但属于「人工确认」而非「自动判定」
  h.broker.confirmChecklistItem(h.eng.engagement_id, { itemId: 'shell', by: 'yg', note: 'ok' });
  h.broker.confirmChecklistItem(h.eng.engagement_id, { itemId: 'ioc', by: 'yg', note: 'ok' });

  const after = h.broker.checklist(h.eng.engagement_id);
  // 核心回归：人工确认项（现为 ✅）不得被算进「自动判定」的 done
  assert.equal(after.done, autoOk(after), '人工确认项不得抬高自动判定通过数');
  assert.ok(after.done <= after.total, `done(${after.done}) 不得超过 total(${after.total})`);
  assert.equal(after.manual, 2, '人工项数量单独统计，不随确认变化');

  // 渲染行 `自动判定：done/total` 不得倒挂（N ≤ M）
  const m = /自动判定：\*\*(\d+)\/(\d+)\*\*/.exec(renderChecklist(after));
  assert.ok(m && Number(m[1]) <= Number(m[2]), `自动判定计数不得倒挂：${m && `${m[1]}/${m[2]}`}`);
});

test('人工确认只允许人工项；自动项不接受"确认"（不许绕过判定）', () => {
  const h = harness();
  assert.throws(() => h.broker.confirmChecklistItem(h.eng.engagement_id, { itemId: 'report', by: 'x' }),
    /人工确认只适用于人工项/);
  assert.equal(h.broker.audit(h.eng.engagement_id, { decision: 'checklist_confirm' }).rows.length, 0);
});

test('确认不改变交付门禁（门禁只看自动项）', () => {
  const h = harness();
  const before = h.broker.checklist(h.eng.engagement_id).deliverable;
  h.broker.confirmChecklistItem(h.eng.engagement_id, { itemId: 'shell', by: 'yg', note: 'ok' });
  const after = h.broker.checklist(h.eng.engagement_id).deliverable;
  assert.equal(before, after, '人工确认不得把门禁刷绿');
});

test('CLI checklist --confirm 可用；非法项非零退出', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const rec = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'checklist', '--engagement', h.eng.engagement_id,
    '--confirm', 'ioc', '--by', 'yg', '--note', 'IOC 已逐条核', '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(rec.item_id, 'ioc');
  const after = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'checklist', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(after.items.find((i) => i.id === 'ioc').status, '✅');

  let code = 0;
  try {
    execFileSync('node', ['bin/warroom.mjs', 'checklist', '--engagement', h.eng.engagement_id,
      '--confirm', 'report', '--home', h.home, '--json'], { encoding: 'utf8', env, stdio: 'pipe' });
  } catch (e) { code = e.status; }
  assert.notEqual(code, 0, '对自动项确认应失败');
});
