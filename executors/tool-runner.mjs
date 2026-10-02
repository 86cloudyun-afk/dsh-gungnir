#!/usr/bin/env node
// 真实工具执行器（GUNGNIR 执行层最后一公里）：把桥的 job 变成**真工具调用**。
//
// 契约（与 executors/dsh-redteam-executor.mjs 配套）：
//   输入  stdin:  job JSON（{ protocol, external_id, role, contract:{ targets, intent, action_class, ... } }）
//   输出  stdout: { members: [...], resources: [{ id, kind, stopped }] }
//   失败  非零退出 + stderr —— 主控侧记 unknown/unresolved，**绝不伪造"完成"**。
//
// 出口纪律（操作员 SOP §12）：目标流量**必须**经跳板。本执行器要求显式给出出口：
//   GUNGNIR_EXIT_SOCKS=socks5h://127.0.0.1:21084
// 未给出且目标是外部地址时 **拒绝执行**（fail-closed）；本地/实验室目标需显式
//   GUNGNIR_ALLOW_DIRECT=1
//
// 角色 → 工具（可在 TOOLBOX 里查模板，一律走 `tools/env.sh` 环境）：
//   recon  : subfinder（子域）→ httpx（存活/指纹）          产出 domain / asset
//   assess : nuclei（限量、只跑 critical/high/medium）       产出 vuln
//   其它角色（vuln/exploit/internal/chain）：**未实装**，明确拒绝（不猜、不造事实）
//
// 安全阀：每条命令有超时；请求数上限由 GUNGNIR_MAX_REQUESTS 控制（默认 200）；
// 原始输出落盘到 GUNGNIR_ARTIFACT_DIR（默认 <home>/artifacts/<external_id>/）供人工复核。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha = (s) => `sha256:${createHash('sha256').update(String(s)).digest('hex')}`;
const isLocalTarget = (t) => /^(127\.|localhost|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(t ?? ''));

/** 每条命令的默认超时（ms）与并发限制（节奏档由主控门闸管，这里是执行层自保）。 */
const TIMEOUTS = { subfinder: 180_000, httpx: 240_000, nuclei: 600_000 };

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
  });
}

/**
 * 运行一条工具命令：输出落盘。
 * 注意用 **非登录** shell（`bash -c`）：`bash -lc` 会加载操作员的登录 profile，
 * 实测一条 echo 级别的命令要 ~30 秒（测试因此卡死），而且把执行层耦合到交互式环境。
 * 需要工具链环境时**显式**给 `GUNGNIR_TOOLS_ENV=/path/to/tools/env.sh`（或 opts.toolsEnv）。
 */
export function runTool(cmd, { artifactDir, env = {}, timeoutMs = 300_000, id = 'cmd', log = null, toolsEnv = null } = {}) {
  const envFile = toolsEnv ?? process.env.GUNGNIR_TOOLS_ENV ?? null;
  const script = envFile && existsSync(envFile)
    ? `source ${JSON.stringify(envFile)} >/dev/null 2>&1; ${cmd}`
    : cmd;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, `${id}.stdout.txt`), stdout, 'utf8');
    writeFileSync(join(artifactDir, `${id}.stderr.txt`), stderr, 'utf8');
  }
  if (log) log.push({ id, cmd, exit: r.status, bytes: stdout.length });
  // 超时/非零：如实上报（不把失败当成功）
  return { ok: r.status === 0, exit: r.status, stdout, stderr, timedOut: r.error?.code === 'ETIMEDOUT' };
}

/** subfinder 输出（每行一个域名）→ domain 成员。 */
export function parseDomains(text, target) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const uniq = [...new Set(lines.filter((l) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l)))];
  return uniq.map((d) => ({
    entity_type: 'domain', source_id: d, revision_no: 1, content_hash: sha(d),
    payload: { from: target, tool: 'subfinder' },
  }));
}

/** httpx 行（url [status] [title]）→ asset 成员。兼容 -json 与纯文本两种输出。 */
export function parseAssets(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        const url = j.url ?? j.input;
        if (!url) continue;
        out.push({
          entity_type: 'asset', source_id: url, revision_no: 1, content_hash: sha(url),
          payload: { status: j.status_code ?? null, title: j.title ?? null, tech: j.tech ?? [], tool: 'httpx' },
        });
        continue;
      } catch { /* 非 JSON 行按纯文本处理 */ }
    }
    const m = /^(https?:\/\/\S+)(?:\s+\[?(\d{3})\]?\s*(.*))?$/.exec(line);
    if (m) {
      out.push({
        entity_type: 'asset', source_id: m[1], revision_no: 1, content_hash: sha(m[1]),
        payload: { status: m[2] ? Number(m[2]) : null, title: (m[3] ?? '').trim() || null, tool: 'httpx' },
      });
    }
  }
  return out;
}

/** nuclei 行 → vuln 成员。 */
export function parseFindings(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const j = JSON.parse(line);
      const tpl = j['template-id'] ?? j.templateID ?? 'unknown';
      const matched = j['matched-at'] ?? j.host ?? '';
      const sev = j.info?.severity ?? 'unknown';
      if (!matched) continue;
      out.push({
        entity_type: 'vuln', source_id: `${tpl}@${matched}`, revision_no: 1,
        content_hash: sha(`${tpl}@${matched}`),
        payload: { severity: sev, name: j.info?.name ?? tpl, matched_at: matched, tool: 'nuclei' },
      });
    } catch { /* 忽略非 JSON 行 */ }
  }
  return out;
}

/** 角色 → 命令计划（纯函数，便于回归；不接触网络）。 */
export function planCommands(role, targets, { maxRequests = 200 } = {}) {
  const t0 = targets?.[0];
  if (!t0) return { commands: [], reason: 'contract.targets 为空' };
  if (role === 'recon') {
    const domain = t0.replace(/^https?:\/\//, '').split('/')[0];
    return {
      commands: [
        { id: 'subfinder', tool: 'subfinder', cmd: `subfinder -d ${domain} -silent`, timeoutMs: TIMEOUTS.subfinder, parse: 'domains' },
        {
          id: 'httpx', tool: 'httpx',
          cmd: `printf '%s\\n' ${domain} | httpx -silent -td -title -sc -rl ${Math.min(20, maxRequests)}`,
          timeoutMs: TIMEOUTS.httpx, parse: 'assets',
        },
      ],
      requests: Math.min(maxRequests, 40),
    };
  }
  if (role === 'assess') {
    return {
      commands: [
        {
          id: 'nuclei', tool: 'nuclei',
          cmd: `printf '%s\\n' ${t0} | nuclei -silent -jsonl -severity critical,high,medium -rl 5 -timeout 10 -retries 1`,
          timeoutMs: TIMEOUTS.nuclei, parse: 'findings',
        },
      ],
      requests: Math.min(maxRequests, 50),
    };
  }
  return { commands: [], reason: `角色 ${role} 未实装（fail-closed：不猜、不造事实）` };
}

export async function runJob(job, opts = {}) {
  const role = job.role ?? job.contract?.intent ?? 'recon';
  const contract = job.contract ?? {};
  const targets = contract.targets ?? [];
  const externalId = job.external_id ?? contract.task_id ?? 'job';
  const artifactDir = opts.artifactDir ?? join(process.env.GUNGNIR_ARTIFACT_DIR ?? 'artifacts', externalId);
  const log = [];

  // 出口纪律：外部目标必须显式给代理
  const exitSocks = opts.exitSocks ?? process.env.GUNGNIR_EXIT_SOCKS ?? null;
  const external = targets.some((t) => !isLocalTarget(t));
  if (external && !exitSocks && process.env.GUNGNIR_ALLOW_DIRECT !== '1') {
    throw new Error('拒绝执行：目标是外部地址但未提供出口（GUNGNIR_EXIT_SOCKS）；'
      + '直连目标违反出口 SOP。若确为本地/实验室目标，设 GUNGNIR_ALLOW_DIRECT=1。');
  }

  const plan = planCommands(role, targets, { maxRequests: Number(process.env.GUNGNIR_MAX_REQUESTS ?? 200) });
  if (plan.commands.length === 0) throw new Error(plan.reason ?? '无可用命令计划');

  const env = exitSocks
    ? { ALL_PROXY: exitSocks, all_proxy: exitSocks, NO_PROXY: '', no_proxy: '' }
    : {};
  const members = [];
  for (const step of plan.commands) {
    const r = runTool(step.cmd, { artifactDir, env, timeoutMs: step.timeoutMs, id: step.id, log });
    if (!r.ok) {
      // 工具失败不伪造事实；把失败作为成员之外的错误抛出（主控→unknown）
      throw new Error(`工具 ${step.tool} 执行失败（exit=${r.exit}${r.timedOut ? ', timeout' : ''}）：${r.stderr.slice(0, 300)}`);
    }
    if (step.parse === 'domains') members.push(...parseDomains(r.stdout, targets[0]));
    else if (step.parse === 'assets') members.push(...parseAssets(r.stdout));
    else if (step.parse === 'findings') members.push(...parseFindings(r.stdout));
  }

  return {
    members,
    resources: [{ id: `${externalId}-runner`, kind: 'process', stopped: true }],
    _debug: { role, targets, artifactDir, steps: log, exit: exitSocks ? 'via-socks' : 'direct-local' },
  };
}

// ── CLI（被 GUNGNIR_EXECUTOR_CMD 调用）──
if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = await readStdin();
  let job;
  try { job = JSON.parse(raw); } catch (e) {
    process.stderr.write(`job JSON 解析失败：${e.message}\n`); process.exit(2);
  }
  try {
    const out = await runJob(job);
    const debug = out._debug;
    delete out._debug;
    if (process.env.GUNGNIR_TOOL_RUNNER_VERBOSE === '1') process.stderr.write(`${JSON.stringify(debug)}\n`);
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(4);
  }
}
