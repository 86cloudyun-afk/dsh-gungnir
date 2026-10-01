// 报告导出验收（框架 §5/§8）：水位绑定、IOC 附录、脱敏、导出后新写入不入旧报告。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { JumphostManager } from '../packages/warroom-core/src/jumphosts.js';

const SECRET = 'R3port-P@ss-2026-plain';

test('报告水位与 fact.db 快照一致，且随写入推进', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'rp-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r1 = h.broker.buildReport(h.eng.engagement_id);
  const snap = h.store().exportSnapshot();
  assert.equal(r1.watermark.seq, snap.seq);
  assert.equal(r1.watermark.snapshot_id, snap.snapshot_id);

  // 新写入推进水位
  const ex2 = h.broker.execute({ ...h.base, command_id: 'rp-2', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex2.task_id, h.adapter.collect(ex2.task_id));
  const r2 = h.broker.buildReport(h.eng.engagement_id);
  assert.ok(r2.watermark.seq > r1.watermark.seq);
  assert.notEqual(r2.watermark.snapshot_id, r1.watermark.snapshot_id);
});

test('报告全文不含明文秘密（注册进 vault 的明文在事实里也脱敏）', () => {
  const h = harness();
  const { secret_ref } = h.broker.secrets.put(SECRET, { label: 'ssh-pw' });
  assert.ok(secret_ref);
  const ex = h.broker.execute({
    ...h.base, command_id: 'rp-sec',
    contract: h.contract({
      fake_members: [{
        entity_type: 'credential', source_id: 'cred-1', revision_no: 1, content_hash: 'h-cred',
        payload: { password: SECRET, service: 'ssh', host: '10.0.0.5' },
      }],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const { markdown } = h.broker.buildReport(h.eng.engagement_id);
  assert.equal(markdown.includes(SECRET), false, '报告不得出现明文');
  assert.match(markdown, /REDACTED/);
});

test('IOC/清理附录：隧道、未完成任务、隔离资源都进候选清单', async () => {
  const h = harness({ faults: { containerResidue: true } });
  const jm = new JumphostManager({
    globalDb: h.broker.global,
    getFactStore: (id) => h.broker._eng(id).store,
  });
  jm.importHosts([{ id: 'jh-rp', addr_v4: '203.0.113.77' }]);
  jm.acquire({ engagement_id: h.eng.engagement_id, target: '10.0.0.5' });

  const ex = h.broker.execute({
    ...h.base, command_id: 'rp-ioc',
    contract: h.contract({ resources: ['container'] }),
  });
  const c = h.broker.cancel(h.eng.engagement_id, ex.task_id, 'test');
  assert.equal(c.state, 'unresolved');

  const { markdown } = h.broker.buildReport(h.eng.engagement_id);
  assert.match(markdown, /IOC \/ 清理附录/);
  assert.match(markdown, /tunnel/);
  assert.match(markdown, /unfinished/);
});

test('导出文件：水位入文件名，旧文件不含导出后新增的事实', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'rp-f1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const first = h.broker.exportReport(h.eng.engagement_id);
  const firstText = readFileSync(first.path, 'utf8');
  assert.match(first.path, /-report-\d+\.md$/);

  const ex2 = h.broker.execute({
    ...h.base, command_id: 'rp-f2',
    contract: h.contract({
      fake_members: [{
        entity_type: 'asset', source_id: 'new-asset', revision_no: 1, content_hash: 'h-new',
        payload: { ip: '10.0.0.99' },
      }],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex2.task_id, h.adapter.collect(ex2.task_id));

  assert.equal(firstText.includes('new-asset'), false, '旧报告不应包含导出后新增事实');
  const second = h.broker.exportReport(h.eng.engagement_id);
  assert.ok(second.watermark.seq > first.watermark.seq);
  assert.equal(readFileSync(second.path, 'utf8').includes('new-asset'), true);
});

test('报告声明半自动口径：IOC 需人工确认、无明文凭据', () => {
  const h = harness();
  const { markdown } = h.broker.buildReport(h.eng.engagement_id);
  assert.match(markdown, /人工确认/);
  assert.match(markdown, /无明文凭据/);
});
