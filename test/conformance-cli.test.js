// 一致性套件独立入口：内置 adapter 全绿；坏 adapter 被逐条指出；CLI 两路可用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (args) => {
  try {
    const out = execFileSync('node', ['scripts/conformance.mjs', ...args],
      { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: e.stdout ?? '' }; }
};

test('内置 fake adapter：套件全绿', () => {
  const r = run(['--json']);
  assert.equal(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.summary.failed.length, 0, JSON.stringify(parsed.summary.failed));
  assert.ok(parsed.summary.total >= 5);
});

test('坏 adapter（缺少 cancel 幂等）被逐条指出且非零退出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-conf-'));
  const modPath = join(dir, 'bad-adapter.mjs');
  writeFileSync(modPath, `
export default class BadAdapter {
  constructor() { this.tasks = new Map(); this.seq = 0; }
  dispatch(job) {
    const id = job.task_id ?? \`bad_\${++this.seq}\`;
    this.tasks.set(id, { task_id: id, state: 'running', session_up: true, manifests: [] });
    return { task_id: id, state: 'running' };
  }
  lookup(id) { const t = this.tasks.get(id); return t ? { task_id: id, state: t.state } : null; }
  status(id) { const t = this.tasks.get(id); return t ? { task_id: id, state: t.state } : null; }
  collect(id) { return { receipt_id: \`r_\${id}\`, generation: '1:1:1', members: [] }; }
  cancel() { throw new Error('not implemented'); }   // 故意不合格
  reconcile() { throw new Error('not implemented'); }
}
`);
  const r = run(['--module', modPath, '--json']);
  assert.notEqual(r.code, 0, '坏 adapter 必须非零退出');
  const parsed = JSON.parse(r.out);
  assert.ok(parsed.summary.failed.length >= 1, JSON.stringify(parsed.summary));
  assert.ok(parsed.results.some((x) => !x.ok));
});

test('CLI warroom conformance 可用', () => {
  const out = execFileSync('node', ['bin/warroom.mjs', 'conformance', '--json'],
    { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
  const parsed = JSON.parse(out);
  assert.equal(parsed.summary.failed.length, 0);
});
