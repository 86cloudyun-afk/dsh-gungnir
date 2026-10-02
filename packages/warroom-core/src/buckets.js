// 执行三桶（框架 §4）——一等公民，不是文档里的名词：
//   A 容器化出口：任务在 --internal 网络里，唯一出口是 sidecar→socks（fence.js 生成拓扑）
//   B 本机执行：无容器，**出口必须为直连**（不得挂 socks），适合离线/明文内网动作
//   C 跳板侧执行：在跳板上跑，**禁止情报落盘**（只回传事实回执）
// planBucket 给"这一桶允许/禁止什么"的可判定清单；preflight 用它拦下"桶与任务不匹配"。
import { warroomError, ERR } from '../../shared-types/src/index.js';

export const BUCKETS = Object.freeze(['A', 'B', 'C']);

/**
 * @param {{bucket:'A'|'B'|'C', route?:{socks?:string, route_id?:string, jumphost_id?:string},
 *          image?:string, engagementId?:string}} p
 */
export function planBucket({ bucket, route = null, image = 'alpine:latest', engagementId = null }) {
  if (!BUCKETS.includes(bucket)) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, `未知执行桶 ${bucket}（允许：${BUCKETS.join('/')}）`);
  }
  const socks = route?.socks ?? null;

  if (bucket === 'A') {
    if (!socks) {
      throw warroomError(ERR.E_FENCE_NO_ROUTE, '桶 A 需要活跃 route 作为唯一出口（先 jump acquire）');
    }
    return {
      bucket, engagement_id: engagementId, image, upstream: socks,
      allowed: ['sidecar 代理出网', '容器内工具链', 'OOB 回连经 sidecar'],
      forbidden: ['容器直连出网', '宿主 DNS 解析', '未经 sidecar 的任意出站'],
      plan: { kind: 'container-fence', route_id: route.route_id ?? null, jumphost_id: route.jumphost_id ?? null },
      invariants: [
        '任务容器只接 --internal 网络（无默认路由）',
        'sidecar 是唯一双重连接容器（fence + 外部网络）',
        '任务容器 DNS 显式指向 sidecar，不落宿主',
      ],
    };
  }

  if (bucket === 'B') {
    if (socks) {
      throw warroomError(ERR.E_GATE_MISSING_TUPLE,
        '桶 B（本机执行）不允许经 socks 出口：它是"直连/离线"桶，要经跳板请用桶 A 或 C');
    }
    return {
      bucket, engagement_id: engagementId, image: null, upstream: null,
      allowed: ['本机工具链', '离线分析（明文产物/哈希）', '明文内网与本地回环'],
      forbidden: ['对授权外目标出网', '与其它桶混用同一出口'],
      plan: { kind: 'local' },
      invariants: [
        '不挂 socks：本机出口即真实出口（需在出口验证中体现）',
        '产物落本机 findings，随报告水位归档',
      ],
    };
  }

  // bucket C
  if (!route?.jumphost_id) {
    throw warroomError(ERR.E_NO_JUMPHOST, '桶 C 需要指定跳板（jumphost_id）：执行发生在跳板侧');
  }
  return {
    bucket, engagement_id: engagementId, image,
    upstream: socks, jumphost_id: route.jumphost_id,
    allowed: ['在跳板上执行工具链', '经跳板本地出口到目标'],
    forbidden: ['在跳板上落目标情报', '在跳板上保存凭据', '跳板间横向'],
    plan: { kind: 'jumphost-side', jumphost_id: route.jumphost_id, route_id: route.route_id ?? null },
    invariants: [
      '跳板只回传事实回执（members），产物与凭据留控制台',
      '跳板卫生：不装攻击工具以外的持久物，不存历史战果',
      '出口 = 跳板自身公网地址（等价于出口跳板）',
    ],
  };
}

/**
 * 校验一次派单用的桶与该任务是否自洽（preflight/派单前可调用）。
 * **不抛错**：把所有问题收集成 issues 返回，方便预检一次性列全。
 */
export function checkBucketForTask({ bucket, contract, route = null }) {
  const wire = (contract?.wire_cost ?? 0) > 0;
  let plan = null;
  const issues = [];
  try {
    plan = planBucket({ bucket, route });
  } catch (e) {
    issues.push(e.message);
    return { ok: false, bucket, issues, plan: null };
  }
  if (bucket === 'A' && !plan.upstream) issues.push('桶 A 无出口 route');
  if (bucket === 'B' && wire && plan.upstream) issues.push('桶 B 不允许经 socks 出口');
  if (bucket === 'C' && !plan.jumphost_id) issues.push('桶 C 未指定跳板');
  return { ok: issues.length === 0, bucket, issues, plan };
}
