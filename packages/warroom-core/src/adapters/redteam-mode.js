// redteam-mode adapter（v0.1 唯一真实执行层）：SPI rev2 → DSH 红队模式五角色。
// 本文件提供 Driver 接口 + LocalDriver（契约测试用，纯内存）。
// 真实驱动（经 DSH 插件服务派单）见 docs/REDTEAM-BRIDGE.md；驱动换实现，adapter 与事实库无感。
import { ERR, warroomError } from '../../../shared-types/src/index.js';

/** 五角色流水线（对应红队模式 recon/assess/vuln-scan/exploit/internal）。 */
export const ROLES = Object.freeze(['recon', 'assess', 'vuln', 'exploit', 'internal']);

/**
 * Driver 接口（真实实现由 DSH host 侧提供）：
 *   spawnRole(role, contract) -> { external_id, state }
 *   stopRole(externalId, reason)
 *   statusOf(externalId) -> { state }
 *   collectFacts(externalId) -> members[]
 *   probes(externalId) -> [{ id, kind, check() }]
 * 本地驱动用于契约测试与离线演练。
 */
export class LocalRedteamDriver {
  constructor() {
    this.runs = new Map();
    this.seq = 0;
  }
  spawnRole(role, contract) {
    this.seq += 1;
    const external_id = `rt-${this.seq}`;
    this.runs.set(external_id, {
      role, contract, state: 'running', session_up: true,
      container_up: (contract.resources ?? []).includes('container'),
    });
    return { external_id, state: 'running' };
  }
  stopRole(externalId) {
    const r = this.runs.get(externalId);
    if (!r) return { state: 'unknown' };
    r.session_up = false;
    r.container_up = false;
    r.state = 'cancel_requested';
    return { state: r.state };
  }
  statusOf(externalId) {
    const r = this.runs.get(externalId);
    return r ? { state: r.state } : null;
  }
  collectFacts(externalId) {
    const r = this.runs.get(externalId);
    return r ? (r.contract.fake_members ?? []) : [];
  }
  probes(externalId) {
    const r = this.runs.get(externalId);
    if (!r) return [];
    const list = [{ id: `${externalId}-session`, kind: 'session', check: () => !r.session_up }];
    if (r.container_up !== undefined) {
      list.push({ id: `${externalId}-container`, kind: 'container', check: () => !r.container_up });
    }
    return list;
  }
}

export class RedteamModeAdapter {
  /**
   * @param {{driver:object, roleByIntent?:object}} opts
   *   roleByIntent：按 contract.intent 选择角色（默认 assess）
   */
  constructor({ driver, roleByIntent } = {}) {
    if (!driver) throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'RedteamModeAdapter 需要 driver');
    this.instanceId = 'redteam-mode';
    this.driver = driver;
    this.roleByIntent = roleByIntent ?? {};
    this.commands = new Map(); // command_id -> { task_id, external_id, generation, contract }
    this.supportsRedispatch = false;
  }

  dispatch(command_id, contract) {
    const existing = this.commands.get(command_id);
    if (existing) return { task_id: existing.task_id, state: this.driver.statusOf(existing.external_id)?.state ?? 'running' };
    const role = this.roleByIntent[contract.intent] ?? 'assess';
    if (!ROLES.includes(role)) throw warroomError(ERR.E_GATE_MISSING_TUPLE, `未知角色 ${role}`);
    const { external_id, state } = this.driver.spawnRole(role, contract);
    const rec = { task_id: contract.task_id, external_id, generation: contract.generation, contract, role };
    this.commands.set(command_id, rec);
    return { task_id: rec.task_id, state };
  }

  _byTask(taskIdOrCommandId) {
    for (const [command_id, rec] of this.commands) {
      if (rec.task_id === taskIdOrCommandId || command_id === taskIdOrCommandId) return { command_id, ...rec };
    }
    throw warroomError(ERR.E_TASK_NOT_FOUND, `redteam 任务 ${taskIdOrCommandId} 不存在`);
  }

  lookup(command_id) {
    const rec = this.commands.get(command_id);
    return rec ? { task_id: rec.task_id, state: this.driver.statusOf(rec.external_id)?.state ?? null } : null;
  }

  status(taskIdOrCommandId) {
    const rec = this._byTask(taskIdOrCommandId);
    const st = this.driver.statusOf(rec.external_id);
    return st ? { state: st.state, generation: rec.generation, role: rec.role } : null;
  }

  /**
   * 资源清单（ADR-003 D4「逐项停止证明」）：
   * 宿主侧知道自己**申请了哪些资源**（契约里的 resources），应答器只提供**实测状态**。
   * 因此清单 = 契约资源 ∪ 应答器回报的资源；应答器尚未回报时按 **未证实（check=false）** 处理，
   * 绝不因为"没收到回报"就当作已停止（fail-closed）。
   */
  manifestOf(taskIdOrCommandId) {
    const rec = this._byTask(taskIdOrCommandId);
    const reported = this.driver.probes(rec.external_id) ?? [];
    const byId = new Map(reported.map((p) => [p.id, p]));
    const declared = [];
    for (const r of rec.contract?.resources ?? []) {
      const spec = typeof r === 'string' ? { r, kind: r } : { r, ...r };
      const id = spec.id ?? `${rec.external_id}-${spec.kind ?? 'resource'}`;
      declared.push({
        id,
        kind: spec.kind ?? 'resource',
        // 延迟绑定：每次调用都重读应答器实测状态（fail-closed，但不会"一次 false 永远 false"）
        check: byId.get(id)?.check ?? (() => {
          const now = (this.driver.probes(rec.external_id) ?? []).find((x) => x.id === id);
          return now ? now.check() : false;
        }),
      });
    }
    // 应答器回报但契约未声明的（执行层自行创建的资源）也要出现在清单里
    for (const p of reported) {
      if (!declared.some((d) => d.id === p.id)) declared.push({ id: p.id, kind: p.kind, check: p.check });
    }
    return declared;
  }

  cancel(taskIdOrCommandId, reason) {
    const rec = this._byTask(taskIdOrCommandId);
    return this.driver.stopRole(rec.external_id, reason);
  }

  collect(taskIdOrCommandId, opts = {}) {
    const rec = this._byTask(taskIdOrCommandId);
    const members = this.driver.collectFacts(rec.external_id);
    return {
      receipt_id: opts.receipt_id ?? `rt-rcp-${rec.external_id}`,
      generation: opts.generation ?? rec.generation,
      members: opts.members ?? members,
    };
  }

  reconcile(taskIdOrCommandId) {
    const rec = this._byTask(taskIdOrCommandId);
    const stopped = this.driver.probes(rec.external_id).every((p) => p.check());
    const state = stopped ? 'done' : 'partial';
    return { state };
  }
}
