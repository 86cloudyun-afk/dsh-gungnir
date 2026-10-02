// FakeAdapter：SPI rev2 参考实现 + 故障注入（丢回包 / 资源残留）。
// 资源可为字符串（模拟）或描述对象（process/port/container → 走**真实探针**，ADR-004 项 2）。
import { ERR, warroomError, TASK_TRANSITIONS, canTransition } from '../../../shared-types/src/index.js';
import { probeResource } from '../probes.js';

export const INSTANCE_ID = 'fake-adapter-1';

export class FakeAdapter {
  /** @param {{faults?:{loseResponse?:boolean, containerResidue?:boolean}}} opts */
  constructor({ faults = {} } = {}) {
    this.instanceId = INSTANCE_ID;
    this.faults = faults;
    this.tasks = new Map(); // command_id -> task
    this.counter = 0;
  }

  _task(command_id) {
    const t = this.tasks.get(command_id);
    if (!t) throw warroomError(ERR.E_TASK_NOT_FOUND, `fake task ${command_id} not found`);
    return t;
  }

  /**
   * 资源清单：每项带 check() 探针（confirmed_stopped 需逐项通过，ADR-003 D4）。
   * - 模拟资源（session/container 字符串）：按任务内标志位判断
   * - 真实资源（process/port/container 描述对象）：走 probes.js 的实测探针
   */
  manifestOf(taskIdOrCommand) {
    const t = [...this.tasks.values()].find(
      (x) => x.task_id === taskIdOrCommand || x.command_id === taskIdOrCommand
    );
    if (!t) return null;
    return t.manifest.map((m) => ({
      id: m.id, kind: m.kind,
      check: () => {
        if (m.probe) {
          const r = probeResource(m.probe);
          if (r.alive === null) return false;   // 未知 → 未证实（fail-closed）
          return r.alive === false;             // 停止证明：必须实测已不存在
        }
        return m.kind === 'session' ? !t.session_up : !t.container_up;
      },
    }));
  }

  dispatch(command_id, contract) {
    const existing = this.tasks.get(command_id);
    if (existing) {
      // 幂等：同 command_id 永远同一任务（ADR-003 D1）
      if (this.faults.loseResponse) throw Object.assign(new Error('lost'), { code: ERR.E_DISPATCH_LOST_RESPONSE });
      return { task_id: existing.task_id, state: existing.state };
    }
    this.counter += 1;
    const task_id = contract.task_id ?? `fake_t_${this.counter}`;
    const resList = contract.resources ?? [];
    const wantsContainer = resList.includes('container');
    // 资源清单：派发即登记（ADR-003 D4）；运行中新发现资源应增量登记
    const manifest = [
      { kind: 'session', id: `${task_id}-session` },
      ...(wantsContainer ? [{ kind: 'container', id: `${task_id}-container` }] : []),
      // 描述对象 → 真实探针资源（process/port/container）
      ...resList.filter((r) => typeof r === 'object' && r !== null).map((r, i) => ({
        kind: r.kind ?? 'process', id: r.id ?? `${task_id}-${r.kind ?? 'res'}-${i}`, probe: r,
      })),
    ];
    const task = {
      command_id, task_id, contract,
      state: 'running',
      generation: contract.generation,
      session_up: true,
      container_up: wantsContainer,
      manifest,
      members: contract.fake_members ?? [],
      receipts: [],
    };
    this.tasks.set(command_id, task);
    if (this.faults.loseResponse) {
      // 任务已建、回包丢失（ADR-003 D1 验收场景）
      throw Object.assign(new Error('lost response after accept'), { code: ERR.E_DISPATCH_LOST_RESPONSE });
    }
    return { task_id, state: task.state };
  }

  /** 重派：同一任务换代际重跑（旧代回执依旧可被 collect，但会被代际隔离拒收）。 */
  redispatch(command_id, contract, attempt) {
    const t = this.tasks.get(command_id);
    if (!t) throw warroomError(ERR.E_TASK_NOT_FOUND, `fake task ${command_id} not found`);
    t.contract = contract;
    t.generation = contract.generation;
    t.state = 'running';
    t.session_up = true;
    t.container_up = (contract.resources ?? []).includes('container');
    t.attempt = attempt;
    return { task_id: t.task_id, state: t.state };
  }

  /**
   * 再水化：跨进程恢复任务（CLI/重启后 adapter 内存态丢失时，从命令队列重建）。
   * 真实驱动同样需要这一语义（向执行层查询既有任务），见 docs/REDTEAM-BRIDGE.md。
   */
  hydrate(command_id, contract, state = 'running') {
    if (this.tasks.has(command_id)) return this.tasks.get(command_id);
    const task_id = contract.task_id ?? `fake_t_${++this.counter}`;
    const resList = contract.resources ?? [];
    const wantsContainer = resList.includes('container');
    const task = {
      command_id, task_id, contract, state,
      generation: contract.generation,
      session_up: true,
      container_up: wantsContainer,
      manifest: [
        { kind: 'session', id: `${task_id}-session` },
        ...(wantsContainer ? [{ kind: 'container', id: `${task_id}-container` }] : []),
        ...resList.filter((r) => typeof r === 'object' && r !== null).map((r, i) => ({
          kind: r.kind ?? 'process', id: r.id ?? `${task_id}-${r.kind ?? 'res'}-${i}`, probe: r,
        })),
      ],
      members: contract.fake_members ?? [],
      receipts: [],
      hydrated: true,
    };
    this.tasks.set(command_id, task);
    return task;
  }

  lookup(command_id) {
    const t = this.tasks.get(command_id);
    return t ? { task_id: t.task_id, state: t.state } : null;
  }

  status(id) {
    const t = [...this.tasks.values()].find((x) => x.task_id === id || x.command_id === id);
    return t ? { state: t.state, generation: t.generation } : null;
  }

  cancel(task_id, reason) {
    const t = [...this.tasks.values()].find((x) => x.task_id === task_id || x.command_id === task_id);
    if (!t) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${task_id} not found`);
    if (canTransition(t.state, 'cancel_requested')) t.state = 'cancel_requested';
    t.session_up = false;                        // 会话侧总是可停
    if (!this.faults.containerResidue) t.container_up = false; // 残留故障：容器停不下来
    // 真实探针资源（process/port/container 描述对象）不受账本影响：停止与否由实测决定
    t.cancel_reason = reason;
    return { state: t.state };
  }

  collect(task_id, opts = {}) {
    const t = [...this.tasks.values()].find((x) => x.task_id === task_id || x.command_id === task_id);
    if (!t) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${task_id} not found`);
    const receipt = {
      receipt_id: opts.receipt_id ?? `rcp_${t.task_id}_${t.receipts.length + 1}`,
      generation: opts.generation ?? t.generation,
      members: opts.members ?? t.members,
    };
    t.receipts.push(receipt);
    // 收执即"执行器报告完成"：任务转入终态（neverFinish 故障下保持 running，用于验证并发闸）
    if (!this.faults.neverFinish && t.state === 'running') t.state = 'done';
    return receipt;
  }

  reconcile(task_id) {
    const t = [...this.tasks.values()].find((x) => x.task_id === task_id || x.command_id === task_id);
    if (!t) throw warroomError(ERR.E_TASK_NOT_FOUND, `task ${task_id} not found`);
    const allStopped = !t.session_up && !t.container_up;
    t.state = allStopped ? 'done' : 'partial';
    return { state: t.state };
  }
}
