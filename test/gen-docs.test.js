// 工具文档生成与同步校验（防文档漂移）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { TOOLS } from '../packages/warroom-tools/src/index.js';

const run = (flag) => execFileSync('node', ['scripts/gen-docs.mjs', flag], { encoding: 'utf8' });

test('docs/TOOLS.md 与代码同步（--check 通过）', () => {
  const out = run('--check');
  assert.match(out, /同步（24 个工具）|工具文档与 schema 导出同步/);
});

test('生成内容覆盖全部工具与约定', () => {
  const text = readFileSync('docs/TOOLS.md', 'utf8');
  for (const t of TOOLS) assert.ok(text.includes(`\`${t.name}\``), `缺少 ${t.name}`);
  assert.match(text, /自动生成，勿手改/);
  assert.match(text, /新增工具必须/);
});

test('漂移会被检出（写入后 --check 必须失败）', () => {
  const bak = 'docs/TOOLS.md.bak-test';
  copyFileSync('docs/TOOLS.md', bak);
  try {
    writeFileSync('docs/TOOLS.md', readFileSync('docs/TOOLS.md', 'utf8') + '\n漂移内容\n');
    let failed = false;
    try { run('--check'); } catch (e) { failed = true; assert.match(String(e.stderr), /不一致/); }
    assert.equal(failed, true, '文档被改动后 --check 必须失败');
  } finally {
    copyFileSync(bak, 'docs/TOOLS.md');
    unlinkSync(bak);
  }
  assert.ok(existsSync('docs/TOOLS.md'));
});

test('机器可读 schema 导出：结构与同步校验', () => {
  const raw = readFileSync('docs/tools.schema.json', 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema, 'gungnir-tools/1');
  assert.equal(parsed.tools.length, TOOLS.length);
  assert.ok(parsed.tools.every((t) => t.name && t.input_schema && typeof t.in_allowlist === 'boolean'));
  assert.equal(parsed.preset.allowlist_mode, 'allowlist');

  // 漂移检出：写入后 --check 必须失败
  const bak = 'docs/tools.schema.json.bak-test';
  copyFileSync('docs/tools.schema.json', bak);
  try {
    writeFileSync('docs/tools.schema.json', raw.replace('gungnir-tools/1', 'gungnir-tools/0'));
    let failed = false;
    try { run('--check'); } catch (e) { failed = true; assert.match(String(e.stderr), /tools\.schema\.json/); }
    assert.equal(failed, true);
  } finally {
    copyFileSync(bak, 'docs/tools.schema.json');
    unlinkSync(bak);
  }
});

test('看板契约导出：七个视图字段齐备，且与实时输出一致（漂移即失败）', async () => {
  const raw = readFileSync('docs/dashboards.schema.json', 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema, 'gungnir-dashboards/1');
  for (const view of ['watch', 'fleet', 'weekly', 'rate', 'checklist', 'timeline', 'report']) {
    assert.ok(Array.isArray(parsed.views[view]) && parsed.views[view].length > 5, `${view} 字段太少`);
  }
  assert.ok(parsed.views.watch.includes('tasks.in_flight[].task_id'), '在飞任务字段应在契约里');
  assert.ok(parsed.views.watch.includes('tasks.in_flight[].overdue'));
  assert.ok(parsed.views.fleet.includes('totals.with_issues'));
  assert.ok(parsed.views.report.some((f) => f.startsWith('watermark.')));
  assert.ok(parsed.views.checklist.includes('deliverable'));

  // 与实时输出对比：抽样校验字段确实存在
  const { harness } = await import('../packages/warroom-core/src/testing.js');
  const h = harness();
  const watch = h.broker.watch(h.eng.engagement_id);
  assert.ok(parsed.views.watch.includes('warnings'), '告警数组字段应在契约里');
  assert.equal(Array.isArray(watch.warnings), true);
});

test('看板契约漂移会被 docs 闸检出（改字段后不重跑生成器即失败）', () => {
  const bak = 'docs/dashboards.schema.json.bak-test';
  copyFileSync('docs/dashboards.schema.json', bak);
  try {
    writeFileSync('docs/dashboards.schema.json', '{"schema":"gungnir-dashboards/0","views":{}}');
    let failed = false;
    try { run('--check'); } catch (e) { failed = true; assert.match(String(e.stderr), /dashboards\.schema\.json/); }
    assert.equal(failed, true);
  } finally {
    copyFileSync(bak, 'docs/dashboards.schema.json');
    unlinkSync(bak);
  }
});

test('故障矩阵文档：21 行且与场景清单一致（漂移即失败）', () => {
  const md = readFileSync('docs/FAULT-MATRIX.md', 'utf8');
  assert.match(md, /# 故障矩阵（21 场景）/);
  const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l));
  assert.equal(rows.length, 21);
  assert.ok(rows.every((r) => r.split('|').length >= 5), '每行应有 #/场景/期望/契约 四列');
  assert.match(rows[0], /ADR-002/);

  const bak = 'docs/FAULT-MATRIX.md.bak-test';
  copyFileSync('docs/FAULT-MATRIX.md', bak);
  try {
    writeFileSync('docs/FAULT-MATRIX.md', '# 故障矩阵（1 场景）\n');
    let failed = false;
    try { run('--check'); } catch (e) { failed = true; assert.match(String(e.stderr), /FAULT-MATRIX\.md/); }
    assert.equal(failed, true);
  } finally {
    copyFileSync(bak, 'docs/FAULT-MATRIX.md');
    unlinkSync(bak);
  }
});
