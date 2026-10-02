// 报告自校验：导出即复核可复现性，结论写入 md 与 json。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { verifyReportAgainstStore } from '../packages/warroom-core/src/report.js';

test('导出的报告含自校验段且标记可复现', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'sc-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  assert.equal(r.self_check.reproducible, true);
  assert.ok(r.self_check.checked_at);

  const md = readFileSync(r.paths.markdown, 'utf8');
  assert.match(md, /## 自校验（导出时即时复核）/);
  assert.match(md, /可复现/);
  assert.match(md, /verify-report\.mjs/);

  const json = JSON.parse(readFileSync(r.paths.json, 'utf8'));
  assert.equal(json.self_check.reproducible, true);
  assert.equal(json.self_check.report_snapshot, r.watermark.snapshot_id);
});

test('漂移检测：报告生成后库有写入 → 复核如实标记漂移（seq 差给出）', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'sc-2', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  // 1) 先正常导出（此刻可复现）
  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'md' });
  assert.equal(r.self_check.reproducible, true);

  // 2) 报告生成后再写入一条事实（走**正常写入路径**，水位随之推进），用同一份报告文本复核
  const built = h.broker.buildReport(h.eng.engagement_id);
  const before = h.store().seq();
  const ex2 = h.broker.execute({ ...h.base, command_id: 'sc-2b', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex2.task_id, h.adapter.collect(ex2.task_id));
  assert.ok(h.store().seq() > before, '水位应推进（否则本测试前提不成立）');

  const recheck = verifyReportAgainstStore(built.markdown, h.store());
  assert.equal(recheck.reproducible, false, '库已变化，复核必须如实标记漂移');
  assert.ok(recheck.drift.seq > 0, `应给出 seq 差，实际 ${recheck.drift.seq}`);

  // 3) 导出路径在漂移时也如实写入 md（用已漂移的库再导一次基线报告对照）
  const after = h.broker.exportReport(h.eng.engagement_id, { format: 'md' });
  assert.equal(after.self_check.reproducible, true, '新导出应对齐当前水位（此后再次写入才会漂移）');
});

test('导出即校验（exportReportVerified）：一次调用拿到报告与可复现结论', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'vr-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r = h.broker.exportReportVerified(h.eng.engagement_id, { format: 'both' });
  assert.ok(r.paths.markdown && r.paths.json);
  assert.equal(r.verify.reproducible, true);
  assert.equal(r.verify.drift_seq, 0);
  assert.ok(r.verify.checked_at);
  assert.equal(r.verify.report_seq, r.watermark.seq);
});

test('导出即校验：库在导出后变化 → verify 如实报漂移（交付前可拦）', () => {
  // 节奏档上限 2：每个任务跑完即时结项，避免撞并发闸（与业务无关的装置约束）
  const h = harness({ authOverrides: { rhythm: 'open' } });
  const run = (id) => {
    const ex = h.broker.execute({ ...h.base, command_id: id, contract: h.contract() });
    h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
    h.broker.settle(h.eng.engagement_id, ex.task_id);
    return ex;
  };

  run('vr-2');
  const ok = h.broker.exportReportVerified(h.eng.engagement_id, { format: 'md' });
  assert.equal(ok.verify.reproducible, true);

  // 取一份报告文本，然后在库继续变化之后再复核（模拟"导出后又有写入"）
  const built = h.broker.buildReport(h.eng.engagement_id);
  const store = h.store();
  run('vr-3');
  const verdict = verifyReportAgainstStore(built.markdown, store);
  assert.equal(verdict.reproducible, false, '库已变化，复核必须报漂移');
  assert.ok(verdict.drift.seq > 0, '应给出 seq 差');
});
