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
// 能力面（capability surface）——**全部实装**，见 CAPABILITIES / `--capabilities`：
//   http_get     readonly     curl 单次请求                                    → asset
//   recon        readonly     subfinder（子域）→ httpx（存活/指纹）             → domain / asset
//   nuclei_scan  active       nuclei 限量扫描（-rl 5，critical/high/medium）    → vuln
//   vuln         active       定点验证：模板/标签/等级，或操作员给的命令         → vuln / artifact
//   exec         active       contract.command / contract.argv 任意命令         → artifact
//   exploit      destructive  利用/取控制面（命令由操作员给出）                 → session / credential / artifact
//   internal     active       横向与提权（netexec/impacket/msf 任选）           → session / credential / asset / artifact
//   chain        active       contract.steps 顺序多跳（≤12 步）                 → chain / artifact
//
// 命令来源只有一处：**操作员在契约里显式给出**（`command` 字符串或 `argv` 数组）。
// 执行器不猜、不造事实——没有命令就明确报缺哪个字段（而不是"未实装"）。
// 证据回传走显式协议行 `GUNGNIR_MEMBER: {"entity_type":…,"source_id":…,"payload":…}`，
// 逐行原样入库（自动补 content_hash），执行器不做任何推断。
//
// 安全阀：每条命令有超时（`contract.timeout_ms`，上限 GUNGNIR_MAX_TIMEOUT_MS）；请求数上限由
// GUNGNIR_MAX_REQUESTS 控制（默认 200）；原始输出落盘到 GUNGNIR_ARTIFACT_DIR
// （默认 <home>/artifacts/<external_id>/）供人工复核。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha = (s) => `sha256:${createHash('sha256').update(String(s)).digest('hex')}`;
const isLocalTarget = (t) => /^(127\.|localhost|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(t ?? ''));

/** URL/裸主机 → 主机名（出口判定按主机，不按整条 URL）；file:// 之类无主机的返回 null。 */
export function hostOf(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { const h = new URL(s).hostname; return h ? h.replace(/^\[|\]$/g, '') : null; } catch { return null; }
  }
  const host = s.replace(/[/?#].*$/, '').replace(/^.*@/, '').split(':')[0].trim();
  return host || null;
}

/**
 * 契约里**全部可寻址对象**：targets + url + chain 步内 targets/url。
 * 出口铁律（操作员 SOP §12）不能只盯 `targets`——否则 `url` 就是一条直连外网的旁路（真机实测过）。
 */
export function addressables(contract = {}) {
  const out = [];
  const addHost = (v) => { const h = hostOf(v); if (h && !out.includes(h)) out.push(h); };
  for (const t of Array.isArray(contract.targets) ? contract.targets : []) addHost(t);
  addHost(contract.url);
  for (const s of Array.isArray(contract.steps) ? contract.steps : []) {
    for (const t of Array.isArray(s?.targets) ? s.targets : []) addHost(t);
    addHost(s?.url);
  }
  return out;
}

/** 稳定序列化（对象键排序）：同一份证据两次入库必须得到同一个 content_hash（幂等的前提）。 */
const canonical = (v) => JSON.stringify(v, (_k, val) => (
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
    : val
));

/** 每条命令的默认超时（ms）与并发限制（节奏档由主控门闸管，这里是执行层自保）。 */
const TIMEOUTS = { subfinder: 180_000, httpx: 240_000, nuclei: 600_000, exec: 300_000 };

/** 单次派单内允许的最大步骤数（chain.steps / 多命令计划），防止一次派单变成无界批处理。 */
const MAX_STEPS = 12;

/** 操作员命令的超时上限（可用 GUNGNIR_MAX_TIMEOUT_MS 抬到 1h）。 */
const maxExecTimeout = () => Math.max(1_000, Number(process.env.GUNGNIR_MAX_TIMEOUT_MS ?? 3_600_000));

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
export function runTool(cmd, { artifactDir, env = {}, timeoutMs = 300_000, id = 'cmd', log = null, toolsEnv = null, cleanProxyEnv = true } = {}) {
  const envFile = toolsEnv ?? process.env.GUNGNIR_TOOLS_ENV ?? null;
  const script = envFile && existsSync(envFile)
    ? `source ${JSON.stringify(envFile)} >/dev/null 2>&1; ${cmd}`
    : cmd;
  const base = { ...process.env };
  if (cleanProxyEnv) {
    // 目标流量必须显式指定出口：环境里的代理变量会造成"静默回落本机出口"或与 -x 打架
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NO_PROXY']) delete base[k];
  }
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...base, ...env },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, `${id}.stdout.txt`), stdout, 'utf8');
    writeFileSync(join(artifactDir, `${id}.stderr.txt`), stderr, 'utf8');
  }
  if (log) log.push({ id, cmd, exit: r.status, bytes: stdout.length });
  // 超时/信号/非零：如实上报（不把失败当成功）；信号杀（SIGKILL/OOM）不是"正常退出"
  return {
    ok: r.status === 0, exit: r.status, signal: r.signal ?? null,
    stdout, stderr, timedOut: r.error?.code === 'ETIMEDOUT',
  };
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

/** `curl -i -w __CURL__…` 输出 → asset 成员（状态码/标题/大小/耗时/关键响应头）。 */
export function parseHttp(text) {
  const body = String(text ?? '');
  const marker = body.lastIndexOf('__CURL__');
  const meta = marker >= 0 ? body.slice(marker + '__CURL__'.length).trim().split(/\s+/) : [];
  const status = meta[0] ? Number(meta[0]) : null;
  const size = meta[1] ? Number(meta[1]) : null;
  const timeSec = meta[2] ? Number(meta[2]) : null;
  const head = marker >= 0 ? body.slice(0, marker) : body;
  const title = (/<title[^>]*>([^<]{0,200})<\/title>/i.exec(head) ?? [])[1] ?? null;
  const server = (/^server:\s*(.+)$/im.exec(head) ?? [])[1]?.trim() ?? null;
  const poweredBy = (/^x-powered-by:\s*(.+)$/im.exec(head) ?? [])[1]?.trim() ?? null;
  const location = (/^location:\s*(.+)$/im.exec(head) ?? [])[1]?.trim() ?? null;
  const cookieName = (/^set-cookie:\s*([^=;\s]+)/im.exec(head) ?? [])[1]?.trim() ?? null;
  if (status === null || Number.isNaN(status)) return [];
  return [{
    entity_type: 'asset', source_id: `http:${status}:${title ?? ''}`.slice(0, 120), revision_no: 1,
    content_hash: sha(`${status}|${title ?? ''}|${size ?? ''}|${server ?? ''}`),
    payload: { status, title, server, powered_by: poweredBy, location, set_cookie_name: cookieName,
      size, time_sec: timeSec, tool: 'curl' },
  }];
}

/**
 * 显式证据协议：操作员的命令可以在 stdout 里逐行写
 *   `GUNGNIR_MEMBER: {"entity_type":"session","source_id":"…","payload":{…}}`
 * 执行器**原样**把它变成事实成员（`content_hash` 按规范化内容**重算**，不采信自报值——
 * 键序/自报值不同会让同一条证据变成两条互相隔离的冲突事实）。
 * 只认这几种实体类型，字段不全的行直接忽略——**不推断、不脑补**。
 */
export const EVIDENCE_PREFIX = 'GUNGNIR_MEMBER:';
const MEMBER_TYPES = new Set(['asset', 'domain', 'vuln', 'credential', 'session', 'shell', 'chain', 'artifact']);

export function parseEvidence(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const at = raw.indexOf(EVIDENCE_PREFIX);
    if (at < 0) continue;
    let j;
    try { j = JSON.parse(raw.slice(at + EVIDENCE_PREFIX.length).trim()); } catch { continue; }
    const type = String(j?.entity_type ?? j?.type ?? '');
    const src = String(j?.source_id ?? j?.source ?? '').trim();
    if (!MEMBER_TYPES.has(type) || !src) continue;
    const payload = (j.payload && typeof j.payload === 'object' && !Array.isArray(j.payload)) ? j.payload : {};
    out.push({
      entity_type: type, source_id: src,
      revision_no: Number.isInteger(j.revision_no) ? j.revision_no : 1,
      // 一律按**规范化内容**重算：自报值/键序不同会让同一条证据变成两条冲突事实（真机踩过）
      content_hash: sha(`${type}|${src}|${canonical(payload)}`),
      payload,
    });
  }
  return out;
}

/**
 * 操作员命令的运行证据（**命令确实跑过**这一事实本身）：命令哈希 + 退出码 + 输出哈希 + 落盘路径。
 * source_id 带上输出哈希：同一条命令两次输出不同 → 两条事实（不互相覆盖）；输出相同 → 幂等忽略。
 */
export function artifactMember({ id, action, cmd, exit, stdout, stderr, timedOut = false, artifactDir = null }) {
  const cmdSha = sha(cmd);
  const outSha = sha(stdout);
  return {
    entity_type: 'artifact',
    source_id: `${action ?? 'exec'}:${cmdSha.slice(7, 19)}:${outSha.slice(7, 19)}`,
    revision_no: 1,
    content_hash: outSha,
    payload: {
      action: action ?? 'exec', exit: exit ?? null, timed_out: timedOut === true,
      bytes: String(stdout ?? '').length, command_sha256: cmdSha, stderr_sha256: sha(stderr ?? ''),
      artifact: artifactDir ? join(artifactDir, `${id ?? 'cmd'}.stdout.txt`) : null, tool: 'exec',
    },
  };
}

/** argv → shell 安全的单行命令（保留参数边界；PR #170 的教训：空格路径不许被拆开）。 */
export function shellQuote(s) {
  const v = String(s);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`;
}

/** 命令来源：契约里**显式**给出的 `command` 或 `argv`；都没有就返回 null（调用方负责报缺字段）。 */
export function resolveCommand({ command = null, argv = null } = {}) {
  if (typeof command === 'string' && command.trim()) return { cmd: command.trim(), source: 'contract.command' };
  if (Array.isArray(argv) && argv.length > 0) {
    return { cmd: argv.map(shellQuote).join(' '), source: 'contract.argv' };
  }
  return null;
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

/**
 * 能力面注册表：**动作 → 计划构建方式**。指挥层可用 `--capabilities` 现查（机器可读），
 * 拒绝信息里也列全量能力——历史上这里只实装了 3 个动作，别的动作一律回"未实装"，
 * 指挥层只能看到"通道缺少能力"而不知道缺什么、该怎么办（真机教训 2026-10-03）。
 *
 * tier 与 broker 的 action_class 对齐：readonly/active/destructive。执行器**不重复**做授权裁决
 * （那是 broker 的门闸：destructive 需人工批准令牌），只保证「派下来的动作有真实命令计划」。
 */
export const CAPABILITIES = Object.freeze({
  http_get: {
    aliases: ['http', 'http_probe', 'probe', 'readonly'], tier: 'readonly',
    requires: ['url|targets'], tool: 'curl', produces: ['asset'],
    note: '单次 HTTP 请求（状态码/标题/关键响应头）',
  },
  recon: {
    aliases: [], tier: 'readonly',
    requires: ['targets'], tool: 'subfinder+httpx', produces: ['domain', 'asset'],
    note: '子域枚举 → 存活/指纹',
  },
  nuclei_scan: {
    aliases: ['assess'], tier: 'active',
    requires: ['targets'], tool: 'nuclei', produces: ['vuln'],
    note: '限量漏洞扫描（-rl 5，仅 critical/high/medium）',
  },
  vuln: {
    aliases: ['vuln_check', 'verify'], tier: 'active',
    requires: ['targets|command'], tool: 'nuclei|操作员命令', produces: ['vuln', 'artifact'],
    note: '定点漏洞验证：给 template/tags/severity 走 nuclei，或直接用操作员给的命令',
  },
  exec: {
    aliases: ['shell', 'bash', 'cmd', 'command'], tier: 'active',
    requires: ['command|argv'], tool: 'bash -c', produces: ['artifact'],
    note: '任意命令（命令由操作员在契约里显式给出）',
  },
  exploit: {
    aliases: ['poc'], tier: 'destructive',
    requires: ['command|argv'], tool: 'bash -c', produces: ['session', 'credential', 'artifact'],
    note: '利用/取控制面：命令由操作员给出；broker 侧 destructive 需人工批准令牌',
  },
  internal: {
    aliases: ['lateral'], tier: 'active',
    requires: ['command|argv'], tool: 'bash -c', produces: ['session', 'credential', 'asset', 'artifact'],
    note: '横向与提权：命令由操作员给出（netexec/impacket/msf 任选）',
  },
  chain: {
    aliases: [], tier: 'active',
    requires: ['steps|command|argv'], tool: 'bash -c ×N', produces: ['chain', 'artifact'],
    note: '多跳拼链：contract.steps 顺序执行，任一步失败即停',
  },
});

const ALIASES = new Map(Object.entries(CAPABILITIES).flatMap(([k, v]) => [[k, k], ...(v.aliases ?? []).map((a) => [a, k])]));

/** 动作名（含别名）→ 能力键；未知动作返回 null。 */
export function capabilityOf(action) {
  const a = String(action ?? '').trim().toLowerCase();
  return ALIASES.get(a) ?? null;
}

/** 支持的动作清单（写进拒绝信息里，让指挥层知道该派什么、要带哪些字段）。 */
export const SUPPORTED_ACTIONS = Object.freeze(
  Object.entries(CAPABILITIES).map(([k, v]) => `${k}（${v.tier}：${v.note}；契约需 ${v.requires.join(' + ')}）`),
);

/** 机器可读能力面（`node executors/tool-runner.mjs --capabilities`）。 */
export function capabilitiesSnapshot() {
  return {
    protocol: 'gungnir-executor/1',
    actions: Object.fromEntries(Object.entries(CAPABILITIES).map(([k, v]) => [k, { ...v, aliases: [...v.aliases] }])),
    roles: { recon: 'recon', assess: 'nuclei_scan', vuln: 'vuln', exploit: 'exploit', internal: 'internal', chain: 'chain' },
    evidence_protocol: `${EVIDENCE_PREFIX} {"entity_type":…,"source_id":…,"payload":…}`,
    limits: { max_steps: MAX_STEPS, default_exec_timeout_ms: TIMEOUTS.exec, max_exec_timeout_ms: maxExecTimeout() },
  };
}

/**
 * 契约 → 命令计划（纯函数，便于回归；不接触网络）。
 *
 * **按 `contract.action` 办事，而不是按角色猜**。真机教训（2026-10-03）：指挥层派
 * `action: http_get`（带 url）要的是"看一眼这个页面"，执行器却因为 `role=assess` 去跑了
 * 10 分钟 nuclei —— 跑飞、被超时杀掉、状态 failed、wire=0，指挥层看到的就是"派单成功但执行失败"。
 *
 * 解析顺序：`contract.action`（含别名）→ 没有 action 时退回 `role` 的能力 → 都没有则**明确报缺**
 * （列出全量能力面，不再出现"未实装/不属于本通道"这种让指挥层无从下手的空话）。
 */
export function planCommands(role, targets, {
  maxRequests = 200, action = null, url = null, method = 'GET', exit = null,
  command = null, argv = null, template = null, tags = null, severity = null,
  steps = null, timeoutMs = null,
} = {}) {
  const t0 = targets?.[0];
  const targetUrl = url ?? (t0 ? (String(t0).startsWith('http') ? t0 : `https://${t0}`) : null);
  const op = resolveCommand({ command, argv });          // 操作员显式给出的命令（唯一的通用能力来源）
  const asked = Number(timeoutMs ?? TIMEOUTS.exec);
  const execTimeout = Math.max(1_000, Math.min(Number.isFinite(asked) ? asked : TIMEOUTS.exec, maxExecTimeout()));

  // 动作解析：显式 action 优先；没有 action 才按 role 取能力。
  const rawAction = action === null || action === undefined || action === '' ? null : String(action);
  const cap = rawAction ? capabilityOf(rawAction) : capabilityOf(role);
  if (!cap) {
    return {
      commands: [],
      reason: `动作 ${JSON.stringify(rawAction ?? role)} 无法识别（fail-closed：不猜、不造事实）。`
        + `可用能力：${SUPPORTED_ACTIONS.join(' / ')}`,
    };
  }

  // 通用命令计划（exec/exploit/internal：命令由操作员给出）。
  // 操作员命令只走**显式证据协议**解析，不做格式嗅探（防止把 exec 输出解析成 asset/vuln 之类的假事实）。
  const operatorStep = (id, extra = {}) => ({
    id, tool: 'exec', cmd: op.cmd, timeoutMs: execTimeout,
    parse: 'evidence', artifact: true, strict: false, from: op.source, ...extra,
  });

  switch (cap) {
    case 'http_get': {
      if (!targetUrl) return { commands: [], reason: 'http_get 需要 contract.url 或 targets' };
      return {
        commands: [{
          id: 'http_get', tool: 'http_get', timeoutMs: 45_000,
          // 必须**显式** -x：只靠 ALL_PROXY 时 curl 会只完成 CONNECT 就失败（真机实测 000）
          cmd: `curl -sS -i -m 20${exit ? ` -x ${exit}` : ''} -X ${method}`
            + ` -w "\\n__CURL__%{http_code} %{size_download} %{time_total}" ${JSON.stringify(targetUrl)}`,
          parse: 'http', strict: true,
        }],
        requests: 1,
      };
    }

    case 'recon': {
      if (!t0) return { commands: [], reason: 'recon 需要 contract.targets' };
      const domain = String(t0).replace(/^https?:\/\//, '').split('/')[0];
      return {
        commands: [
          { id: 'subfinder', tool: 'subfinder', cmd: `subfinder -d ${domain} -silent`, timeoutMs: TIMEOUTS.subfinder, parse: 'domains', strict: true },
          {
            id: 'httpx', tool: 'httpx',
            cmd: `printf '%s\\n' ${domain} | httpx -silent -td -title -sc -rl ${Math.min(20, maxRequests)}`,
            timeoutMs: TIMEOUTS.httpx, parse: 'assets', strict: true,
          },
        ],
        requests: Math.min(maxRequests, 40),
      };
    }

    case 'nuclei_scan': {
      if (!t0) return { commands: [], reason: 'nuclei_scan 需要 contract.targets' };
      return {
        commands: [{
          id: 'nuclei', tool: 'nuclei',
          cmd: `printf '%s\\n' ${t0} | nuclei -silent -jsonl -severity critical,high,medium -rl 5 -timeout 10 -retries 1`,
          timeoutMs: TIMEOUTS.nuclei, parse: 'findings', strict: true,
        }],
        requests: Math.min(maxRequests, 50),
      };
    }

    case 'vuln': {
      // 定点验证：给了命令就按命令跑；没给就按选择器（模板/标签/等级）跑 nuclei。
      if (op) return { commands: [operatorStep('vuln', { tool: 'vuln' })], requests: Math.min(maxRequests, 50) };
      if (!t0) {
        return {
          commands: [],
          reason: 'vuln 需要 contract.targets（定点 nuclei 扫描），或 contract.command / contract.argv（自带验证命令）',
        };
      }
      // 选择器按 token 逐个 shellQuote 组装（不裸拼、不做全局空白折叠——免得把已引号包裹的路径改语义）
      const sevs = String(severity ?? 'critical,high,medium').split(',')
        .map((s) => s.trim()).filter(Boolean).map(shellQuote);
      if (sevs.length === 0) return { commands: [], reason: 'vuln 的 severity 为空：要么给合法等级，要么用 contract.command 自带命令' };
      const argv = [
        'nuclei', '-silent', '-jsonl', '-severity', sevs.join(','),
        ...(template ? ['-t', template] : []),
        ...(tags ? ['-tags', String(tags)] : []),
        '-rl', '5', '-timeout', '10', '-retries', '1',
      ];
      return {
        commands: [{
          id: 'nuclei_vuln', tool: 'nuclei',
          cmd: `printf '%s\\n' ${shellQuote(t0)} | ${argv.map(shellQuote).join(' ')}`,
          timeoutMs: TIMEOUTS.nuclei, parse: 'findings', strict: true,
        }],
        requests: Math.min(maxRequests, 50),
      };
    }

    case 'exec':
    case 'exploit':
    case 'internal': {
      if (!op) {
        return {
          commands: [],
          reason: `${cap} 需要 contract.command（字符串）或 contract.argv（数组）——命令必须由操作员显式给出，`
            + '执行器不替指挥层发明命令。示例：{"action":"exec","command":"id"}'
            + `（${cap === 'exploit' ? '；destructive 需人工批准令牌，由 broker 门闸校验' : ''}）`,
        };
      }
      return { commands: [operatorStep(cap)], requests: 0 };
    }

    case 'chain': {
      // 多跳：contract.steps 顺序执行（每步 = 命令，或 {action, …} 走同一套计划器）。
      if (Array.isArray(steps) && steps.length > 0) {
        if (steps.length > MAX_STEPS) {
          return { commands: [], reason: `chain.steps 最多 ${MAX_STEPS} 步（收到 ${steps.length} 步）` };
        }
        const commands = [];
        for (const [i, s] of steps.entries()) {
          const sub = planCommands(role, Array.isArray(s?.targets) ? s.targets : targets, {
            maxRequests, action: s?.action ?? 'exec', url: s?.url ?? null, method: s?.method ?? method, exit,
            command: s?.command ?? null, argv: s?.argv ?? null, template: s?.template ?? null,
            tags: s?.tags ?? null, severity: s?.severity ?? null, timeoutMs: s?.timeout_ms ?? null,
          });
          if (sub.commands.length === 0) {
            return { commands: [], reason: `chain.steps[${i}] 无法成计划：${sub.reason ?? '未知原因'}` };
          }
          commands.push(...sub.commands.map((c, k) => ({ ...c, id: `step${i + 1}.${k + 1}.${c.id}` })));
        }
        // 上界按**展开后的命令数**判（12 步 recon 型动作 = 24 条命令，不是 12 条）
        if (commands.length > MAX_STEPS) {
          return { commands: [], reason: `chain 展开后共 ${commands.length} 条命令，超过上限 ${MAX_STEPS}（steps ${steps.length} 步）` };
        }
        return { commands, requests: Math.min(maxRequests, 50), steps: steps.length, commands_total: commands.length };
      }
      if (op) return { commands: [operatorStep('chain')], requests: 0 };
      return {
        commands: [],
        reason: 'chain 需要 contract.steps（数组，顺序多跳）或 contract.command / contract.argv（单条拼链命令）',
      };
    }

    default:
      return { commands: [], reason: `能力 ${cap} 没有命令计划（这是实现缺陷，请报 bug）` };
  }
}

export async function runJob(job, opts = {}) {
  const role = job.role ?? job.contract?.intent ?? 'recon';
  // 动作优先（契约说什么就干什么）：指挥层派 http_get 时不要按 role 去猜扫描
  const contract = job.contract ?? {};
  const targets = contract.targets ?? [];
  const externalId = job.external_id ?? contract.task_id ?? 'job';
  const artifactDir = opts.artifactDir ?? join(process.env.GUNGNIR_ARTIFACT_DIR ?? 'artifacts', externalId);
  const log = [];

  // 出口纪律：契约里**任何**可寻址对象是外部地址就必须显式给代理（targets 之外还有 url 与 chain 步内目标）
  const exitSocks = opts.exitSocks ?? process.env.GUNGNIR_EXIT_SOCKS ?? null;
  const addrs = addressables(contract);
  const external = addrs.filter((t) => !isLocalTarget(t));
  if (external.length > 0 && !exitSocks && process.env.GUNGNIR_ALLOW_DIRECT !== '1') {
    throw new Error(`拒绝执行：目标是外部地址（${external.join(', ')}）但未提供出口（GUNGNIR_EXIT_SOCKS）；`
      + '直连目标违反出口 SOP。若确为本地/实验室目标，设 GUNGNIR_ALLOW_DIRECT=1。');
  }

  const plan = planCommands(role, targets, {
    maxRequests: Number(process.env.GUNGNIR_MAX_REQUESTS ?? 200),
    action: contract.action ?? null, url: contract.url ?? null, method: contract.method ?? 'GET',
    exit: exitSocks,
    command: contract.command ?? null, argv: contract.argv ?? null,
    template: contract.template ?? null, tags: contract.tags ?? null, severity: contract.severity ?? null,
    steps: contract.steps ?? null, timeoutMs: contract.timeout_ms ?? null,
  });
  if (plan.commands.length === 0) throw new Error(plan.reason ?? '无可用命令计划');

  // Go 系工具（subfinder/httpx/nuclei）没有 -x 参数，只能靠环境变量；它们认 socks5:// 方言
  const goProxy = exitSocks ? exitSocks.replace(/^socks5h:\/\//, 'socks5://') : null;
  const env = goProxy
    ? { ALL_PROXY: goProxy, HTTP_PROXY: goProxy, HTTPS_PROXY: goProxy, all_proxy: goProxy, http_proxy: goProxy, https_proxy: goProxy }
    : {};
  const members = [];
  for (const step of plan.commands) {
    const r = runTool(step.cmd, { artifactDir, env, timeoutMs: step.timeoutMs, id: step.id, log });

    // 超时 = 证据不完整：如实抛错（产物仍在 artifactDir，错误里给出路径）
    if (r.timedOut) {
      throw new Error(`命令超时（${step.id}，${step.timeoutMs}ms）：证据不完整，主控应记 unknown；`
        + `已落盘的原始输出：${join(artifactDir, `${step.id}.stdout.txt`)}`);
    }
    // 信号杀（SIGKILL/OOM）也不是"正常退出"：status=null 时绝不记成成功
    if (r.exit === null || r.signal) {
      throw new Error(`命令被信号终止（${step.id}，signal=${r.signal ?? 'unknown'}）：证据不完整，主控应记 unknown；`
        + `已落盘的原始输出：${join(artifactDir, `${step.id}.stdout.txt`)}`);
    }
    // 内置工具模板（subfinder/httpx/nuclei/curl）非零退出 = 失败，绝不伪造事实（主控→unknown）
    if (!r.ok && step.strict !== false) {
      throw new Error(`工具 ${step.tool} 执行失败（exit=${r.exit}）：${r.stderr.slice(0, 300)}`);
    }

    // 解析：显式证据协议行永远先收（操作员自己申报的事实）；再按步骤声明的格式解析
    members.push(...parseEvidence(r.stdout));
    if (step.parse === 'http') members.push(...parseHttp(r.stdout));
    else if (step.parse === 'domains') members.push(...parseDomains(r.stdout, targets[0]));
    else if (step.parse === 'assets') members.push(...parseAssets(r.stdout));
    else if (step.parse === 'findings') members.push(...parseFindings(r.stdout));

    // 操作员命令：无论成败都留一条 artifact 事实（命令确实跑过 + 退出码 + 输出哈希 + 落盘路径）。
    // 非零退出**不抛错**（那是被派命令的真实结果，属证据不是故障）；超时已在上文抛出。
    if (step.artifact === true) {
      members.push(artifactMember({
        id: step.id, action: contract.action ?? role, cmd: step.cmd,
        exit: r.exit, stdout: r.stdout, stderr: r.stderr, timedOut: false, artifactDir,
      }));
    }
  }

  return {
    // 回执必须带 generation：桥的插件层（executors/dsh-redteam-executor.mjs）按
    // `out.generation === job.contract.generation` 校验代际，缺了就整单退 exit=4（真机踩过）
    ...(typeof contract.generation === 'string' ? { generation: contract.generation } : {}),
    external_id: externalId,
    members,
    resources: [{ id: `${externalId}-runner`, kind: 'process', stopped: true }],
    _debug: {
      role, targets, addressables: addrs, artifactDir, steps: log,
      exit: exitSocks ? 'via-socks' : 'direct-local',
      action: capabilityOf(contract.action ?? role) ?? null, capabilities: Object.keys(CAPABILITIES),
    },
  };
}

// ── CLI（被 GUNGNIR_EXECUTOR_CMD 调用）──
if (import.meta.url === `file://${process.argv[1]}`) {
  // 能力面现查：指挥层/运维不用读源码就知道这条通道能派什么、每项要带哪些契约字段
  if (process.argv.includes('--capabilities')) {
    process.stdout.write(`${JSON.stringify(capabilitiesSnapshot(), null, 2)}\n`);
    process.exit(0);
  }
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
