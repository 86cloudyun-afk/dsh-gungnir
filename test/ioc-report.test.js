// IOC 自动聚合 + 报告 JSON 双格式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';
import { aggregateIoc } from '../packages/warroom-core/src/ioc.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

test('IOC 聚合：分类、去重、置信度、证据引用齐全', () => {
  const h = harness({ faults: { containerResidue: true } });
  const jm = new JumphostManager({ globalDb: h.broker.global, getFactStore: (id) => h.broker._eng(id).store });
  jm.importHosts([{ id: 'ioc-jh', addr_v4: '203.0.113.42' }]);
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const ex = h.broker.execute({
    ...h.base, command_id: 'ioc-c1',
    contract: h.contract({
      resources: ['container'],
      fake_members: [
        { entity_type: 'credential', source_id: 'cred-1', revision_no: 1, content_hash: 'h1', payload: { service: 'ssh' } },
        { entity_type: 'session', source_id: 'sess-1', revision_no: 1, content_hash: 'h2', payload: { host: '10.0.0.5' } },
        { entity_type: 'asset', source_id: 'a-plain', revision_no: 1, content_hash: 'h3', payload: {} },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.cancel(h.eng.engagement_id, ex.task_id, 'ioc'); // 容器残留 → unresolved

  const agg = aggregateIoc({ store: h.store(), globalDb: h.broker.global, engagementId: h.eng.engagement_id });
  const kinds = agg.items.map((i) => i.kind);
  assert.ok(kinds.includes('credential-ref'));
  assert.ok(kinds.includes('session'));
  assert.ok(kinds.includes('tunnel'));
  assert.ok(kinds.includes('unfinished-task'));
  assert.equal(kinds.includes('artifact'), false, '普通资产不应进 IOC');
  assert.equal(agg.summary.total, agg.items.length);
  assert.ok(agg.summary.manual_confirm_required >= 2);
  assert.ok(agg.items.every((i) => i.evidence_ref && i.confidence));

  // 去重：重复聚合同一状态不产生新条目
  const again = aggregateIoc({ store: h.store(), globalDb: h.broker.global, engagementId: h.eng.engagement_id });
  assert.equal(again.summary.digest, agg.summary.digest);
});

test('报告 JSON：schema/水位/事实/壳状态/IOC 同源', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'ioc-j1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  h.broker.recordShellProof(h.eng.engagement_id, { proof: 'root@10.0.0.5' });

  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  assert.ok(r.paths.markdown && r.paths.json);
  const json = JSON.parse(readFileSync(r.paths.json, 'utf8'));
  assert.equal(json.schema, 'gungnir-report/1');
  assert.equal(json.watermark.seq, r.watermark.seq);
  assert.equal(json.shell.highest_proof, 'root@10.0.0.5');
  assert.equal(json.shell.current_validity, 'unknown', '历史证明不改变当前有效性');
  assert.equal(json.facts.effective.length, 1);
  assert.ok(json.ioc_summary && Array.isArray(json.ioc));

  // 两份报告水位一致（同一份数据的两个视图）
  const md = readFileSync(r.paths.markdown, 'utf8');
  assert.match(md, new RegExp(`seq: .?${r.watermark.seq}`));
  assert.match(md, /自动聚合/);
});

test('报告 JSON 同样脱敏：明文秘密不入 JSON', () => {
  const SECRET = 'json-secret-abcdef-2026';
  const h = harness();
  const { secret_ref } = h.broker.secrets.put(SECRET, { label: 'ssh-pw' });
  const ex = h.broker.execute({
    ...h.base, command_id: 'ioc-sec',
    contract: h.contract({
      fake_members: [{ entity_type: 'credential', source_id: 'c-json', revision_no: 1, content_hash: 'h', payload: { password: SECRET } }],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'json' });
  const text = readFileSync(r.paths.json, 'utf8');
  assert.equal(text.includes(SECRET), false, 'JSON 报告不得含明文');
  assert.ok(secret_ref);
});

test('CLI：report --format json 可用', () => {
  const h = harness();
  const out = execFileSync('node', ['bin/warroom.mjs', 'report', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--format', 'json', '--json'], { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '' } });
  const parsed = JSON.parse(out);
  assert.ok(parsed.paths.json.endsWith('.json'));
});
