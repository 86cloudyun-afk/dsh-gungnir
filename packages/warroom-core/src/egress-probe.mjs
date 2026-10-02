// 出口现测（宿主进程侧）：经**路由的 SOCKS 端点**真发一次请求，测出实际出口 IP。
//
// 为什么放在宿主侧：ADR-001 D1 让战役会话**没有 bash/curl**，而 SOP 要求"出口必须现测、不得引用历史值"。
// 宿主的进程可以起子进程，于是由工具来测、会话来记——既守住隔离，又满足"现测"这条纪律。
//
// 纪律：测不出来就是失败（不猜、不填历史值）；端点缺失直接拒绝。
import { spawnSync } from 'node:child_process';

/** 走本机代理的环境变量必须清掉，否则 curl 会静默回落本机出口（他们的真实泄漏路径）。 */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NO_PROXY'];

/** 出口探测服务（可配多个；跳板 IPv6-only 时 ipify 可能不可达 → 依次回退）。 */
export const DEFAULT_PROBES = ['https://api.ipify.org', 'https://ifconfig.me', 'https://icanhazip.com'];

/**
 * @param {{endpoint:string, probes?:string[], timeoutSec?:number, env?:object, runner?:Function}} p
 * @returns {{ok:boolean, exit_ip:string|null, via:string|null, error:string|null}}
 */
export function probeEgress({ endpoint, probes = DEFAULT_PROBES, timeoutSec = 15, env = process.env, runner = null } = {}) {
  if (!endpoint) return { ok: false, exit_ip: null, via: null, error: '缺少出口端点（socks5h://…）：拒绝在无出口的情况下探测' };
  const clean = { ...env };
  for (const k of PROXY_VARS) delete clean[k];
  const errors = [];
  for (const url of probes) {
    const args = ['-s', '--max-time', String(timeoutSec), '-x', endpoint, url];
    const r = runner
      ? runner(args, { env: clean })
      : spawnSync('curl', args, { encoding: 'utf8', timeout: (timeoutSec + 3) * 1000, env: clean });
    const ip = String(r.stdout ?? '').trim();
    // 只接受 IPv4/IPv6 形态的响应，避免把 HTML/错误页当成出口
    if (r.status === 0 && /^[0-9a-fA-F:.]{6,45}$/.test(ip)) {
      return { ok: true, exit_ip: ip, via: url, error: null };
    }
    errors.push(`${url}: ${(r.stderr ?? '').trim().slice(0, 120) || `exit=${r.status}`}`);
  }
  return { ok: false, exit_ip: null, via: null, error: `全部探测服务均失败 —— ${errors.join(' | ')}` };
}
