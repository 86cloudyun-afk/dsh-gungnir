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
