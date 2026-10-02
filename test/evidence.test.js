// 证据落盘：三段式索引 + 水位留档 + 明文永不落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { harness } from '../packages/warroom-core/src/testing.js';

const SECRET = 'evidence-plain-2026-xyz';

test('导出目录：报告/JSON/水位/三段式索引齐全', () => {
  const h = harness();
  const { secret_ref } = h.broker.secrets.put(SECRET, { label: 'ssh-pw' });
  const ex = h.broker.execute({
    ...h.base, command_id: 'ev-1',
    contract: h.contract({
      fake_members: [
        { entity_type: 'asset', source_id: 'a-ev', revision_no: 1, content_hash: 'h1', payload: { ip: '10.0.0.5' } },
        { entity_type: 'credential', source_id: 'c-ev', revision_no: 1, content_hash: 'h2', payload: { label: 'ssh-pw', password: SECRET } },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r = h.broker.exportEvidence(h.eng.engagement_id, { outDir: join(h.home, 'evid'), target: '10.0.0.5' });
  assert.ok(existsSync(r.files.markdown) && existsSync(r.files.json) && existsSync(r.files.index) && existsSync(r.files.watermark));
  assert.ok(r.dir.endsWith('10.0.0.5'), 'target 应成为子目录');

  const index = readFileSync(r.files.index, 'utf8');
  assert.match(index, /## Confirmed/);
  assert.match(index, /## Leaked credentials（仅引用，无明文）/);
  assert.match(index, /## Raw artifacts/);
  assert.match(index, /verify-report/);
  assert.equal(index.includes(SECRET), false, '索引不得含明文');
  assert.ok(secret_ref);

  const wm = JSON.parse(readFileSync(r.files.watermark, 'utf8'));
  assert.equal(wm.watermark.seq, r.watermark.seq);
  assert.ok(wm.index_digest.length === 64);

  // 报告文件同样脱敏
  const md = readFileSync(r.files.markdown, 'utf8');
  assert.equal(md.includes(SECRET), false);
  assert.equal(r.counts.facts, 2);
});

test('CLI evidence 子命令可用', () => {
  const h = harness();
  const out = execFileSync('node', ['bin/warroom.mjs', 'evidence', '--engagement', h.eng.engagement_id,
    '--home', h.home, '--out', join(h.home, 'cli-evid'), '--json'],
  { encoding: 'utf8', env: { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' } });
  const parsed = JSON.parse(out);
  assert.ok(existsSync(parsed.files.index));
});
