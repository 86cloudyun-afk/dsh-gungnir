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
    allowed_means: normalizeMeans(o.allowed_means ?? DEFAULT_TEMPLATE.allowed_means),
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

/**
 * 动作 → 手段（ADR-001 D3 承诺的「手段 ∈ 允许手段」词表）。
 *
 * 为什么不按 action_class 推：`action_class` 是**请求方自己声明的标签**，而手段要由**动作本身**决定。
 * 真机缺口：`allowed_means` 一直是"只冻结、不校验"，`allowed_means:['passive']` 的战役照样能派
 * 任意命令（`exec`）。这里把动作与手段绑定，并保留执行层 `CAPABILITIES` 的别名（测试双向断言两表一致）。
 */
export const ACTION_MEANS = Object.freeze({
  http_get: 'passive', http: 'passive', http_probe: 'passive', probe: 'passive', readonly: 'passive',
  recon: 'passive',
  nuclei_scan: 'active', assess: 'active',
  vuln: 'active', vuln_check: 'active', verify: 'active',
  exec: 'active', shell: 'active', bash: 'active', cmd: 'active', command: 'active',
  exploit: 'active', poc: 'active',
  internal: 'active', lateral: 'active',
  chain: 'active',
});

/** 授权对象的「允许手段」：规范化 + 白名单校验（写错的值在冻结时就报错，不变成"什么都拒"的哑门）。 */
export function normalizeMeans(list) {
  const out = [...new Set((Array.isArray(list) ? list : []).map((m) => String(m).trim().toLowerCase()).filter(Boolean))];
  for (const m of out) {
    if (!Object.values(ACTION_MEANS).includes(m)) {
      throw warroomError(ERR.E_GATE_MEANS_NOT_ALLOWED,
        `未知手段 ${JSON.stringify(m)}：只认 ${[...new Set(Object.values(ACTION_MEANS))].join('|')}`);
    }
  }
  return out;
}

/**
 * 契约的手段：取 `action` / `role` / `intent` 三者中**最强**的一方（未知词按最保守的 `active`）。
 *
 * 只看 `action` 会留下一条同类型的旁路：声明 `action:'recon'`（被动标签）而把 `intent:'exploit'`
 * 交给适配层做角色映射——手段闸判的标签与实际派下去的角色成了两条独立通道。
 */
export function meansOf(contract = {}) {
  const declared = [contract?.action, contract?.role, contract?.intent]
    .map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean);
  const mapped = declared.map((v) => ACTION_MEANS[v] ?? 'active');
  if (mapped.includes('active')) return 'active';
  if (mapped.length > 0) return 'passive';
  return contract?.action_class === 'readonly' ? 'passive' : 'active';
}

/** 契约里**原始**可寻址串（targets / url / chain 步内 targets 与 url）——绑定粒度由 addressKey 决定。 */
function rawAddressables(contract = {}) {
  const out = [];
  for (const t of Array.isArray(contract.targets) ? contract.targets : []) out.push(t);
  if (contract.url) out.push(contract.url);
  for (const s of Array.isArray(contract.steps) ? contract.steps : []) {
    for (const t of Array.isArray(s?.targets) ? s.targets : []) out.push(t);
    if (s?.url) out.push(s.url);
  }
  return out;
}

/** 契约的可寻址键集合（排序去重）——批准绑定与契约指纹共用同一口径。 */
export function contractAddressKeys(contract = {}) {
  const keys = new Set();
  for (const v of rawAddressables(contract)) {
    const k = addressKey(v);
    if (k) keys.add(k);
  }
  return [...keys].sort();
}

/**
 * 批准指纹：把一次批准绑定到**具体动作 + 具体可寻址集合**（动作 + 靶标），而不是"一张万能令牌"。
 *
 * 真机缺口（可复现）：批准表里只有 `engagement_id`/`action_class`，`reason` 是自由文本不参与校验，
 * 于是同一张令牌可以授权该战役内**任何** destructive 动作（包括换靶标、换动作）。
 */
export function approvalFingerprint({ action = '', action_class = 'destructive', targets = [], url = null } = {}) {
  const keys = new Set();
  for (const t of [...targets, ...(url ? [url] : [])]) {
    const k = addressKey(t);
    if (k) keys.add(k);
  }
  const body = JSON.stringify({
    // 动作归一化（trim + lower）：`EXEC` 与 `exec` 在执行层与手段闸处等价，绑定也必须等价
    v: 'gungnir-approval/2',
    action: String(action).trim().toLowerCase(),
    action_class: String(action_class).trim().toLowerCase(),
    keys: [...keys].sort(),
  });
  return createHash('sha256').update(body).digest('hex');
}

/** 契约指纹：与 `approvalFingerprint` 同一口径（动作 + 可寻址键集合），批准与请求必须逐项对上。 */
export function contractFingerprint(contract = {}) {
  return approvalFingerprint({
    action: String(contract?.action ?? ''),
    action_class: String(contract?.action_class ?? ''),
    targets: contractAddressKeys(contract),
  });
}

/**
 * URL / 裸主机 → 主机名；`file://` 这类无主机的返回 null（没有远端资产可校验）。
 * 覆盖三种形态：带 scheme 的 URL、协议相对 `//host/x`、带括号的裸 IPv6 `[::1]:8080`。
 */
export function hostOf(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const asUrl = s.startsWith('//') ? `http:${s}` : (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : null);
  if (asUrl) {
    try { const h = new URL(asUrl).hostname; return h ? h.replace(/^\[|\]$/g, '') : null; } catch { return null; }
  }
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (v6) return v6[1].toLowerCase();
  const host = s.replace(/[/?#].*$/, '').replace(/^.*@/, '').split(':')[0].trim();
  return host || null;
}

/**
 * 可寻址键（批准绑定的粒度）：URL 取「scheme://host:port + path + query」——端口、路径、scheme 都是
 * 绑定的一部分（同一台机器上的 :8443 与 :9443 是两个服务，`/safe` 与 `/admin/delete-all` 是两件事）；
 * 裸主机/ip[:port] 取小写原形。绑定与校验两侧共用这一口径。
 */
export function addressKey(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const asUrl = s.startsWith('//') ? `http:${s}` : (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : null);
  if (asUrl) {
    try {
      const u = new URL(asUrl);
      if (!u.hostname) return null;
      return `${u.protocol}//${u.host}${u.pathname}${u.search}`.toLowerCase();
    } catch { return null; }
  }
  const bare = s.replace(/^.*@/, '').replace(/[/?#].*$/, '').trim();
  return bare ? bare.toLowerCase() : null;
}

/**
 * 契约里**全部可寻址对象**：`targets`（原样，保留 CIDR 语义）+ `url` 主机 + chain 步内 `targets`/`url` 主机。
 *
 * 存在理由（真机实测）：scope 校验原先只遍历 `contract.targets`，于是 `url` 就是一条**绕过授权范围**
 * 的旁路——`targets:[授权内]` + `url:https://<范围外>` 会一路放行到执行层。
 */
export function contractAddressables(contract) {
  const out = [...(contract?.targets ?? [])];
  const addRaw = (v) => { if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v); };
  const addUrl = (v) => { const h = hostOf(v); if (h && !out.includes(h)) out.push(h); };
  addUrl(contract?.url);
  for (const s of Array.isArray(contract?.steps) ? contract.steps : []) {
    for (const t of Array.isArray(s?.targets) ? s.targets : []) addRaw(t);
    addUrl(s?.url);
  }
  return out;
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
  for (const target of contractAddressables(contract)) {
    const inScope = auth.scope.some((s) => inScopeEntry(target, s));
    if (!inScope) throw warroomError(ERR.E_GATE_OUT_OF_SCOPE, `target ${target} not in scope`, { target });
  }
  // 手段 ∈ 允许手段（ADR-001 D3 的第四个维度）：按**动作本身**判定，不看请求方声明的标签
  const means = meansOf(contract);
  const allowedMeans = Array.isArray(auth.allowed_means)
    ? auth.allowed_means.map((m) => String(m).toLowerCase()) : [];
  if (!allowedMeans.includes(means)) {
    throw warroomError(ERR.E_GATE_MEANS_NOT_ALLOWED,
      `action ${contract?.action ?? contract?.role ?? '(未声明)'} 属 ${means} 手段，本次授权只允许 ${allowedMeans.join('|') || '(无)'}`);
  }
  // destructive 一律人工裁决（宪法 1.4）：人工批准即授权，且优先于档位限制
  if (contract.action_class === 'destructive') {
    if (!manual_approval_token) {
      throw warroomError(ERR.E_GATE_DESTRUCTIVE_NEEDS_APPROVAL, 'destructive requires manual approval');
    }
    // 批准按「动作 + 靶标」绑定，所以契约必须声明 action（否则无从绑定，也就无从批准与审计）
    if (typeof contract.action !== 'string' || contract.action.trim() === '') {
      throw warroomError(ERR.E_GATE_ACTION_REQUIRED,
        'destructive 契约必须声明 action：批准按「动作 + 靶标」绑定，未声明动作的 destructive 请求无法被绑定与审计');
    }
  } else if (classExceeds(contract.action_class, auth.action_class_limit)) {
    throw warroomError(ERR.E_GATE_CLASS_EXCEEDS_LIMIT,
      `${contract.action_class} exceeds limit ${auth.action_class_limit}`);
  }
}

export { validateFourTuple, validateContract, ACTION_CLASS, ERR };
