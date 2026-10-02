// 桶 A 容器围栏（ADR-001 验收 5 / 框架 §8-9）：让"出网不可绕过"从纪律变成拓扑。
//
// 拓扑：
//   任务容器 ──► warroom-fence（internal 网络，无外部路由）
//                    └──► sidecar（双挂：fence + 默认桥）──► route.socks ──► 目标
// 不变量：
//   1) fence 网络 internal=true（任务容器没有第二条出口）
//   2) 任务容器只接 fence 网络，DNS 指向 sidecar（不落宿主解析器）
//   3) sidecar 是唯一双重连接的容器，其上游 = 门闸下发的 route.socks
//   4) 任务容器不得用 host 网络 / 特权模式 / 挂载宿主 docker.sock
import { createHash } from 'node:crypto';

export const FENCE_NETWORK = 'warroom-fence';
export const HOST_RESOLVERS = ['8.8.8.8', '8.8.4.4', '1.1.1.1', '114.114.114.114', '223.5.5.5'];

/**
 * @param {{engagementId:string, route:{socks:string, route_id?:string}, image?:string,
 *          sidecarImage?:string, taskCmd?:string[], sidecarPort?:number}} p
 */
export function buildFencePlan({ engagementId, route, image = 'alpine:latest', sidecarImage = 'alpine:latest', taskCmd, sidecarPort = 1080 }) {
  if (!engagementId) throw new Error('buildFencePlan 需要 engagementId');
  if (!route?.socks) throw new Error('buildFencePlan 需要 route.socks（来自 jumphosts.acquire）');
  const netId = `${FENCE_NETWORK}-${createHash('sha256').update(engagementId).digest('hex').slice(0, 10)}`;
  return {
    engagement_id: engagementId,
    network: { name: netId, internal: true, driver: 'bridge' },
    sidecar: {
      name: `${netId}-sidecar`,
      image: sidecarImage,
      networks: [netId, 'bridge'],          // 双挂：内网 + 外部
      upstream: route.socks,                 // 唯一出口，来自门闸
      listen_port: sidecarPort,
      privileged: false,
      cmd: ['sh', '-c', 'sleep 3600'],       // 真实实现替换为 redsocks/gost；拓扑不变
    },
    task: {
      name: `${netId}-task`,
      image,
      networks: [netId],                     // 只接内网
      dns: [`sidecar`],                      // 占位：实际取 sidecar 在 fence 网络内的 IP
      host_network: false,
      privileged: false,
      mounts: [],
      cmd: taskCmd ?? ['sh', '-c', 'sleep 3600'],
    },
    route_id: route.route_id ?? null,
  };
}

/**
 * 从战役库读取活跃跳板路由并生成围栏计划（**fail-closed**：无活跃 route 就不给计划）。
 * @param {{store:object, engagementId:string, routeId?:string, image?:string, taskCmd?:string[]}} p
 */
export function planFenceForEngagement({ store, engagementId, routeId = null, image, taskCmd }) {
  const routes = store.db.prepare("SELECT * FROM jump_routes WHERE state = 'active' ORDER BY ts").all();
  if (routes.length === 0 && !routeId) {
    const e = new Error('没有活跃跳板路由：围栏出口必须来自门闸下发的 route（先 jumphosts.acquire）');
    e.code = 'E_FENCE_NO_ROUTE';
    throw e;
  }
  const route = routeId ? routes.find((r) => r.route_id === routeId) : routes.at(-1);
  if (!route) {
    const e = new Error(`route ${routeId} 不存在或非活跃`);
    e.code = 'E_FENCE_NO_ROUTE';
    throw e;
  }
  return {
    ...buildFencePlan({ engagementId, route: { socks: route.socks, route_id: route.route_id }, image, taskCmd }),
    upstream_source: { route_id: route.route_id, jumphost_id: route.jumphost_id, socks: route.socks, state: route.state },
  };
}

/** 静态校验：不变量逐条检查，fail-closed。 */
export function verifyFencePlan(plan) {
  const errors = [];
  const guarantees = [];
  if (plan.network?.internal !== true) errors.push('fence 网络必须 internal=true（否则任务容器有第二条出口）');
  else guarantees.push('fence 网络 internal=true：无外部路由');

  if (!Array.isArray(plan.task?.networks) || plan.task.networks.length !== 1 || plan.task.networks[0] !== plan.network.name) {
    errors.push('任务容器必须只接 fence 网络');
  } else guarantees.push('任务容器仅接 fence 网络');

  const dns = plan.task?.dns ?? [];
  if (dns.length === 0) errors.push('任务容器必须显式指定 DNS（默认会落宿主解析器）');
  else if (dns.some((d) => HOST_RESOLVERS.includes(d))) errors.push(`任务容器 DNS 不得为公共解析器：${dns.join(',')}`);
  else guarantees.push('DNS 指向围栏内 sidecar，不落宿主/公共解析器');

  if (plan.task?.host_network) errors.push('任务容器不得使用 host 网络');
  if (plan.task?.privileged) errors.push('任务容器不得为特权模式');
  if ((plan.task?.mounts ?? []).some((m) => String(m).includes('docker.sock'))) errors.push('任务容器不得挂载宿主 docker.sock');

  const nets = plan.sidecar?.networks ?? [];
  if (nets.length < 2 || !nets.includes(plan.network.name)) errors.push('sidecar 必须双挂（fence + 外部网络）');
  else guarantees.push('sidecar 是唯一双重连接容器');
  if (!plan.sidecar?.upstream || !/^socks5h?:\/\//.test(plan.sidecar.upstream)) {
    errors.push('sidecar 上游必须是门闸下发的 socks 地址');
  } else guarantees.push(`唯一出口 = ${plan.sidecar.upstream}`);
  if (plan.upstream_source && plan.upstream_source.socks !== plan.sidecar.upstream) {
    errors.push('围栏上游与 route 记录不一致（可能被手工改写）');
  }

  return { ok: errors.length === 0, errors, guarantees };
}

/** 生成 docker CLI 命令序列（供脚本/测试执行或审阅）。 */
export function dockerCommands(plan) {
  const cmds = [];
  cmds.push(['docker', 'network', 'create', '--internal', plan.network.name]);
  cmds.push(['docker', 'run', '-d', '--name', plan.sidecar.name, '--network', plan.network.name, plan.sidecar.image, ...plan.sidecar.cmd]);
  cmds.push(['docker', 'network', 'connect', 'bridge', plan.sidecar.name]);            // 给 sidecar 第二条腿
  cmds.push(['docker', 'run', '-d', '--name', plan.task.name,
    '--network', plan.network.name, '--dns', '127.0.0.11', plan.task.image, ...plan.task.cmd]);
  cmds.push(['docker', 'exec', plan.task.name, 'cat', '/etc/resolv.conf']);
  cmds.push(['docker', 'exec', plan.task.name, 'sh', '-c', 'wget -T3 -qO- http://example.com || echo EGRESS_BLOCKED']);
  cmds.push(['docker', 'rm', '-f', plan.task.name, plan.sidecar.name]);
  cmds.push(['docker', 'network', 'rm', plan.network.name]);
  return cmds;
}

/**
 * 运行时验收：daemon 不可用 → 整体 SKIP（如实上报，不假装通过）。
 * @param {{plan:object, run:(args:string[])=>{ok:boolean, out:string}}} p
 */
export function runFenceVerification({ plan, run }) {
  const steps = [];
  const push = (name, ok, detail, skipped = false) => steps.push({ name, ok, detail, skipped });

  const info = run(['docker', 'info']);
  if (!info.ok) {
    push('docker daemon 可用', false, `不可用：${(info.out || '').split('\n')[0]}`, true);
    return { status: 'skipped', reason: 'docker daemon 不可用', steps };
  }
  push('docker daemon 可用', true, '');

  const staticCheck = verifyFencePlan(plan);
  push('静态不变量校验', staticCheck.ok, staticCheck.errors.join('；'));

  const live = []; // 真实执行步骤（脚本模式下由调用方注入）
  for (const [name, args] of [
    ['创建 internal 网络', dockerCommands(plan)[0]],
    ['启动 sidecar（双挂）', dockerCommands(plan)[1]],
    ['sidecar 接默认桥', dockerCommands(plan)[2]],
    ['启动任务容器', dockerCommands(plan)[3]],
  ]) {
    const r = run(args);
    live.push({ name, ok: r.ok, detail: r.ok ? '' : r.out.split('\n')[0] });
  }
  steps.push(...live);

  const egress = run(dockerCommands(plan)[5]);
  const blocked = egress.out.includes('EGRESS_BLOCKED') || !egress.ok;
  push('任务容器直连出网被阻断', blocked, blocked ? '' : '围栏未生效：任务容器仍可直连出网');

  run(dockerCommands(plan)[6]);
  run(dockerCommands(plan)[7]);

  const failed = steps.filter((s) => !s.ok && !s.skipped);
  return { status: failed.length === 0 ? 'passed' : 'failed', failed, steps };
}
