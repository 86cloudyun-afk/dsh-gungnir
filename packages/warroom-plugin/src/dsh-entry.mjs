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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createWarroomService } from './service.js';
import { dshTools, TOOL_NAMES } from './tools.js';

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
    execute: async (args) => json(await tool.execute(args ?? {})),
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
 * cordis 插件入口（预设内挂载）。
 * @param {object} ctx 宿主上下文（需要 ctx.tools）
 * @param {{home?:string, adapterKind?:string}} [config]
 */
export function apply(ctx, config = {}) {
  const home = resolveWarroomHome(config);
  const service = createWarroomService({ home, adapterKind: config.adapterKind ?? null });
  const disposers = [];
  const registered = [];

  const registry = ctx?.tools;
  if (registry && typeof registry.register === 'function') {
    for (const tool of dshTools(service)) {
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
  // 允许清单自检：注册数必须与声明一致（少一个就是挂载层与声明脱钩）
  const missing = TOOL_NAMES.filter((n) => !registered.includes(n));
  if (registered.length > 0 && missing.length > 0) {
    throw new Error(`warroom 允许清单挂载不完整，缺失：${missing.join(', ')}`);
  }

  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* 卸载失败不阻断 */ }
      }
      try { service.broker.global.close(); } catch { /* 同上 */ }
    });
  }
  if (typeof ctx?.provide === 'function') ctx.provide('warroom', service);

  return { ...service, registered, restrictStatus };
}

export const name = 'warroom-gungnir';
export const inject = ['tools'];
export default { name, inject, apply };
