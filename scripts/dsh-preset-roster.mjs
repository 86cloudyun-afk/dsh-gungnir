#!/usr/bin/env node
// 只读探针：打印**客户端在新建会话下拉里真正会拿到**的预设列表（含 broken 原因）。
//
// 为什么需要它：装配树（`dsh --dump-config`）里有、注册表里有，都不代表下拉里有——
// 预设被标 `broken` 时客户端不给选（例：`Preset services require isolate realms: warroom`）。
// 本脚本在**独立端口**起一份同配置宿主 + 一个只读探针插件，await `agentPresets.list()`，
// 打印结果后立刻杀掉子进程。
//
// 安全边界（刻意设计）：
//   · **绝不调用 launchctl**、绝不触碰运行中的宿主、绝不用主端口；
//   · 只叠加一个只读 overlay（读名册，不写任何配置）；
//   · 无论成功失败都回收自己起的子进程（含 SIGINT/SIGTERM）。
//
// 用法：
//   node scripts/dsh-preset-roster.mjs                 # 默认 profile=web，自动挑空闲端口
//   node scripts/dsh-preset-roster.mjs --port 3099 --home <DSH_HOME> --profile web
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 探针插件源码：远端拿到的就是客户端拿到的。 */
export const PROBE_SOURCE = `export const inject = ['agentPresets'];
export function apply(ctx) {
  const dump = async () => {
    try {
      const value = await Promise.resolve(ctx.agentPresets.list());
      const arr = Array.isArray(value) ? value : Object.values(value ?? {});
      process.stderr.write('ROSTER_JSON ' + JSON.stringify(arr) + '\\n');
    } catch (e) {
      process.stderr.write('ROSTER_ERROR ' + (e?.message ?? String(e)) + '\\n');
    }
  };
  setTimeout(dump, 4000);
  setTimeout(dump, 9000);
}
`;

export const OVERLAY_SOURCE = `- insert:
    - id: preset-roster-probe
      name: PROBE_PATH
`;

/** 端口可用性（连不上=空闲）。 */
function portFree(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim() === '';
}

export function pickPort(start = 3099, tries = 40) {
  for (let p = start; p < start + tries; p += 1) if (portFree(p)) return p;
  return null;
}

/** 解析 stderr 里的名册行（取最后一次）。 */
export function parseRoster(stderrText) {
  const lines = stderrText.split('\n').filter((l) => l.startsWith('ROSTER_JSON '));
  if (lines.length === 0) {
    const err = stderrText.split('\n').find((l) => l.startsWith('ROSTER_ERROR '));
    return err ? { ok: false, error: err.replace('ROSTER_ERROR ', ''), rows: [] } : { ok: false, error: '未拿到名册（探针未运行或宿主未起来）', rows: [] };
  }
  return { ok: true, rows: JSON.parse(lines[lines.length - 1].replace('ROSTER_JSON ', '')) };
}

/** 渲染成人类可读表：id / 名称 / 是否 broken。 */
export function renderRoster(rows) {
  const out = ['预设名册（客户端下拉会拿到的）', '  id'.padEnd(24) + '名称'.padEnd(26) + '状态'];
  for (const r of rows) {
    const name = r?.name ?? '（默认显示名）';
    const status = r?.broken ? `⛔ broken: ${r.broken}` : '✅ 可选';
    out.push(`  ${String(r?.id ?? '?').padEnd(22)}${String(name).padEnd(24)}${status}`);
  }
  const broken = rows.filter((r) => r?.broken).length;
  out.push('');
  out.push(`合计 ${rows.length} 个，broken ${broken} 个`);
  return out.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      home: { type: 'string' }, profile: { type: 'string' }, port: { type: 'string' },
      json: { type: 'boolean', default: false }, timeout: { type: 'string' },
    },
  });
  const home = v.home ?? process.env.DSH_HOME ?? null;
  const profile = v.profile ?? process.env.DSH_PROFILE ?? 'web';
  if (!home) { console.error('✗ 需要 --home 或 DSH_HOME（不会去猜你的部署）'); return 2; }

  const cli = locateCli(home);
  if (!cli) { console.error(`✗ 找不到 ${profile} profile 的 CLI 入口（core-current/apps/cli/lib/bin.js）`); return 2; }
  if (!portFree(Number(v.port ?? 0)) && v.port) { console.error(`✗ 端口 ${v.port} 已被占用；换个 --port 或省略让它自动挑`); return 2; }

  const port = v.port ? Number(v.port) : pickPort();
  if (!port) { console.error('✗ 3099 起 40 个端口都被占用，无法起探针'); return 2; }

  const dir = mkdtempSync(join(tmpdir(), 'wr-roster-'));
  const probe = join(dir, 'probe.mjs');
  const overlay = join(dir, 'overlay.yml');
  writeFileSync(probe, PROBE_SOURCE, 'utf8');
  writeFileSync(overlay, OVERLAY_SOURCE.replace('PROBE_PATH', probe), 'utf8');

  const timeoutMs = Number(v.timeout ?? 20000);
  const child = spawn(process.execPath, [cli, '--profile', profile, '--patch', overlay,
    '--host', '127.0.0.1', '--port', String(port), '--no-open'],
  { env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => {});

  const kill = () => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } };
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });

  const started = Date.now();
  return new Promise((resolvePromise) => {
    const finish = (code) => {
      kill();
      // 端口兜底：确认监听者已退出（子进程可能是孙进程）
      setTimeout(() => {
        const pids = (spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout ?? '')
          .trim().split('\n').filter(Boolean);
        for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* ignore */ } }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不致命 */ }
        resolvePromise(code);
      }, 800);
    };

    const tick = setInterval(() => {
      const r = parseRoster(stderr);
      if (r.ok && r.rows.length > 0) {
        clearInterval(tick);
        if (v.json) console.log(JSON.stringify(r, null, 2));
        else console.log(renderRoster(r.rows));
        finish(r.rows.some((x) => x?.broken) ? 1 : 0);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        console.error(`✗ ${Math.round(timeoutMs / 1000)}s 内没拿到名册`);
        console.error(stderr.split('\n').filter((l) => /error|failed|Error/i.test(l)).slice(-3).join('\n'));
        finish(2);
      }
    }, 700);
  });
}

/** 找到该 DSH_HOME 对应的 CLI 入口（core-current 优先）。 */
function locateCli(home) {
  const deploy = resolve(home, '..');
  const candidates = [join(deploy, 'core-current', 'apps', 'cli', 'lib', 'bin.js')];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  Promise.resolve(main()).then((code) => { process.exitCode = typeof code === 'number' ? code : 0; });
}

export { readFileSync };
