// 门闸：授权对象冻结（开工指令即授权，ADR-001 D3）+ 请求 ⊆ 对象校验。
import { createHash } from 'node:crypto';
import { ACTION_CLASS, classExceeds, warroomError, ERR, validateFourTuple, validateContract } from '../../shared-types/src/index.js';

const now = () => new Date().toISOString();
export const sha = (s) => createHash('sha256').update(s).digest('hex');

/** 默认授权模板（doctrine/ 默认值；改动走 RFC）。开工指令未指定的维度按此取值。 */
export const DEFAULT_TEMPLATE = Object.freeze({
  window_hours: 72,
  allowed_means: Object.freeze(['passive', 'active']),
  action_class_limit: 'active',
  rhythm: 'restricted',
});

/**
 * 由开工指令构造冻结授权对象。host 侧调用；agent 只能引用 engagement_id。
 * @param {{user_message_id:string, targets:string[], overrides?:object}} p
 */
export function buildAuthObject(p) {
  if (!p.user_message_id) throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'user_message_id required');
  if (!Array.isArray(p.targets) || p.targets.length === 0) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'targets required');
  }
  const o = p.overrides || {};
  const obj = {
    kind: 'warroom-authorization/1',
    user_message_id: p.user_message_id,
    scope: [...p.targets],
    // 起点回拨 5s：容忍时钟偏移与同毫秒边界（不改变授权语义）
    window_start: o.window_start ?? new Date(Date.now() - 5000).toISOString(),
    window_hours: o.window_hours ?? DEFAULT_TEMPLATE.window_hours,
    allowed_means: [...(o.allowed_means ?? DEFAULT_TEMPLATE.allowed_means)],
    action_class_limit: o.action_class_limit ?? DEFAULT_TEMPLATE.action_class_limit,
    rhythm: o.rhythm ?? DEFAULT_TEMPLATE.rhythm,
    overrides_applied: Object.keys(o),
  };
  obj.window_end = o.window_end ?? new Date(Date.parse(obj.window_start) + obj.window_hours * 3600_000).toISOString();
  const auth_hash = sha(JSON.stringify(obj));
  return { auth_object: obj, auth_hash };
}

/** IPv4 点分 → uint32；非法返回 null。 */
function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4 || p.some((x) => x === '' || !/^\d+$/.test(x) || +x > 255)) return null;
  return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
}

/**
 * 目标是否落在单个 scope 条目内：精确 / IPv4 CIDR / 尾部通配（标签边界）。
 *
 * 尾部通配按**点分隔的标签边界**匹配，只向子域方向展开，绝不跨边界吞附加后缀：
 * `app.example.com*` 命中 `app.example.com`（自身）与其子域 `x.app.example.com`，
 * 但拒绝后缀欺骗 `app.example.com.attacker.com` 与 `app.example.community`。
 * 裸 `*` 不授予全域（fail-closed）。IP 段请用 CIDR（如 `10.0.0.0/24`），不用八位组通配。
 */
export function inScopeEntry(target, entry) {
  if (target === entry) return true;
  if (entry.includes('/')) {
    const [net, bitsRaw] = entry.split('/');
    const bits = Number(bitsRaw);
    const netInt = ipToInt(net);
    const ipInt = ipToInt(target);
    if (netInt === null || ipInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
    return ((ipInt & mask) === (netInt & mask));
  }
  if (entry.endsWith('*')) {
    let base = entry.slice(0, -1);
    if (base.endsWith('.')) base = base.slice(0, -1); // 容忍 "app.example.*" 写法，等价于其基名
    if (base === '') return false;                     // 裸 "*" 不授予全域
    // 自身，或点边界左侧展开的子域；拒绝 base 之后追加字符/标签的后缀欺骗
    return target === base || target.endsWith('.' + base);
  }
  return false;
}

/** 请求 ⊆ 冻结对象（ADR-001 D3）。返回 null 表示通过，否则抛对应错误码。 */
export function checkAgainstAuth({ auth, auth_version, nowMs, contract, manual_approval_token }) {
  if (Number(auth_version) !== Number(auth.auth_version)) {
    throw warroomError(ERR.E_GATE_AUTH_EXPIRED, `auth_version ${auth_version} != current ${auth.auth_version}`);
  }
  const t = nowMs ?? Date.now();
  if (t < Date.parse(auth.window_start) || t > Date.parse(auth.window_end)) {
    throw warroomError(ERR.E_GATE_WINDOW_CLOSED, 'outside engagement window');
  }
  for (const target of contract.targets) {
    const inScope = auth.scope.some((s) => inScopeEntry(target, s));
    if (!inScope) throw warroomError(ERR.E_GATE_OUT_OF_SCOPE, `target ${target} not in scope`, { target });
  }
  // destructive 一律人工裁决（宪法 1.4）：人工批准即授权，且优先于档位限制
  if (contract.action_class === 'destructive') {
    if (!manual_approval_token) {
      throw warroomError(ERR.E_GATE_DESTRUCTIVE_NEEDS_APPROVAL, 'destructive requires manual approval');
    }
  } else if (classExceeds(contract.action_class, auth.action_class_limit)) {
    throw warroomError(ERR.E_GATE_CLASS_EXCEEDS_LIMIT,
      `${contract.action_class} exceeds limit ${auth.action_class_limit}`);
  }
}

export { validateFourTuple, validateContract, ACTION_CLASS, ERR };
