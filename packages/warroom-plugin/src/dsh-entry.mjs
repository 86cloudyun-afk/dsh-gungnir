// GUNGNIR 的 DSH 挂载入口（ADR-001 D1：隔离靠**挂载层**，不是提示词）。
//
// 这一层做两件事：
//   1) 把 36 个 `warroom_*` 工具注册进宿主工具注册表（原始 JSON Schema 直挂，不需要 DSL 改写）；
//   2) 在本预设作用域内**拒绝**通用执行/文件写/进程/委派工具（deny 是纵深防御；
//      真正的保证来自"预设只挂载本插件"——没有挂载就没有这些工具）。
//
// 宿主契约（dsh 0.2.0-rc.2 @deepseek-ai/dsh-tools）：
//   ctx.tools.register({ name, description, parameters: <JSON Schema>, output, execute }) -> disposer
//   ctx.tools.restrict({ deny: [...] }) -> disposer（作用域内收窄可见工具集）
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createWarroomService } from './service.js';
import { dshTools, TOOL_NAMES } from './tools.js';
import { createHostDelivery } from './host-delivery.js';
export { createHostDelivery } from './host-delivery.js';

/**
 * 作用域内要拒绝的通用工具（前缀通配在 DSH 侧不受支持，因此逐一列出）。
 *
 * 注意（真机反馈，dsh 0.2.0-rc.2）：`ctx.tools.restrict()` **只在 agent 作用域**可用——
 * 在 context 级调用会被宿主拒绝（"a context-global restriction would mask every agent"）。
 * 因此：
 *   · **主保证 = 挂载构成**（预设只挂本插件 → 内核工具根本不存在，这正是 ADR-001 D1 的语义）；
 *   · restrict 仅作纵深防御，且仅在显式开启（`config.restrictInScope`）时尝试；
 *     失败不致命，但把真实状态记进返回值（不静默）。
 */
export const DENIED_IN_SCOPE = Object.freeze([
  'bash', 'pwsh',
  'write', 'edit', 'str_replace_editor',
  'subagent', 'subagent_fork', 'subagent_control', 'list_agents',
  'workflow', 'job_list', 'job_output', 'job_kill',
]);

const json = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * 把 `warroom-tools` 的一个定义转成宿主 ToolDefinition。
 * @param {{name:string, description:string, input_schema:object, execute:(args:object)=>any}} tool
 */
export function toToolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? { type: 'object', additionalProperties: true },
    output: {
      // 工具结果都是普通 JSON（lossless）：声明宽松对象 schema，渲染为 JSON 文本
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
    },
    execute: async (args, exec) => {
      // Native dispatch must never fall into the direct-tool/CLI synchronous compatibility path.
      if (tool.name === 'warroom_execute' && !exec?.agent) {
        throw Object.assign(new Error('host parent context required; no task registered or started'),
          { code: 'E_HOST_CONTEXT_REQUIRED' });
      }
      return json(await tool.execute(args ?? {}, exec));
    },
  };
}

/** 解析家目录：显式 config > WARROOM_HOME > $DSH_HOME/warroom > ~/.warroom */
export function resolveWarroomHome(config = {}) {
  if (config.home) return config.home;
  if (process.env.WARROOM_HOME) return process.env.WARROOM_HOME;
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'warroom');
  return join(homedir(), '.warroom');
}

/**
 * 读取本预设的 allowlist 工具策略（ADR-001 D1 的隔离核心）。
 * 优先 inline `config.toolPolicy`，否则从 `config.preset`（声明文件路径）读取其 `toolPolicy`。
 * 无路径/无策略 → 返回 null（向后兼容：注册全部工具、不做门控）。
 * 显式给了 `preset` 路径却读/解析失败 → 抛 `E_PRESET_UNREADABLE`（不得静默当无策略）。
 * @param {{toolPolicy?:object, preset?:string}} [config]
 * @returns {{mode?:string, allow?:string[], deny?:string[]}|null}
 */
export function loadToolPolicy(config = {}) {
  if (config.toolPolicy && typeof config.toolPolicy === 'object') return config.toolPolicy;
  if (typeof config.preset === 'string' && config.preset) {
    let data;
    try {
      data = JSON.parse(readFileSync(config.preset, 'utf8'));
    } catch (e) {
      // 调用方显式给了路径却读/解析失败：不得静默当成"无策略"。
      // apply() 在 fail-closed 下会拒绝挂载；failClosed:false 时由调用方捕获后降级。
      const err = new Error(`warroom 预设声明文件不可读：${config.preset}（${e.message}）`);
      err.code = 'E_PRESET_UNREADABLE';
      err.cause = e;
      throw err;
    }
    return data?.toolPolicy ?? null;
  }
  return null;
}

/**
 * cordis 插件入口（预设内挂载）。
 * @param {object} ctx 宿主上下文（需要 ctx.tools）
 * @param {{home?:string, adapterKind?:string}} [config]
 */
export function apply(ctx, config = {}) {
  const home = resolveWarroomHome(config);
  const service = createWarroomService({ home, adapterKind: config.adapterKind ?? null,
    hostDelivery: createHostDelivery(ctx), autoStart: false });
  const disposers = [];
  const registered = [];

  // fail-closed 开关（默认开启，框架第 5 原则「宁拒不裸奔」）：显式传 false 才关。
  const failClosed = config.failClosed !== false;
  // 消费 allowlist 预设：以声明的 toolPolicy.allow 为单一真相源（ADR-001 D1）。
  let policy;
  try {
    policy = loadToolPolicy(config);
  } catch (e) {
    // 显式给了 preset 路径却不可读：fail-closed 拒绝；显式关闭时可降级为无策略。
    if (failClosed) throw e;
    policy = null;
  }
  // 显式给了 preset 路径、文件可读，但声明里没有 toolPolicy → 同样不得静默退回无策略。
  if (failClosed && !config.toolPolicy && typeof config.preset === 'string' && config.preset && !policy) {
    throw new Error(`warroom 预设 ${config.preset} 未提供 toolPolicy：fail-closed 拒绝挂载`);
  }
  // 显式声明了 toolPolicy，却不是合法 allowlist（allow 非数组/为空）→ 拒绝挂载。
  // 不得静默退回"注册全部工具"的无策略分支（那等于悄悄放开允许清单 → 静默降级开会）。
  if (policy && failClosed && (!Array.isArray(policy.allow) || policy.allow.length === 0)) {
    throw new Error('warroom 预设声明了 toolPolicy 但 allow 非法（需非空数组）：fail-closed 拒绝挂载');
  }
  const allow = policy && Array.isArray(policy.allow) ? new Set(policy.allow) : null;

  const registry = ctx?.tools;
  if (registry && typeof registry.register === 'function') {
    for (const tool of dshTools(service)) {
      // allowlist 门控（源头过滤）：有显式允许集时，只注册在允许集内的工具。
      if (allow && !allow.has(tool.name)) continue;
      disposers.push(registry.register(toToolDefinition(tool)));
      registered.push(tool.name);
    }
  }
  // 纵深防御（可选）：仅在显式开启时尝试收窄；宿主拒绝作用域外调用时不致命，但如实记录
  let restrictStatus = 'not-requested';
  if (config.restrictInScope === true && registry && typeof registry.restrict === 'function') {
    try {
      disposers.push(registry.restrict({ deny: [...DENIED_IN_SCOPE] }));
      restrictStatus = 'applied';
    } catch (e) {
      restrictStatus = `skipped: ${e.message}`;
      // 不抛错：挂载构成已经保证了允许清单；抛错会把整个会话拖down
      process.stderr.write(`[warroom] tools.restrict 未生效（${e.message}）；允许清单由挂载构成保证\n`);
    }
  }
  // 允许清单自检（fail-closed）：声明要求的 warroom 工具必须**全部真的注册上**。
  //
  // 这是本步（闭环⑤·fail-closed）要堵的静默降级口子：旧逻辑用 `registered.length > 0`
  // 做守卫，于是 registry 缺失 / 注册零工具时会**跳过**完整性检查，让预设"看似挂上但
  // 工具目录为空"——宿主照常开一个降级会话（裸退到 http://127.0.0.1:3080），而不是拒绝。
  //
  // 现在：只要允许清单在 force（声明了策略），期望集非空而实际缺失，就**抛错**。抛错经
  // 官方 agent-preset 契约逐级放大为"拒绝开会"：
  //   apply() throw → auditRows 判该行 failed → mountPreset 抛 → generation 记 broken
  //   → registry.retain('warroom-gungnir') 抛 agent-preset/invalid
  //   → select()（会话开会前选预设的唯一路径）reject → **拒绝进入该 warroom 会话**。
  // 即：挂载/激活失败或工具目录不达允许集，一律 fail-closed 拒绝，绝不静默降级裸奔。
  const expectWarroom = allow ? TOOL_NAMES.filter((n) => allow.has(n)) : TOOL_NAMES;
  const missing = expectWarroom.filter((n) => !registered.includes(n));
  if (allow && failClosed && missing.length > 0) {
    throw new Error(`warroom 允许清单挂载不完整（fail-closed 拒绝开会），缺失 ${missing.length} 个：${missing.join(', ')}`);
  }
  // 无策略（向后兼容）分支：仅在确有注册时校验完整性（容忍无 registry 的纯逻辑装配/单元测试）。
  if (!allow && registered.length > 0 && missing.length > 0) {
    throw new Error(`warroom 挂载不完整，缺失：${missing.join(', ')}`);
  }
  if (allow && registered.length > 0) {
    const extra = registered.filter((n) => n.startsWith('warroom_') && !allow.has(n));
    if (extra.length > 0) throw new Error(`warroom 注册了不在允许清单内的工具（fail-closed 拒绝开会）：${extra.join(', ')}`);
  }

  // 工具门控（纵深防御）：把**继承面**（host/祖先层）收窄到允许集——
  // 丢弃一切不在 allow 内的继承工具（内核 exec/文件写/进程/委派等）。
  // 本插件 own-layer 注册的 warroom_* 不受 restrict 影响（宿主语义：restrict 只过滤继承面）。
  let gateStatus = allow ? 'allowlist' : 'no-policy';
  if (allow && registry && typeof registry.restrict === 'function' && typeof registry.view === 'function') {
    try {
      const inherited = registry.view().restrictableNames ?? new Set();
      const deny = [...inherited].filter((n) => !allow.has(n) && n !== 'run_code');
      if (deny.length > 0) { disposers.push(registry.restrict({ deny })); gateStatus = `restricted:${deny.length}`; }
      else gateStatus = 'allowlist:no-inherited-violation';
    } catch (e) {
      gateStatus = `restrict-skipped: ${e.message}`;
      process.stderr.write(`[warroom] toolPolicy 门控（restrict）未生效（${e.message}）；允许清单由源头过滤 + 挂载构成保证\n`);
    }
  }

  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', async () => {
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* 卸载失败不阻断 */ }
      }
      try { await service.dispose(); } catch { /* 同上 */ }
    });
  }
  // 预设内服务必须发布在 **isolate realm**，否则泄漏进 root realm：
  // agent-preset 注册表的 leakedServices 检查会拒挂整条预设
  // （list() broken="Preset services require isolate realms: warroom"、retain() 抛 agent-preset/invalid）。
  // cordis 正确写法：ctx.isolate(name) 派生一个把该服务名隔离到私有 realm 的子上下文，再在其上 provide。
  if (typeof ctx?.isolate === 'function' && typeof ctx?.provide === 'function') {
    disposers.push(ctx.isolate('warroom').provide('warroom', service));
  }

  service.tasks?.start();
  return { ...service, registered, restrictStatus, gateStatus, failClosed, allowlistSize: allow ? allow.size : null };
}

export const name = 'warroom-gungnir';
export const inject = ['tools'];
export default { name, inject, apply };
