#!/usr/bin/env node
// 自审闸（CI 第五闸）：把人工 review 的机械部分固化成可复跑检查。
// 检查项：
//   ① 秘密扫描（known patterns + 私钥块）
//   ② 文档相对链接可达（README/docs 内）
//   ③ 验收对照表引用的测试文件存在
//   ④ 代码卫生：src 内无 console.log、测试内无 .only/it.skip、无未标注来源的 TODO
//   ⑤ 断言 CI 覆盖四闸（package.json scripts.ci 含四个脚本）
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const IGNORE_DIRS = new Set(['node_modules', '.git', '.warroom', 'backups']);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(repoRoot).map((p) => relative(repoRoot, p));

// ① 秘密扫描
// 文档示例值（AWS/GitHub/OpenAI 官方示例串与测试夹具）：允许出现在 test/ 下，但必须在
// 同一文件里带 `synthetic-example` 标记——避免把"测试夹具"当成"真凭据"放过。
const SYNTHETIC_VALUES = new Set([
  'AKIAIOSFODNN7EXAMPLE',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWX',
  'sk-abcdefghijklmnopqrstuvwxyz012345',
]);
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥块'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'OpenAI 风格 key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS AKID'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
];
for (const f of files) {
  if (f === 'scripts/self-review.mjs' || f === 'packages/warroom-core/src/redactor.js') continue; // 规则定义自身
  if (!/\.(js|mjs|json|md|yml|yaml)$/.test(f)) continue;
  const text = readFileSync(join(repoRoot, f), 'utf8');
  const isTest = f.startsWith('test/');
  const marked = text.includes('synthetic-example');
  for (const [re, label] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const isSynthetic = isTest && marked && [...SYNTHETIC_VALUES].some((v) => text.includes(v));
    if (isSynthetic) notes.push(`合成示例（已标记）：${f} · ${label}`);
    else problems.push(`[secrets] ${f} 命中 ${label}`);
  }
}

// ② 文档相对链接可达
for (const f of files.filter((x) => x.endsWith('.md'))) {
  const text = readFileSync(join(repoRoot, f), 'utf8');
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
  for (const link of links) {
    if (/^(https?:|mailto:)/.test(link)) continue;
    const target = resolve(repoRoot, dirname(f), link);
    if (!existsSync(target)) problems.push(`[link] ${f} → ${link} 不可达`);
  }
}

// ③ 验收表引用的测试文件存在
if (existsSync(join(repoRoot, 'docs/ACCEPTANCE.md'))) {
  const text = readFileSync(join(repoRoot, 'docs/ACCEPTANCE.md'), 'utf8');
  const refs = [...text.matchAll(/`((?:test|scripts|packages)\/[A-Za-z0-9_\-./]+)`/g)].map((m) => m[1]);
  for (const r of [...new Set(refs)]) {
    if (!existsSync(join(repoRoot, r))) problems.push(`[acceptance] 引用了不存在的路径：${r}`);
  }
  notes.push(`验收表引用路径 ${new Set(refs).size} 个，全部存在`);
}

// ④ 代码卫生
for (const f of files) {
  if (!/\.(js|mjs)$/.test(f)) continue;
  const text = readFileSync(join(repoRoot, f), 'utf8');
  if (f === 'scripts/self-review.mjs') continue; // 规则定义自身（含规则字面量）
  const isSrc = f.startsWith('packages/') && f.includes('/src/');
  const isTest = f.startsWith('test/');
  if (isSrc && /console\.log\(/.test(text)) problems.push(`[hygiene] ${f} 在 src 中使用 console.log（应用脚本/CLI 输出）`);
  if (isTest && /\.(only)\(/.test(text)) problems.push(`[hygiene] ${f} 含 .only（会跳过其它测试）`);
  if (isTest && /\bit\.skip\(|test\.skip\(/.test(text)) problems.push(`[hygiene] ${f} 含 skip（不允许静默跳过）`);
  const todoRe = new RegExp('TO' + 'DO' + '(?!\\(|:)', 'g');
  for (const _ of text.matchAll(todoRe)) {
    problems.push(`[hygiene] ${f} 存在未标注来源的 ` + 'TO' + 'DO（应写 ' + 'TO' + 'DO(owner/issue):）');
  }
}

// ⑤ CI 覆盖四闸
try {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const ci = pkg.scripts?.ci ?? '';
  for (const s of ['node --test', 'validate-tool-schemas', 'check-preset', 'fault-matrix']) {
    if (!ci.includes(s)) problems.push(`[ci] scripts.ci 缺少：${s}`);
  }
} catch (e) {
  problems.push(`[ci] 无法读取 package.json：${e.message}`);
}

if (problems.length === 0) {
  console.log(`[✓] 自审通过（文件 ${files.length}，链接可达，验收引用存在，卫生检查通过）`);
} else {
  console.error(`[✗] 自审发现 ${problems.length} 项：`);
  for (const p of problems) console.error(`    - ${p}`);
  process.exitCode = 1;
}
for (const n of notes) console.log(`[i] ${n}`);
