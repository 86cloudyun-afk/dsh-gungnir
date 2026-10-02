// 实装指引里承诺的 stub：配置了派单命令就产出回执，没配置就 fail-closed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB = 'executors/dsh-plugin-cmd.example.mjs';
const job = JSON.stringify({
  protocol: 'gungnir-bridge/1', external_id: 'impl-1', role: 'exploit',
  contract: { targets: ['10.0.0.5'], intent: 'exploit', action_class: 'active' },
});

function runStub(env = {}) {
  return spawnSync('node', [STUB], {
    input: job, encoding: 'utf8',
    env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '', ...env },
  });
}

test('未配置派单命令 → fail-closed（退出码 3，明确说明）', () => {
  const r = runStub({ GUNGNIR_DSH_TOOL_CMD: '' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /未配置 GUNGNIR_DSH_TOOL_CMD/);
  assert.equal(r.stdout.trim(), '', '不得输出假回执');
});

test('配置派单命令 → 占位符替换后调用并转成回执', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-impl-'));
  const helper = join(dir, 'dispatch.mjs');
  const argLog = join(dir, 'args.txt');
  writeFileSync(helper, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argLog)}, process.argv.slice(2).join(' '));
process.stdout.write(JSON.stringify({
  members: [{ entity_type: 'asset', source_id: 'impl-asset', revision_no: 1, content_hash: 'h', payload: {} }],
  resources: [{ id: 'impl-1-session', kind: 'session', stopped: false }],
}));
`);
  const r = runStub({ GUNGNIR_DSH_TOOL_CMD: `node ${helper} --role {role} --targets {targets} --intent {intent} --class {action_class} --id {external_id}` });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.members.length, 1);
  assert.equal(out.resources[0].kind, 'session');
  const args = readFileSync(argLog, 'utf8');
  assert.match(args, /--role exploit/);
  assert.match(args, /--targets 10\.0\.0\.5/);
  assert.match(args, /--intent exploit/);
  assert.match(args, /--class active/);
  assert.match(args, /--id impl-1/);
});

test('派单命令输出非法 JSON → 非零退出（不吞错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-impl2-'));
  const helper = join(dir, 'bad.mjs');
  writeFileSync(helper, `process.stdout.write('not json');`);
  const r = runStub({ GUNGNIR_DSH_TOOL_CMD: `node ${helper}` });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /输出非 JSON/);
  assert.ok(existsSync(helper));
});
