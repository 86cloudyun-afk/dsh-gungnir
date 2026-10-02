// 一键交付：产物齐全（报告三格式 + 受众视图 + 索引 + 清单 + 备份）+ 门禁结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

function seedFact(h, id) {
  const ex = h.broker.execute({ ...h.base, command_id: id, contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.settle(h.eng.engagement_id, ex.task_id);
}

test('一键交付：一次调用给齐交付包与门禁结论', () => {
  const h = harness();
  seedFact(h, 'dl-1');

  const r = h.broker.deliver(h.eng.engagement_id, { outDir: join(h.home, 'delivery') });
  for (const p of [r.reports.markdown, r.reports.json, r.reports.html, r.index, r.checklist_file]) {
    assert.ok(existsSync(p), `缺产物 ${p}`);
  }
  assert.equal(r.audience_files.length, 2);
  assert.ok(existsSync(r.audience_files[0].markdown));
  assert.equal(r.verify.reproducible, true);
  assert.ok(r.backup && r.backup.ok === r.backup.total);
  assert.equal(r.gate.deliverable, true, JSON.stringify(r.gate.blocked));
  assert.ok(r.watermark.seq > 0);

  const checklist = readFileSync(r.checklist_file, 'utf8');
  assert.match(checklist, /门禁口径（delivery）/);
});

test('门禁不达标时：仍然产出交付包，但如实标 blocked（工具不隐瞒）', () => {
  const h = harness();
  seedFact(h, 'dl-2');
  // 故意不备份 → 备份必过项不过
  const r = h.broker.deliver(h.eng.engagement_id, { outDir: join(h.home, 'delivery2'), backup: false });
  assert.equal(r.backup, null);
  assert.equal(r.gate.deliverable, false);
  assert.ok(r.gate.blocked.some((b) => b.startsWith('backup：')), JSON.stringify(r.gate.blocked));
  assert.ok(existsSync(r.reports.html), '门禁不过不影响产物完整性');
});

test('CLI deliver：门禁口径正确（不要求活跃出口；要求备份）', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  seedFact(h, 'dl-3');
  const run = (extra = []) => {
    try {
      const out = execFileSync('node', ['bin/warroom.mjs', 'deliver', '--engagement', h.eng.engagement_id,
        '--home', h.home, '--json', ...extra], { encoding: 'utf8', env });
      return { code: 0, parsed: JSON.parse(out) };
    } catch (e) { return { code: e.status, parsed: JSON.parse(e.stdout ?? '{}') }; }
  };

  // 不备份：交付面缺"备份"这一项 → 非零退出（且产物仍齐全，不隐瞒）
  const noBackup = run(['--no-backup']);
  assert.equal(noBackup.code, 1, JSON.stringify(noBackup.parsed.gate));
  assert.equal(noBackup.parsed.gate.deliverable, false);
  assert.ok(noBackup.parsed.gate.blocked.some((b) => b.startsWith('backup：')));
  assert.ok(existsSync(noBackup.parsed.reports.html));

  // 默认（含备份）：交付包完整 → 门禁通过、零退出
  const full = run();
  assert.equal(full.code, 0, JSON.stringify(full.parsed.gate));
  assert.equal(full.parsed.gate.deliverable, true);
  assert.ok(full.parsed.backup.ok === full.parsed.backup.total);
});

test('交付包内的证据索引指向交付清单', () => {
  const h = harness();
  seedFact(h, 'dl-4');
  const r = h.broker.deliver(h.eng.engagement_id, { outDir: join(h.home, 'delivery4') });
  const index = readFileSync(r.index, 'utf8');
  assert.match(index, /## 交付自检/);
  assert.match(index, /DELIVERY_CHECKLIST\.md/);
  assert.match(index, /## 交付视图/);
  void JumphostManager;
});
