// 执行器插件接口：--executor 挂载、异步 run、未配置 fail-closed、失败不写假回执。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESPONDER = 'scripts/dsh-bridge-responder.mjs';

function runResponder(root, extra = [], env = {}) {
  return spawnSync('node', [RESPONDER, '--root', root, '--once', ...extra],
    { encoding: 'utf8', env: { ...process.env, ...env } });
}

function writeJob(root, id, extra = {}) {
  mkdirSync(join(root, 'outbox'), { recursive: true });
  writeFileSync(join(root, 'outbox', `${id}.job.json`), JSON.stringify({
    protocol: 'gungnir-bridge/1', external_id: id, role: 'recon',
    contract: { resources: [], fake_members: [], ...extra },
  }));
}

test('内置 echo 执行器：单次跑生成回执', () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-exec-echo-'));
  writeJob(root, 'e1');
  const r = runResponder(root, ['--executor', 'executors/echo-executor.mjs']);
  assert.equal(r.status, 0, r.stderr);
  const facts = JSON.parse(readFileSync(join(root, 'inbox', 'e1.facts.json'), 'utf8'));
  assert.deepEqual(facts.members, []);
  const probes = JSON.parse(readFileSync(join(root, 'inbox', 'e1.probes.json'), 'utf8'));
  assert.ok(Array.isArray(probes.resources));
});

test('自定义执行器插件（临时模块）产出事实与资源', () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-exec-custom-'));
  const modPath = join(root, 'my-exec.mjs');
  writeFileSync(modPath, `
export default {
  name: 'test-exec',
  async run(job) {
    return {
      members: [{ entity_type: 'vuln', source_id: job.external_id + '-v', revision_no: 1,
                  content_hash: 'h', payload: { note: '来自自定义执行器' } }],
      resources: [{ id: job.external_id + '-port', kind: 'port', port: 1, stopped: true }],
    };
  },
};
`);
  writeJob(root, 'c1');
  const r = runResponder(root, ['--executor', modPath]);
  assert.equal(r.status, 0, r.stderr);
  const facts = JSON.parse(readFileSync(join(root, 'inbox', 'c1.facts.json'), 'utf8'));
  assert.equal(facts.members[0].source_id, 'c1-v');
});

test('dsh-redteam 执行器未配置 → 失败且不写假回执（fail-closed）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-exec-failclosed-'));
  writeJob(root, 'f1');
  const r = runResponder(root, ['--executor', 'executors/dsh-redteam-executor.mjs'], { GUNGNIR_EXECUTOR_CMD: '' });
  assert.equal(r.status, 0, '单次模式下错误不致命，但要留痕');
  assert.match(r.stderr + r.stdout, /未配置 GUNGNIR_EXECUTOR_CMD|job-error/);
  // 不变式（比"没有状态文件"更精确）：状态必须显式 failed，且**绝不写事实**
  const st = JSON.parse(readFileSync(join(root, 'inbox', 'f1.status.json'), 'utf8'));
  assert.equal(st.state, 'failed', '必须显式落 failed，而不是静默');
  assert.notEqual(st.state, 'done');
  assert.equal(existsSync(join(root, 'inbox', 'f1.facts.json')), false, '不得写事实（不假装成功）');
});

test('dsh-redteam 执行器按 env 命令调用外部执行器（含 stdin job）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-exec-cmd-'));
  const helper = join(root, 'helper.mjs');
  writeFileSync(helper, `
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const job = JSON.parse(buf);
  process.stdout.write(JSON.stringify({
    members: [{ entity_type: 'asset', source_id: job.external_id + '-a', revision_no: 1, content_hash: 'h', payload: {} }],
    resources: [],
  }));
});
`);
  writeJob(root, 'h1');
  const r = runResponder(root, ['--executor', 'executors/dsh-redteam-executor.mjs'],
    { GUNGNIR_EXECUTOR_CMD: `node ${helper}` });
  assert.equal(r.status, 0, r.stderr);
  const facts = JSON.parse(readFileSync(join(root, 'inbox', 'h1.facts.json'), 'utf8'));
  assert.equal(facts.members[0].source_id, 'h1-a');
});
