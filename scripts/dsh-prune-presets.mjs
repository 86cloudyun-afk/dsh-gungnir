#!/usr/bin/env node
// 剪除 DSH 里的自定义预设，只保留白名单（默认：出厂 4 个 + 红队指挥 GUNGNIR）。
//
// 为什么用脚本而不是手改：profile patch 是全局单文件，且"模式下拉"的来源有三处——
// 出厂 bundle、各插件自带 cordis.patch.yml、用户 patch 行。手工改一处必然漏另一处。
// 本脚本：
//   1) 注释掉注册自定义预设的用户 patch 行（local-presets-compat → 3 个旧预设）；
//   2) 对由 bundle 提供的注册行追加 `disabled: true` 覆盖（liangshen / pentest-preset-root /
//      dsh-purge-redteam 及其 store/ui —— 后两者 inject 同一个服务，必须一起停）；
//   3) 把预设源目录移进隔离区（**不动** node_modules 链接）；
//   4) 写 manifest，`--restore` 完全回滚（取消注释 + 去覆盖 + 移回目录）。
//
// 判定"行是否存在"必须看**装配树**（dsh --dump-config），不能只看 profile patch：
// bundle 提供的行不在 patch 文本里，只看文本会把它们误判为"不存在"而漏剪。
//
// 用法：
//   node scripts/dsh-prune-presets.mjs --check     # 只读计划（默认）
//   node scripts/dsh-prune-presets.mjs --apply     # 执行（备份 + manifest）
//   node scripts/dsh-prune-presets.mjs --restore   # 按最近一份 manifest 回滚
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

export const KEEP_DEFAULT = Object.freeze(['standard', 'ptc', 'minimal', 'cordis', 'warroom-gungnir']);

/**
 * 已知会往"模式下拉"注册预设的来源。
 * comment_out=true：该行在用户 patch 里，整段注释即可；
 * comment_out=false：该行由 bundle 提供，只能追加 `disabled: true` 覆盖。
 */
export const REGISTRATION_SOURCES = Object.freeze([
  { id: 'local-presets-compat', preset: '(3 个旧预设)', comment_out: true, note: 'pentest-commander / opsec-commander / liangshen-commander（用户 patch 行）' },
  { id: 'liangshen', preset: 'liangshen', comment_out: false, note: '梁神模式（bundle 行）' },
  { id: 'pentest-preset-root', preset: 'pentest', comment_out: false, note: '渗透模式（bundle 行）' },
  { id: 'dsh-purge-redteam', preset: 'redteam', comment_out: false, note: '演练台（bundle 行；同时 provide redteamMode 服务）' },
  { id: 'dsh-purge-redteam-store', preset: null, comment_out: false, note: '演练台 store（依赖上面的服务，需同停）' },
  { id: 'dsh-purge-redteam-ui', preset: null, comment_out: false, note: '演练台 UI（同停）' },
]);

/** 预设源目录里，除 node_modules 与白名单之外的自定义模式目录。 */
export function customPresetDirs(dirs, keep = KEEP_DEFAULT) {
  return dirs.filter((d) => d !== 'node_modules' && !keep.includes(d)).sort();
}

/** 追加 `- id: x / disabled: true` 覆盖；已存在则跳过（幂等）。 */
export function appendDisableOverrides(text, ids) {
  const missing = ids.filter((id) => !new RegExp(`^- id: ${id}\\s*$`, 'm').test(text));
  if (missing.length === 0) return { text, added: [] };
  const block = ['# 预设剪除（dsh-prune-presets）', ...missing.flatMap((id) => [`- id: ${id}`, '  disabled: true'])].join('\n');
  return { text: `${text.trimEnd()}\n\n${block}\n`, added: missing };
}

/**
 * 把一个 `- id: <rowId>` 条目（含其缩进子行）整段注释掉，不影响相邻条目。
 * 若它所在的顶层 `- insert:` 块**再无其它子条目**，连父行一起注释——
 * 否则会留下悬空 `- insert:`，DSH 启动时报 `patch: id is required for non-insert patches`
 * （真机踩过：注释掉唯一子项后，父行成了空 insert）。
 */
export function commentEntry(text, rowId) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(\\s*)- id: ${rowId}\\s*$`).test(l));
  if (start === -1) return { text, commented: false };
  const indent = /^(\s*)/.exec(lines[start])[1].length;

  // 所属顶层 insert 块的范围（父行在 indent 更小的位置）
  let blockStart = -1;
  for (let i = start - 1; i >= 0; i -= 1) {
    if (/^- insert:\s*$/.test(lines[i])) { blockStart = i; break; }
    if (/^-\s/.test(lines[i])) break;
  }
  let end = start + 1;
  while (end < lines.length) {
    const m = /^(\s*)- /.exec(lines[end]);
    if (m && m[1].length <= indent) break;
    end += 1;
  }
  for (let i = start; i < end; i += 1) lines[i] = `# [pruned] ${lines[i]}`;

  let parentCommented = false;
  if (blockStart !== -1) {
    let blockEnd = blockStart + 1;
    while (blockEnd < lines.length && !/^\S/.test(lines[blockEnd])) blockEnd += 1;
    const survivors = lines.slice(blockStart + 1, blockEnd).filter((l) => /^\s*- /.test(l));
    if (survivors.length === 0) { lines[blockStart] = `# [pruned] ${lines[blockStart]}`; parentCommented = true; }
  }
  return { text: lines.join('\n'), commented: true, parentCommented };
}

/** 已装配的行 id 集合（profile patch 文本 ∪ `dsh --dump-config` 的装配树）。 */
export function composedRowIds(profile, patchText = '', runDsh = null) {
  const ids = new Set(patchText.split('\n')
    .map((l) => /^- id: (.+?)\s*$/.exec(l)?.[1])
    .filter(Boolean));
  const out = runDsh ? runDsh() : (spawnSync('dsh', ['--profile', profile, '--dump-config'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '');
  for (const line of String(out).split('\n')) {
    const m = /^- id: (.+?)\s*$/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** 只读计划：每个来源一条动作 + 每个待隔离目录一条。 */
export function plan({ patchText = '', dirs = [], comprisedIds = null, composedIds = comprisedIds, keep = KEEP_DEFAULT }) {
  const actions = [];
  for (const src of REGISTRATION_SOURCES) {
    const present = composedIds ? composedIds.has(src.id) : new RegExp(`^- id: ${src.id}\\s*$`, 'm').test(patchText);
    if (!present) { actions.push({ id: src.id, preset: src.preset, action: 'absent', note: src.note }); continue; }
    const disabled = new RegExp(`^- id: ${src.id}\\n\\s+disabled: true\\s*$`, 'm').test(patchText);
    actions.push({
      id: src.id, preset: src.preset, note: src.note,
      action: disabled ? 'already-disabled' : (src.comment_out ? 'comment-out' : 'add-disable-override'),
    });
  }
  for (const d of customPresetDirs(dirs, keep)) {
    actions.push({ id: d, preset: d, action: 'quarantine-dir', note: '预设源目录' });
  }
  return actions;
}

export function main(argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean' }, apply: { type: 'boolean' }, restore: { type: 'boolean' },
      home: { type: 'string' }, profile: { type: 'string' }, json: { type: 'boolean', default: false },
    },
  });
  const profileName = v.profile ?? process.env.DSH_PROFILE ?? 'web';
  const home = v.home ?? process.env.DSH_HOME ?? null;
  const profileDir = home ? join(home, 'profiles', profileName) : (process.env.DSH_PROFILE_DIR ?? null);
  const patchPath = profileDir ? join(profileDir, 'cordis.patch.yml') : null;
  const presetsRoot = home ? join(home, '.agent-presets') : null;

  if (!home && !profileDir) { console.error('✗ 未指定 --home 或 DSH_HOME'); return 2; }

  const dirs = presetsRoot && existsSync(presetsRoot) ? readdirSync(presetsRoot) : [];
  const patchText = patchPath && existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const actions = plan({ patchText, dirs, composedIds: composedRowIds(profileName, patchText) });

  if (v.restore) {
    const manifests = home && existsSync(home)
      ? readdirSync(home).filter((f) => f.startsWith('.preset-prune-')).sort().reverse()
      : [];
    if (manifests.length === 0) { console.error('✗ 找不到可回滚的 manifest'); return 2; }
    const m = JSON.parse(readFileSync(join(home, manifests[0], 'manifest.json'), 'utf8'));
    for (const item of m.moved) {
      if (existsSync(item.to)) { mkdirSync(dirname(item.from), { recursive: true }); renameSync(item.to, item.from); }
    }
    let text = readFileSync(patchPath, 'utf8');
    for (const id of m.overrides) text = text.replace(new RegExp(`^- id: ${id}\\n  disabled: true\\n?`, 'm'), '');
    text = text.replace(/^# \[pruned\] /gm, '');
    text = text.replace(/\n# 预设剪除（dsh-prune-presets）\n(\n?)/g, '\n');
    copyFileSync(patchPath, `${patchPath}.bak-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    writeFileSync(patchPath, text, 'utf8');
    console.log(`✓ 已按 ${manifests[0]} 回滚（目录 ${m.moved.length} 个，覆盖 ${m.overrides.length} 条）`);
    console.log('· 生效需重启 dsh web');
    return 0;
  }

  if (!v.apply) {
    console.log('模式剪除计划（只读；--apply 执行）：');
    console.log('  preset/行 id'.padEnd(30) + '动作'.padEnd(26) + '说明');
    for (const a of actions) console.log(`  ${a.id.padEnd(28)}${a.action.padEnd(24)}${a.note}`);
    console.log(`\n保留：${KEEP_DEFAULT.join(', ')}`);
    console.log(`patch：${patchPath}\n预设目录：${presetsRoot}`);
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantine = join(home, `.preset-prune-${stamp}`);
  mkdirSync(quarantine, { recursive: true });
  const backup = `${patchPath}.bak-preset-prune-${stamp}`;
  copyFileSync(patchPath, backup);

  let text = patchText;
  const commented = [];
  const overrides = [];
  const pendingOverrides = [];
  for (const src of REGISTRATION_SOURCES) {
    const a = actions.find((x) => x.id === src.id);
    if (!a || a.action === 'absent' || a.action === 'already-disabled') continue;
    if (a.action === 'comment-out') {
      const r = commentEntry(text, src.id);
      if (r.commented) { text = r.text; commented.push(src.id); }
    } else {
      pendingOverrides.push(src.id);
    }
  }
  if (pendingOverrides.length > 0) {
    const r = appendDisableOverrides(text, pendingOverrides);
    text = r.text;
    overrides.push(...r.added);
  }
  const moved = [];
  for (const d of customPresetDirs(dirs)) {
    const from = join(presetsRoot, d);
    const to = join(quarantine, d);
    if (existsSync(from)) { renameSync(from, to); moved.push({ from, to }); }
  }
  writeFileSync(patchPath, text, 'utf8');
  writeFileSync(join(quarantine, 'manifest.json'), JSON.stringify({
    at: new Date().toISOString(), patchPath, backup, keep: KEEP_DEFAULT, commented, overrides, moved,
  }, null, 2), 'utf8');

  if (v.json) {
    console.log(JSON.stringify({ quarantine, commented, overrides, moved: moved.map((x) => basename(x.from)) }, null, 2));
  } else {
    console.log(`✓ patch 已备份：${backup}`);
    console.log(`✓ 注释掉的注册行：${commented.join(', ') || '无'}`);
    console.log(`✓ 追加 disabled 覆盖：${overrides.join(', ') || '无'}`);
    console.log(`✓ 隔离的预设目录（${moved.length}）：${moved.map((x) => basename(x.from)).join(', ') || '无'} → ${quarantine}`);
    console.log('· 生效需重启 dsh web；回滚：node scripts/dsh-prune-presets.mjs --restore');
    console.log(`保留的模式：${KEEP_DEFAULT.join(', ')}`);
  }
  return 0;
}

// 仅在被直接执行时运行 CLI（被 import 时保持纯函数，供测试复用）
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main() ?? 0;
