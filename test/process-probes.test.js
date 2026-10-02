// 进程级取消证实（ADR-004 范围项 2）：停止证明落到可实测对象，账本不算证明。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { pidAlive, portOpen, containerAlive, probeResource } from '../packages/warroom-core/src/probes.js';
import { harness } from '../packages/warroom-core/src/testing.js';

test('PID 探针：自身存活为真，不存在的 PID 为假（真实系统调用）', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999999), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive('abc'), false);
});

test('端口探针：真实监听返回 OPEN，关闭后返回 CLOSED', async () => {
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.equal(portOpen(port), true, '监听中应为 OPEN');
  await new Promise((r) => server.close(r));
  assert.equal(portOpen(port), false, '关闭后应为 CLOSED');
});

test('容器探针：docker 不可用 → null（未知，绝不假装已停）', () => {
  const r = containerAlive('nonexistent-container-id');
  assert.ok(r === null || r === false, `应为 null 或 false，实际 ${r}`);
  assert.equal(probeResource({ kind: 'container', container_id: 'x' }).alive === null
    || probeResource({ kind: 'container', container_id: 'x' }).alive === false, true);
});

test('端到端：子进程仍在 → unresolved；杀掉后才 confirmed_stopped（真实进程）', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const h = harness();
    const ex = h.broker.execute({
      ...h.base, command_id: 'pp-1',
      contract: h.contract({
        resources: [{ kind: 'process', id: 'sleep-child', pid: child.pid }],
      }),
    });
    // 首轮取消：探针实测子进程仍在 → 必须 unresolved
    const c1 = h.broker.cancel(h.eng.engagement_id, ex.task_id, 'test');
    assert.equal(c1.state, 'unresolved', `子进程仍在时必须 unresolved，实际 ${c1.state}`);
    const unconfirmed = c1.manifest.filter((m) => m.confirmed === false);
    assert.ok(unconfirmed.some((m) => m.kind === 'process'), '清单应显示未证实的进程资源');

    // 真实杀掉子进程 → 再取消 → confirmed_stopped
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const c2 = h.broker.cancel(h.eng.engagement_id, ex.task_id, 'test');
    assert.equal(c2.state, 'confirmed_stopped');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('端口资源：监听未关 → unresolved；关掉端口 → confirmed_stopped', async () => {
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const h = harness();
  const ex = h.broker.execute({
    ...h.base, command_id: 'pp-2',
    contract: h.contract({ resources: [{ kind: 'port', id: 'listener', port }] }),
  });
  const c1 = h.broker.cancel(h.eng.engagement_id, ex.task_id, 'test');
  assert.equal(c1.state, 'unresolved', '端口仍在监听时必须 unresolved');

  await new Promise((r) => server.close(r));
  const c2 = h.broker.cancel(h.eng.engagement_id, ex.task_id, 'test');
  assert.equal(c2.state, 'confirmed_stopped');
});

test('reconcile 不会把"进程仍在"判成完成', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const h = harness({ faults: { loseResponse: true } });
    const ex = h.broker.execute({
      ...h.base, command_id: 'pp-3',
      contract: h.contract({ resources: [{ kind: 'process', id: 'sleep-child-2', pid: child.pid }] }),
    });
    assert.equal(ex.state, 'unknown');
    // 执行层已结束会话，但进程仍活着（"主会话已停、子进程仍在"的真实形态）
    h.adapter.cancel(ex.task_id, 'executor-side-stop');
    const rec = h.broker.reconcile(h.eng.engagement_id, ex.task_id);
    assert.equal(rec.state, 'unresolved', `进程仍在时 reconcile 应维持 unresolved，实际 ${rec.state}`);

    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const rec2 = h.broker.reconcile(h.eng.engagement_id, ex.task_id);
    assert.ok(['done', 'partial'].includes(rec2.state), `进程已停后应可定论，实际 ${rec2.state}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
