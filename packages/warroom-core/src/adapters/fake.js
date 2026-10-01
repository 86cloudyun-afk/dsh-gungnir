// FakeAdapter：SPI rev2 参考实现 + 故障注入（丢回包 / 资源残留）。
// 真实契约与真实宿主调用另行验证（框架 §10）。
import { ERR, warroomError, TASK_TRANSITIONS, canTransition } from '../../../shared-types/src/index.js';

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

  /** 资源清单：每项带 check() 探针（confirmed_stopped 需逐项通过，ADR-003 D4）。 */
  manifestOf(taskIdOrCommand) {
    const t = [...this.tasks.values()].find(
      (x) => x.task_id === taskIdOrCommand || x.command_id === taskIdOrCommand
    );
    if (!t) return null;
    return t.manifest.map((m) => ({
      id: m.id, kind: m.kind,
      check: () => (m.kind === 'session' ? !t.session_up : !t.container_up),
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
    const wantsContainer = (contract.resources ?? []).includes('container');
    // 资源清单：派发即登记（ADR-003 D4）；运行中新发现资源应增量登记
    const manifest = [
      { kind: 'session', id: `${task_id}-session` },
      ...(wantsContainer ? [{ kind: 'container', id: `${task_id}-container` }] : []),
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
