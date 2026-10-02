// 出口验证：记录/状态 + 可选强制门闸（默认关闭，开启后无有效记录即拒绝出网）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';

test('记录与状态：无记录时不通过；记录 pass 后有效', () => {
  const h = harness();
  const st0 = h.broker.egressStatus(h.eng.engagement_id);
  assert.equal(st0.valid, false);
  assert.equal(st0.last, null);

  h.broker.recordEgressCheck(h.eng.engagement_id, { jumphost_id: 'jh-1', exit_ip: '203.0.113.5' });
  const st1 = h.broker.egressStatus(h.eng.engagement_id);
  assert.equal(st1.valid, true);
  assert.equal(st1.last.exit_ip, '203.0.113.5');
  assert.ok(st1.age_min >= 0);

  // 留痕：gate_log 有 egress_check
  const log = h.store().db.prepare("SELECT COUNT(*) c FROM gate_log WHERE decision = 'egress_check'").get().c;
  assert.equal(log, 1);
});

test('fail 结果使状态失效（不通过）', () => {
  const h = harness();
  h.broker.recordEgressCheck(h.eng.engagement_id, { jumphost_id: 'jh-1', exit_ip: '198.51.100.9', verdict: 'fail' });
  const st = h.broker.egressStatus(h.eng.engagement_id);
  assert.equal(st.valid, false);
  assert.equal(st.last.verdict, 'fail');
});

test('默认不强制：未验证也能出网；开启 requireEgressCheck 后拒绝', async () => {
  const h = harness();
  const c = h.contract({ wire_cost: 1 });
  const ok = h.broker.execute({ ...h.base, command_id: 'eg-1', contract: c });
  assert.equal(ok.state, 'running', '默认（requireEgressCheck=false）不应拦截');

  // 开启强制
  writeFileSync(join(h.home, 'warroom.json'), JSON.stringify({ rhythm: 'open', requireEgressCheck: true, egressMaxAgeMin: 30 }));
  const { Broker } = await import('../packages/warroom-core/src/broker.js');
  const b2 = new Broker({ home: h.home, adapter: h.adapter });
  let err = null;
  try {
    b2.execute({
      engagement_id: h.eng.engagement_id, auth_version: h.broker._auth(h.eng.engagement_id).row.auth_version,
      command_id: 'eg-2',
      contract: { targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 1,
        fake_members: [{ entity_type: 'asset', source_id: 'eg-2', revision_no: 1, content_hash: 'h', payload: {} }] },
    });
  } catch (e) { err = e; }
  assert.equal(err?.code, 'E_GATE_EGRESS_UNVERIFIED');

  // 记录一次 pass 后放行
  b2.recordEgressCheck(h.eng.engagement_id, { jumphost_id: 'jh-1', exit_ip: '203.0.113.5' });
  const ok2 = b2.execute({
    engagement_id: h.eng.engagement_id, auth_version: h.broker._auth(h.eng.engagement_id).row.auth_version,
    command_id: 'eg-3',
    contract: { targets: ['10.0.0.6'], action_class: 'active', resources: [], wire_cost: 1,
      fake_members: [{ entity_type: 'asset', source_id: 'eg-3', revision_no: 1, content_hash: 'h', payload: {} }] },
  });
  assert.equal(ok2.state, 'running');
});

test('无出网开销的任务不受出口门闸影响（wire_cost=0）', async () => {
  const h = harness();
  writeFileSync(join(h.home, 'warroom.json'), JSON.stringify({ requireEgressCheck: true }));
  const { Broker } = await import('../packages/warroom-core/src/broker.js');
  const b2 = new Broker({ home: h.home, adapter: h.adapter });
  const r = b2.execute({
    engagement_id: h.eng.engagement_id, auth_version: h.broker._auth(h.eng.engagement_id).row.auth_version,
    command_id: 'eg-4',
    contract: { targets: ['10.0.0.7'], action_class: 'readonly', resources: [], wire_cost: 0,
      fake_members: [{ entity_type: 'asset', source_id: 'eg-4', revision_no: 1, content_hash: 'h', payload: {} }] },
  });
  assert.equal(r.state, 'running');
});

test('CLI egress record / status 可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const cli = (args) => JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'egress', ...args, '--engagement', h.eng.engagement_id, '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(cli(['status']).valid, false);
  const rec = cli(['record', '--jumphost', 'jh-x', '--ip', '203.0.113.77']);
  assert.equal(rec.verdict, 'pass');
  const st = cli(['status']);
  assert.equal(st.valid, true);
  assert.equal(st.last.exit_ip, '203.0.113.77');
});
