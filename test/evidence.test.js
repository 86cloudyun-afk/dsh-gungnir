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

test('证据落盘带交付视图：客户版与蓝队版各自归档，索引注明', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'ev-aud', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r = h.broker.exportEvidence(h.eng.engagement_id, { outDir: join(h.home, 'ev-aud') });
  assert.equal(r.audience_files.length, 2);
  const client = r.audience_files.find((a) => a.audience === 'client');
  const blue = r.audience_files.find((a) => a.audience === 'blue');
  assert.ok(existsSync(client.markdown) && existsSync(blue.markdown));
  assert.match(client.markdown, /client/);
  assert.match(blue.markdown, /blue/);

  const index = readFileSync(r.files.index, 'utf8');
  assert.match(index, /## 交付视图/);
  assert.match(index, /客户版（路径\/影响\/修复建议）/);
  assert.match(index, /蓝队版（IOC 排查口径）/);
  assert.match(index, /内部全量/);

  const cmd = readFileSync(client.markdown, 'utf8');
  assert.match(cmd, /视图：\*\*客户版/);
  assert.equal(cmd.includes('## 审计摘要'), false, '客户版文件本身也不含审计明细');
});

test('可指定只导出某一受众；空数组则不生成视图目录', () => {
  const h = harness();
  const only = h.broker.exportEvidence(h.eng.engagement_id, { outDir: join(h.home, 'ev-only'), audiences: ['blue'] });
  assert.equal(only.audience_files.length, 1);
  assert.equal(only.audience_files[0].audience, 'blue');

  const none = h.broker.exportEvidence(h.eng.engagement_id, { outDir: join(h.home, 'ev-none'), audiences: [] });
  assert.equal(none.audience_files.length, 0);
  assert.equal(readFileSync(none.files.index, 'utf8').includes('## 交付视图'), false, '无受众视图时不出该节');
});

test('交付包：证据落盘默认随包生成交付清单并在索引里点名', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'ev-pack', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r = h.broker.exportEvidence(h.eng.engagement_id, { outDir: join(h.home, 'ev-pack') });
  assert.ok(r.files.checklist, '默认应生成交付清单');
  assert.match(r.files.checklist, /DELIVERY_CHECKLIST\.md$/);
  assert.ok(existsSync(r.files.checklist));
  const checklist = readFileSync(r.files.checklist, 'utf8');
  assert.match(checklist, /# 交付清单/);
  assert.match(checklist, /自动判定：\*\*\d+\/\d+\*\* 项通过/);

  const index = readFileSync(r.files.index, 'utf8');
  assert.match(index, /## 交付自检/);
  assert.match(index, /DELIVERY_CHECKLIST\.md/);
});

test('可关闭交付清单（checklist:false）', () => {
  const h = harness();
  const r = h.broker.exportEvidence(h.eng.engagement_id, { outDir: join(h.home, 'ev-nocheck'), checklist: false });
  assert.equal(r.files.checklist, null);
  assert.equal(readFileSync(r.files.index, 'utf8').includes('## 交付自检'), false);
});

test('EVIDENCE_INDEX credential ref redacts vault secrets embedded in source_id', () => {
  // Confirmed 段已对 source_id 走 R；Leaked credentials 的 ref 此前原样插值，
  // 一旦 source_id 嵌入口令就会在「仅引用、无明文」节里泄漏。
  const SECRET = 'EvRef-P@ss-2026-plain';
  const h = harness();
  h.broker.secrets.put(SECRET, { label: 'ev-ref' });
  const ex = h.broker.execute({
    ...h.base,
    command_id: 'ev-ref-1',
    contract: h.contract({
      fake_members: [
        { entity_type: 'asset', source_id: 'a-ev-ref', revision_no: 1, content_hash: 'h1', payload: { ip: '10.0.0.8' } },
        {
          entity_type: 'credential',
          source_id: `ssh-admin-${SECRET}`,
          revision_no: 1,
          content_hash: 'h2',
          payload: { label: 'ssh-admin', service: 'ssh' },
        },
      ],
    }),
  });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));

  const r = h.broker.exportEvidence(h.eng.engagement_id, { outDir: join(h.home, 'ev-ref') });
  const index = readFileSync(r.files.index, 'utf8');
  assert.match(index, /## Leaked credentials（仅引用，无明文）/);
  assert.equal(index.includes(SECRET), false, 'credential ref must not leak vault secret');
  assert.match(index, /\[REDACTED:ev-ref\]/);
  assert.match(index, /引用 `/);
});
