// 修复建议：自带说明优先；无则按类型给通用建议并明确标注（不冒充逐条结论）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { buildRemediation } from '../packages/warroom-core/src/remediation.js';

test('自带修复说明优先于通用建议', () => {
  const r = buildRemediation([
    { entity_type: 'vuln', source_id: 'CVE-1', payload: { remediation: '升级到 2.3.1 并重启服务' } },
    { entity_type: 'vuln', source_id: 'SQLI-1', payload: { note: 'SQL 注入点 /login' } },
  ]);
  assert.equal(r.items[0].generic, false);
  assert.equal(r.items[0].advice, '升级到 2.3.1 并重启服务');
  assert.equal(r.items[1].generic, true);
  assert.match(r.items[1].advice, /参数化查询/);
  assert.equal(r.generic_count, 1);
});

test('无匹配类型：给基线建议而非留空', () => {
  const r = buildRemediation([{ entity_type: 'vuln', source_id: 'WEIRD-1', payload: { x: 1 } }]);
  assert.match(r.items[0].advice, /最小权限与补丁管理基线/);
  assert.equal(r.items[0].generic, true);
});

test('只对 vuln/credential/chain 出建议（asset/session 不凑数）', () => {
  const r = buildRemediation([
    { entity_type: 'asset', source_id: 'A-1', payload: {} },
    { entity_type: 'session', source_id: 'S-1', payload: {} },
    { entity_type: 'credential', source_id: 'C-1', payload: { note: '弱口令 admin/123456' } },
  ]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].ref, 'C-1');
  assert.match(r.items[0].advice, /口令策略/);
});

test('报告收录修复建议段：通用条目带明确标注；JSON 含 remediation', () => {
  const h = harness();
  const ex = h.broker.execute({
    ...h.base, command_id: 'rem-1',
    contract: h.contract({
      fake_members: [
        { entity_type: 'vuln', source_id: 'CVE-REM-1', revision_no: 1, content_hash: 'h1', payload: { fix: '打补丁到 1.2.3' } },
        { entity_type: 'vuln', source_id: 'SSRF-REM-1', revision_no: 1, content_hash: 'h2', payload: { note: 'SSRF 可打元数据' } },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'both' });
  const md = readFileSync(r.paths.markdown, 'utf8');
  assert.match(md, /## 修复建议/);
  assert.match(md, /打补丁到 1\.2\.3/);
  assert.match(md, /按类型给出的通用建议/);
  assert.match(md, /出站白名单/);
  assert.match(md, /来源：事实自带修复说明/);
  assert.match(md, /来源：按类型通用建议/);

  const json = JSON.parse(readFileSync(r.paths.json, 'utf8'));
  assert.equal(json.remediation.items.length, 2);
  assert.equal(json.remediation.generic_count, 1);
});

test('无 vuln 事实时：不出现修复建议段（不编造）', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'rem-2', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'md' });
  assert.equal(readFileSync(r.paths.markdown, 'utf8').includes('## 修复建议'), false);
});
