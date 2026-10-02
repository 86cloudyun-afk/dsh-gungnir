#!/usr/bin/env node
// 文档快照计数守卫：从**单一事实源**实测各计数，与 README/ACCEPTANCE/FINAL-AUDIT 里
// committed 的数字逐一比对；对不上就非零退出并打印差异。从根上消除"每合一个 PR 测试数就变、
// 人工逐轮追数字"的漂移（历史上同一事实在不同文档里出现过 391/394、36/11、21/14/11 等不一致）。
//
// 用法：
//   node scripts/check-doc-counts.mjs            # 校验；有不符即退出码 1 并打印差异
//   node scripts/check-doc-counts.mjs --write     # 用实测值回写文档（PR 作者一键刷新；别名 --update）
//   node scripts/check-doc-counts.mjs --json       # 机器可读
//
// 覆盖三项**高频漂移且文案规整、可稳定锚定**的数字事实：
//   · 测试例数   = `node --test` 的 `# tests` 总数（与环境无关：guarded 用例 SKIP 仍计入 # tests）
//   · 工具数     = warroom-tools TOOLS（并交叉校验 plugin TOOL_NAMES 与预设 allow 的 warroom_ 项三者一致）
//   · 故障矩阵   = packages/warroom-core/src/testing/faults.js 的 SCENARIOS 条数
// 锚点：文档里分别写作「N 例」「N 个 `warroom_*`」/「N `warroom_*`」「N 场景」，正则精确匹配、不脆。
//
// **不**纳入自动校验：「真跑 CI job 数」。该事实在文档里用中文数字（「两个/三个真跑 job」）表达，
// 且各处口径不一（README/ACCEPTANCE 数 fence+drill；FINAL-AUDIT 把 test 也算进「三者」），
// 自动解析会脆且易误报。它极少变动，交由人工维护（本次已顺带校正措辞含 native-host）。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write') || args.has('--update');
const JSON_OUT = args.has('--json');

const DOCS = ['README.md', 'docs/ACCEPTANCE.md', 'docs/FINAL-AUDIT.md'];

/** 实测：node --test 的 # tests 总数（权威、环境无关）。 */
function measureTests() {
  const r = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/^# tests (\d+)/m);
  if (!m) throw new Error('无法从 node --test 输出解析 `# tests N`');
  return Number(m[1]);
}

/** 实测：warroom_* 工具数（三源一致才算数，否则是真实不一致，直接报错）。 */
async function measureTools() {
  const { TOOLS } = await import(pathToFileURL(join(root, 'packages/warroom-tools/src/index.js')).href);
  const { TOOL_NAMES } = await import(pathToFileURL(join(root, 'packages/warroom-plugin/src/tools.js')).href);
  const preset = JSON.parse(readFileSync(join(root, 'presets/warroom.preset.json'), 'utf8'));
  const allowW = (preset?.toolPolicy?.allow ?? []).filter((n) => n.startsWith('warroom_'));
  const a = TOOLS.length; const b = TOOL_NAMES.length; const c = allowW.length;
  if (!(a === b && b === c)) {
    throw new Error(`工具数三源不一致：TOOLS=${a}、TOOL_NAMES=${b}、preset.allow(warroom_)=${c}（先修实现再谈文档）`);
  }
  return a;
}

/** 实测：故障矩阵场景数（SCENARIOS 条数）。 */
async function measureFaults() {
  const { SCENARIOS } = await import(pathToFileURL(join(root, 'packages/warroom-core/src/testing/faults.js')).href);
  return SCENARIOS.length;
}

/** 每个事实：度量函数 + 文档锚点正则（捕获组 1 = 数字，始终是匹配里的首个数字串）。 */
async function buildFacts() {
  // 每个事实可有多条锚点正则；约定：事实的数字永远是匹配片段里的**首个数字串**。
  // 工具数有两种文案：「N 个 `warroom_*`」/「N `warroom_*`」与数字快照里的「工具：N 个」。
  // 「工具：N 个」用 `工具…N 个` 定界，避免误伤「16 个批次」这类无关的「N 个」。
  return [
    { key: 'tests', label: '测试例数（node --test # tests）', value: measureTests(),
      patterns: [/\d+\s?例/g] },
    { key: 'tools', label: 'warroom_* 工具数', value: await measureTools(),
      patterns: [/\d+\s?个?\s?`?warroom_/g, /工具[^0-9]{0,4}\d+\s?个/g] },
    { key: 'faults', label: '故障矩阵场景数（SCENARIOS）', value: await measureFaults(),
      patterns: [/\d+\s?场景/g] },
  ];
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const facts = await buildFacts();
const mismatches = [];
const writes = [];

for (const rel of DOCS) {
  const path = join(root, rel);
  let text = readFileSync(path, 'utf8');
  let next = text;
  for (const fact of facts) {
    for (const re of fact.patterns) {
      for (const m of text.matchAll(re)) {
        const found = Number(m[0].match(/\d+/)[0]);   // 事实数字 = 匹配片段首个数字串
        if (found !== fact.value) {
          mismatches.push({ file: rel, line: lineOf(text, m.index), key: fact.key, found, want: fact.value, snippet: m[0] });
        }
      }
      if (WRITE) {
        next = next.replace(re, (whole) => whole.replace(/\d+/, String(fact.value)));
      }
    }
  }
  if (WRITE && next !== text) {
    writeFileSync(path, next, 'utf8');
    writes.push(rel);
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    measured: Object.fromEntries(facts.map((f) => [f.key, f.value])),
    mismatches, wrote: writes, mode: WRITE ? 'write' : 'check',
  }, null, 2));
} else {
  console.log('实测事实源：');
  for (const f of facts) console.log(`  · ${f.key.padEnd(7)} = ${f.value}   （${f.label}）`);
  if (WRITE) {
    console.log(writes.length ? `\n[✓] 已用实测值回写：${writes.join('、')}` : '\n[✓] 文档已与实测一致，无需改动');
  } else if (mismatches.length === 0) {
    console.log('\n[✓] 文档计数与实测一致');
  } else {
    console.error(`\n[✗] 发现 ${mismatches.length} 处计数漂移（committed ≠ 实测）：`);
    for (const d of mismatches) {
      console.error(`    - ${d.file}:${d.line}  ${d.key}: 文档写 ${d.found}，实测 ${d.want}   「${d.snippet.trim()}」`);
    }
    console.error('\n    修复：node scripts/check-doc-counts.mjs --write');
  }
}

process.exitCode = (!WRITE && mismatches.length > 0) ? 1 : 0;
