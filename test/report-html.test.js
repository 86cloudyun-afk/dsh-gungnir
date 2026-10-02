// HTML 报告：自包含单文件、离线可读、无外部资源；受众视图各自成文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { harness } from '../packages/warroom-core/src/testing.js';
import { markdownToHtml, renderHtml } from '../packages/warroom-core/src/html.js';

test('markdown 子集转换：标题/列表/表格/引用/代码块', () => {
  const html = markdownToHtml([
    '# 标题一', '', '## 标题二', '', '- 项目 A', '  - 子项 A1', '- 项目 B', '',
    '| 列1 | 列2 |', '|---|---|', '| a | b |', '',
    '> 引用行', '', '```js', 'const x = 1;', '```', '',
  ].join('\n'));
  assert.match(html, /<h1>标题一<\/h1>/);
  assert.match(html, /<h2>标题二<\/h2>/);
  assert.match(html, /<ul><li>项目 A<ul><li>子项 A1<\/li><\/ul><\/li><li>项目 B<\/li><\/ul>/);
  assert.match(html, /<table><thead><tr><th>列1<\/th>/);
  assert.match(html, /<blockquote>引用行<\/blockquote>/);
  assert.match(html, /<code class="lang-js">const x = 1;<\/code>/);
});

test('HTML 转义：内容里的尖括号与引号不破坏结构', () => {
  const html = markdownToHtml('- <script>alert(1)</script> 与 "引号"');
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('mermaid 双份：可渲染块 + 离线源码', () => {
  const html = markdownToHtml('```mermaid\nflowchart LR\n  a --> b\n```');
  assert.match(html, /<pre class="mermaid">flowchart LR/);
  assert.match(html, /<details class="mermaid-source">/);
});

test('自包含：不引任何外部资源；导出 html 文件存在且含关键段', () => {
  const h = harness();
  const ex = h.broker.execute({ ...h.base, command_id: 'html-1', contract: h.contract() });
  h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  const r = h.broker.exportReport(h.eng.engagement_id, { format: 'html' });
  assert.ok(r.paths.html && existsSync(r.paths.html));
  const html = readFileSync(r.paths.html, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /水位（复现锚点）/);
  assert.match(html, /自校验（导出时即时复核）/);
  assert.equal(/https?:\/\//.test(html.replace(/https:\/\/github\.com[^"']*/g, '')), false,
    'HTML 不应引外部资源（GitHub 链接是文本，不是资源）');
  assert.equal(/<link[^>]+href|<script[^>]+src/.test(html), false, '不得有外部 link/script 引用');
});

test('format=all 同时产出 md/json/html；受众视图文件名带受众', () => {
  const h = harness();
  const all = h.broker.exportReport(h.eng.engagement_id, { format: 'all' });
  assert.ok(all.paths.markdown && all.paths.json && all.paths.html);
  const client = h.broker.exportReport(h.eng.engagement_id, { format: 'html', audience: 'client' });
  assert.match(client.paths.html, /-client\.html$/);
  const html = readFileSync(client.paths.html, 'utf8');
  assert.match(html, /客户版/);
  assert.equal(html.includes('## 审计摘要') || html.includes('审计摘要（门闸判定分布）'), false);
});

test('renderHtml 标题可定制且转义', () => {
  const html = renderHtml({ markdown: '# x', title: 'A & B <报告>' });
  assert.match(html, /<title>A &amp; B &lt;报告&gt;<\/title>/);
});
