// 效率数据导出：行结构与 CSV 转义；CLI --csv 输出与文件落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { metricsToRows } from '../packages/warroom-core/src/metrics-export.js';

test('行结构：total/segment/rework/by_role/by_tier 五节齐全', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'mc-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.settle(h.eng.engagement_id, ex.task_id);
  h.broker.recordMetrics(h.eng.engagement_id, 'mc-1', { tokens_in: 500, role: 'recon', model_tier: 'flash' });

  const { rows, csv } = metricsToRows(h.broker.metrics(h.eng.engagement_id));
  const sections = new Set(rows.map((r) => r.section));
  for (const s of ['total', 'segment', 'rework', 'retry', 'by_role', 'by_tier']) {
    assert.ok(sections.has(s), `缺 section ${s}`);
  }
  assert.match(csv.split('\n')[0], /^section,key,metric,value$/);
  assert.match(csv, /by_tier,flash,facts_per_1000_tokens/);
  assert.equal(csv.trim().split('\n').length, rows.length + 1, '行数与表头一致');
});

test('CSV 转义：含逗号/引号的值被正确包裹', () => {
  const metrics = {
    tasks: 1, commands: 1, tokens_in: 0, tokens_out: 0, wall_time_ms: 0,
    verified_facts: 0, effective_facts: 0, facts_per_1000_tokens: null, ms_per_fact: null,
    segments: { queue_ms: null, handoff_ms: null, exec_ms: null, samples: {}, rework: {} },
    by_role: { 'a,b': { tasks: 1, tokens: 0, verified: 0, wall_time_ms: 0, facts_per_1000_tokens: null, ms_per_verified_fact: null } },
    by_tier: {}, rework: {},
  };
  const { csv } = metricsToRows(metrics);
  assert.match(csv, /"a,b",tasks,1/);
});

test('CLI metrics --csv：标准输出与 --out 落盘都可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const ex = h.broker.execute({ ...h.base, command_id: 'mc-cli', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.recordMetrics(h.eng.engagement_id, 'mc-cli', { tokens_in: 10, role: 'chain', model_tier: 'pro' });

  const stdout = execFileSync('node', ['bin/warroom.mjs', 'metrics', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--csv'], { encoding: 'utf8', env });
  assert.match(stdout, /^section,key,metric,value/);
  assert.match(stdout, /by_role,chain,tokens,10/);

  const outPath = join(h.home, 'metrics.csv');
  const meta = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'metrics', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--csv', '--out', outPath, '--json'], { encoding: 'utf8', env }));
  assert.ok(existsSync(outPath));
  assert.equal(meta.rows >= 10, true);
  assert.match(readFileSync(outPath, 'utf8'), /segment,queue,ms/);
});
