// 预设剪除：计划、幂等、注释条目、回滚安全性（全部纯函数可测；不对真实环境写入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customPresetDirs, commentEntry, appendDisableOverrides, plan } from '../scripts/dsh-prune-presets.mjs';

test('自定义预设目录：除 node_modules 与白名单外全部命中', () => {
  const got = customPresetDirs(['node_modules', 'standard', 'warroom-gungnir', 'redteam', 'liangshen-commander']);
  assert.deepEqual(got, ['liangshen-commander', 'redteam']);
});

test('注释条目：整段注释含缩进子行，且不动相邻条目', () => {
  const text = [
    '- insert:',
    '    - id: local-presets-compat',
    '      name: /x/register-local-presets.mjs',
    '',
    '- insert:',
    '    - id: preset-warroom-gungnir',
    '      name: "@deepseek-ai/dsh-agent-preset"',
  ].join('\n');
  const r = commentEntry(text, 'local-presets-compat');
  assert.equal(r.commented, true);
  assert.match(r.text, /# \[pruned\]\s+- id: local-presets-compat/);
  assert.match(r.text, /# \[pruned\]\s+name: \/x\/register-local-presets\.mjs/);
  assert.match(r.text, /^- insert:\n {4}- id: preset-warroom-gungnir/m, '邻居必须原样保留');
  assert.equal(commentEntry(text, 'nope').commented, false);

  // 唯一子项被剪 → 父 `- insert:` 必须一起注释（否则 DSH 报 "id is required for non-insert patches"）
  const onlyChild = ['- insert:', '    - id: local-presets-compat', '      name: /x.mjs', '', '- id: storage-domain', '  config: {}'].join('\n');
  const r2 = commentEntry(onlyChild, 'local-presets-compat');
  assert.equal(r2.parentCommented, true);
  assert.match(r2.text, /# \[pruned\] - insert:/);
  assert.match(r2.text, /^- id: storage-domain/m, '相邻顶层条目不得被动');

  // 还有其它子项 → 父行保留
  const twoChildren = ['- insert:', '    - id: a', '      name: /a.mjs', '    - id: local-presets-compat', '      name: /x.mjs'].join('\n');
  const r3 = commentEntry(twoChildren, 'local-presets-compat');
  assert.equal(r3.parentCommented, false);
  assert.match(r3.text, /^- insert:\n {4}- id: a/m);
});

test('追加 disabled 覆盖：幂等，且不重复写入', () => {
  const first = appendDisableOverrides('- id: a\n  disabled: true\n', ['liangshen', 'pentest-preset-root']);
  assert.deepEqual(first.added, ['liangshen', 'pentest-preset-root']);
  assert.match(first.text, /- id: liangshen\n {2}disabled: true/);
  const second = appendDisableOverrides(first.text, ['liangshen']);
  assert.deepEqual(second.added, [], '已存在则不再追加');
  assert.equal(second.text, first.text);
});

test('计划以**装配树**判定行是否存在（bundle 行不在 profile patch 里）', () => {
  const patchText = '- insert:\n    - id: local-presets-compat\n      name: /x.mjs\n';
  // 只看 patch：bundle 行会被误判 absent（这正是差点漏掉的坑）
  const naive = plan({ patchText, dirs: ['liangshen'], composedIds: new Set(['local-presets-compat']) });
  assert.equal(naive.find((a) => a.id === 'liangshen').action, 'absent');

  const composed = new Set(['local-presets-compat', 'liangshen', 'pentest-preset-root', 'dsh-purge-redteam']);
  const real = plan({ patchText, dirs: ['liangshen', 'redteam', 'node_modules'], composedIds: composed });
  assert.equal(real.find((a) => a.id === 'local-presets-compat').action, 'comment-out');
  assert.equal(real.find((a) => a.id === 'liangshen').action, 'add-disable-override');
  assert.equal(real.find((a) => a.id === 'dsh-purge-redteam').action, 'add-disable-override');
  assert.equal(real.filter((a) => a.action === 'quarantine-dir').length, 2);
  assert.equal(real.some((a) => a.id === 'node_modules'), false, 'node_modules 链接不得被动');
});

test('已禁用过的行报 already-disabled（重复 apply 无副作用）', () => {
  const patchText = '- id: liangshen\n  disabled: true\n';
  const a = plan({ patchText, dirs: [], composedIds: new Set(['liangshen']) });
  assert.equal(a.find((x) => x.id === 'liangshen').action, 'already-disabled');
});

test('白名单含红队指挥与出厂四项（不许手滑删掉自己）', () => {
  const a = plan({ patchText: '', dirs: [], composedIds: new Set() });
  assert.equal(a.some((x) => x.action === 'quarantine-dir'), false);
  // 反向：warroom-gungnir 目录若出现，也不该被隔离
  const dirs = ['warroom-gungnir', 'standard', 'redteam'];
  assert.deepEqual(customPresetDirs(dirs), ['redteam']);
});
