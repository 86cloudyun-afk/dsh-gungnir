// 应答器：先确认后异步执行（长任务不被 2s 桥超时打断）+ 失败不写事实
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


test('长任务不被桥超时打断：先写 running 确认，再异步执行并写 done', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-responder-slow-'));
  const root = join(home, 'dsh-bridge');
  // 假执行器：睡 2.5 秒后返回事实（远超桥默认 2s 等待）
  const ex = join(home, 'slow-executor.mjs');
  writeFileSync(ex, `
export default { name: 'slow', async run(job) {
  await new Promise((r) => setTimeout(r, 2500));
  return { generation: job.contract.generation, members: [{ entity_type: 'asset', source_id: 'slow-1', revision_no: 1, content_hash: 'h', payload: {} }], resources: [{ id: 'slow-1', kind: 'process', stopped: true }] };
} };
`);
  const { spawn } = await import('node:child_process');
  const child = spawn('node', ['scripts/dsh-bridge-responder.mjs', '--root', root, '--executor', ex, '--interval', '50'],
    { cwd: process.cwd(), stdio: 'ignore' });
  try {
    // 派单
    const outbox = join(root, 'outbox');
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'job-slow.job.json'), JSON.stringify({ protocol: 'gungnir-bridge/1', external_id: 'job-slow', role: 'recon', contract: { generation: '1:1:1', targets: ['t.example'] } }));
    // 1 秒内应已有 running 状态（= 派单不会被 2s 桥超时判为丢失）
    await new Promise((r) => setTimeout(r, 1000));
    const running = JSON.parse(readFileSync(join(root, 'inbox', 'job-slow.status.json'), 'utf8'));
    assert.equal(running.state, 'running', '必须先确认 running，不能等工具跑完');
    assert.equal(existsSync(join(root, 'inbox', 'job-slow.facts.json')), false, '此时还没有事实（工具未完成）');

    // 等工具完成 → facts + done
    await new Promise((r) => setTimeout(r, 3000));
    const done = JSON.parse(readFileSync(join(root, 'inbox', 'job-slow.status.json'), 'utf8'));
    assert.equal(done.state, 'done');
    const facts = JSON.parse(readFileSync(join(root, 'inbox', 'job-slow.facts.json'), 'utf8'));
    assert.equal(facts.members.length, 1);
  } finally {
    child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
});

test('执行器失败 → unknown 且不写 facts（保留可能已执行的领取记录）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-responder-fail-'));
  const root = join(home, 'dsh-bridge');
  const ex = join(home, 'bad-executor.mjs');
  writeFileSync(ex, `export default { name: 'bad', async run() { throw new Error('工具挂了'); } };`);
  const { spawn } = await import('node:child_process');
  const child = spawn('node', ['scripts/dsh-bridge-responder.mjs', '--root', root, '--executor', ex, '--interval', '50'],
    { cwd: process.cwd(), stdio: 'ignore' });
  try {
    mkdirSync(join(root, 'outbox'), { recursive: true });
    writeFileSync(join(root, 'outbox', 'job-bad.job.json'), JSON.stringify({ protocol: 'gungnir-bridge/1', external_id: 'job-bad', role: 'assess', contract: { generation: '1:1:1', targets: ['t.example'] } }));
    await new Promise((r) => setTimeout(r, 1500));
    const st = JSON.parse(readFileSync(join(root, 'inbox', 'job-bad.status.json'), 'utf8'));
    assert.equal(st.state, 'unknown');
    assert.equal(existsSync(join(root, 'claims', 'job-bad.json')), true);
    assert.equal(existsSync(join(root, 'inbox', 'job-bad.facts.json')), false, '失败不得写事实');
  } finally {
    child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
});
