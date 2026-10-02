// 事实查询：过滤、历史修订、按类型统计；工具与 CLI 共用同一实现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';

function seed(h) {
  const ex = h.broker.execute({
    ...h.base, command_id: 'fq-1',
    contract: h.contract({
      fake_members: [
        { entity_type: 'asset', source_id: 'web-01', revision_no: 1, content_hash: 'h1', payload: { port: 80 } },
        { entity_type: 'asset', source_id: 'web-02', revision_no: 1, content_hash: 'h2', payload: { port: 443 } },
        { entity_type: 'vuln', source_id: 'CVE-2026-0001', revision_no: 1, content_hash: 'h3', payload: { sev: 'high' } },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  return ex;
}

test('按类型/来源过滤 + 按类型统计', () => {
  const h = harness();
  seed(h);
  const all = h.store().queryFacts({});
  assert.equal(all.count, 3);
  assert.deepEqual(all.by_type.map((b) => b.entity_type).sort(), ['asset', 'vuln']);

  const assets = h.store().queryFacts({ entityType: 'asset' });
  assert.equal(assets.count, 2);
  const one = h.store().queryFacts({ sourceId: 'web-01' });
  assert.equal(one.count, 1);
  assert.equal(one.rows[0].source_id, 'web-01');
});

test('历史修订：默认只看有效事实，--history 可看被取代修订', () => {
  const h = harness();
  const ex = seed(h);
  // 同一 source_id 的更高修订 → 旧修订失效
  const ex2 = h.broker.execute({
    ...h.base, command_id: 'fq-2',
    contract: h.contract({
      fake_members: [{ entity_type: 'asset', source_id: 'web-01', revision_no: 2, content_hash: 'h1v2', payload: { port: 8080 } }],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex2.task_id, h.adapter.collect(ex2.task_id));
  void ex;

  const active = h.store().queryFacts({ sourceId: 'web-01' });
  assert.equal(active.count, 1);
  assert.equal(active.rows[0].revision_no, 2, '默认应只给最新有效修订');

  const hist = h.store().queryFacts({ sourceId: 'web-01', includeHistory: true });
  assert.equal(hist.count, 2, '历史视图应含被取代修订');
  assert.equal(hist.superseded_total, 1);
});

test('CLI warroom fact 三路过滤可用', () => {
  const h = harness();
  seed(h);
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const cli = (args) => JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'fact', '--engagement', h.eng.engagement_id, '--home', h.home, '--json', ...args], { encoding: 'utf8', env }));

  assert.equal(cli([]).count, 3);
  assert.equal(cli(['--type', 'vuln']).count, 1);
  assert.equal(cli(['--source', 'web']).count, 2);
  assert.equal(cli(['--limit', '1']).count, 1);
});
