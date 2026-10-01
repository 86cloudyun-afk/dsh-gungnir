// DSH 桥驱动：进程内应答器跑完整链路 + 一致性套件 + 超时语义（unknown，不自动重试）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBridgeDriver, DshRedteamDriver } from '../packages/warroom-core/src/adapters/dsh-bridge.js';
import { RedteamModeAdapter } from '../packages/warroom-core/src/adapters/redteam-mode.js';
import { runConformance, summarize } from '../packages/warroom-core/src/adapters/conformance.js';
import { Broker } from '../packages/warroom-core/src/broker.js';

/** 进程内应答器：模拟 DSH 侧对 job/stop 的响应（原子写）。 */
function responder(driver) {
  const state = new Map();
  const write = (path, obj) => {
    const tmp = `${path}.tmp-responder`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, path);
  };
  return (job) => {
    state.set(job.external_id, { session_up: true, container_up: (job.contract.resources ?? []).includes('container') });
    write(driver._statusPath(job.external_id), { protocol: 'gungnir-bridge/1', external_id: job.external_id, state: 'running' });
    write(driver._factsPath(job.external_id), {
      members: job.contract.fake_members ?? [{
        entity_type: 'asset', source_id: 'bridge-a1', revision_no: 1, content_hash: 'h-b1', payload: { ip: '10.0.0.5' },
      }],
    });
    write(driver._probesPath(job.external_id), {
      resources: [
        { id: `${job.external_id}-session`, kind: 'session', stopped: false },
        ...(state.get(job.external_id).container_up ? [{ id: `${job.external_id}-container`, kind: 'container', stopped: false }] : []),
      ],
    });
    // stop 文件出现后 → 停止并更新回执
    const stopPath = driver._stopPath(job.external_id);
    const tick = setInterval(() => {
      if (existsSync(stopPath)) {
        clearInterval(tick);
        state.set(job.external_id, { session_up: false, container_up: false });
        write(driver._statusPath(job.external_id), { protocol: 'gungnir-bridge/1', external_id: job.external_id, state: 'cancel_requested' });
        write(driver._probesPath(job.external_id), {
          resources: [
            { id: `${job.external_id}-session`, kind: 'session', stopped: true },
            ...(job.contract.resources ?? []).includes('container')
              ? [{ id: `${job.external_id}-container`, kind: 'container', stopped: true }] : [],
          ],
        });
      }
    }, 5);
  };
}

function makeAdapter() {
  const root = mkdtempSync(join(tmpdir(), 'wr-bridge-'));
  let driver;
  const adapter = new RedteamModeAdapter({
    driver: (driver = new DshRedteamDriver({ root, timeoutMs: 500 })),
  });
  driver.onJob = responder(driver);
  return { adapter, driver, root };
}

test('桥驱动走完整链路：派单 → 状态 → 事实 → 停止证实', async () => {
  const { adapter } = makeAdapter();
  const r = adapter.dispatch('cmd-bridge-1', {
    targets: ['10.0.0.5'], action_class: 'readonly', task_id: 'wt-b1', generation: '1:1:1',
    resources: ['container'], intent: 'recon',
  });
  assert.equal(r.state, 'running');

  assert.equal(adapter.status(r.task_id).state, 'running');
  const facts = adapter.collect(r.task_id);
  assert.equal(facts.members.length, 1);

  const probesBefore = adapter.manifestOf(r.task_id);
  assert.ok(probesBefore.every((p) => p.check() === false), '停止前资源应未证实');

  adapter.cancel(r.task_id, 'test');
  await new Promise((res) => setTimeout(res, 60)); // 等应答器写回停止探针
  const probesAfter = adapter.manifestOf(r.task_id);
  assert.ok(probesAfter.every((p) => p.check() === true), '停止后逐项应证实');
});

test('桥驱动通过一致性套件（含等待远端停止确认）', async () => {
  const { adapter } = makeAdapter();
  const s = summarize(await runConformance(adapter, { commandIdPrefix: 'bridge', awaitStopMs: 500 }));
  assert.equal(s.failed.length, 0, s.failed.join('\n'));
});

test('超时语义：执行层不响应 → unknown，绝不自动重试，spool 留下待办 job', () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-bridge-dead-'));
  const driver = new DshRedteamDriver({ root, timeoutMs: 60 }); // 无应答器
  const adapter = new RedteamModeAdapter({ driver });
  const r = adapter.dispatch('cmd-dead-1', {
    targets: ['10.0.0.5'], action_class: 'readonly', task_id: 'wt-dead', generation: '1:1:1', resources: [], intent: 'recon',
  });
  assert.equal(r.state, 'unknown');
  const pending = driver.pendingJobs();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].external_id, 'wt-dead');
});

test('Broker 端到端：桥驱动 + 事实入库 + 停止证实（unknown → reconcile 不重做）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-bridge-e2e-'));
  const bridgeRoot = join(home, 'dsh-bridge');
  mkdirSync(bridgeRoot, { recursive: true });
  let driver;
  const adapter = new RedteamModeAdapter({ driver: (driver = new DshRedteamDriver({ root: bridgeRoot, timeoutMs: 500 })) });
  driver.onJob = responder(driver);
  const broker = new Broker({ home, adapter });
  const eng = broker.createEngagement({ user_message_id: 'um-bridge', targets: ['10.0.0.0/24'] });

  const ex = broker.execute({
    command_id: 'bridge-c1', engagement_id: eng.engagement_id, auth_version: 1,
    contract: {
      targets: ['10.0.0.5'], action_class: 'active', resources: [], wire_cost: 0, intent: 'recon',
      fake_members: [{ entity_type: 'asset', source_id: 'e2e-a1', revision_no: 1, content_hash: 'h-e2e', payload: {} }],
    },
  });
  assert.equal(ex.state, 'running');
  const col = broker.collect(eng.engagement_id, ex.task_id, adapter.collect(ex.task_id));
  assert.equal(col.accepted, true);
  assert.equal(broker._eng(eng.engagement_id).store.effectiveCount(), 1);

  // 两阶段语义：cancel 是请求；远端确认滞后 → 首次可能 unresolved，等待后再次 cancel 确认
  const c1 = broker.cancel(eng.engagement_id, ex.task_id, 'e2e');
  assert.ok(['unresolved', 'confirmed_stopped'].includes(c1.state), `首轮状态异常：${c1.state}`);
  await new Promise((r) => setTimeout(r, 80));
  const c2 = broker.cancel(eng.engagement_id, ex.task_id, 'e2e');
  assert.equal(c2.state, 'confirmed_stopped');
});
