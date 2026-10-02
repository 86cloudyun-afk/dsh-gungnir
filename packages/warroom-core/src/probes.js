// 真实探针（ADR-004 范围项 2）：停止证明必须落到进程/端口/容器这些**可实测**的对象上，
// 账本状态永远不算证明。原则：探针失败或不可用 → 视为"未证实"（fail-closed）。
import { execFileSync } from 'node:child_process';

/** PID 存活：真实系统调用（process.kill(pid, 0)）。EPERM 说明进程活着但无权限 → 视为存活。 */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 端口是否在监听：用子进程做一次带超时的 TCP 连接（避免阻塞主流程的同步限制）。 */
export function portOpen(port, { timeoutMs = 300, host = '127.0.0.1' } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return false;
  const script = `
    const net = require('net');
    const s = net.connect(${n}, ${JSON.stringify(host)});
    const done = (v) => { process.stdout.write(v); process.exit(0); };
    s.on('connect', () => done('OPEN'));
    s.on('error', () => done('CLOSED'));
    setTimeout(() => done('TIMEOUT'), ${timeoutMs});
  `;
  try {
    const out = execFileSync('node', ['-e', script], { encoding: 'utf8', timeout: timeoutMs + 500 });
    return out.trim() === 'OPEN';
  } catch {
    return false; // 探针不可用 → 未证实（fail-closed）
  }
}

/** 容器是否仍在运行：docker inspect 返回 running=true 才算存活；docker 不可用返回 null（未知）。 */
export function containerAlive(id) {
  if (!id) return false;
  try {
    const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', String(id)],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() === 'true';
  } catch {
    return null; // 未知：交由调用方标 unresolved，不假装已停
  }
}

/**
 * 按资源描述探测存活。
 * @param {{kind:string, pid?:number, port?:number, container_id?:string}} res
 * @returns {{alive:boolean|null, method:string, detail?:string}}
 */
export function probeResource(res = {}) {
  switch (res.kind) {
    case 'process':
      return { alive: pidAlive(res.pid), method: 'pid', detail: `pid=${res.pid}` };
    case 'port':
      return { alive: portOpen(res.port), method: 'tcp-connect', detail: `port=${res.port}` };
    case 'container':
      return { alive: containerAlive(res.container_id), method: 'docker-inspect', detail: `id=${res.container_id}` };
    default:
      return { alive: null, method: 'unsupported', detail: `kind=${res.kind}` };
  }
}
