// 再水化：把非终态命令在 adapter 侧重建（跨进程 / 重启后恢复执行层视角）。
// 真实驱动同样需要这一语义：向执行层查询"既有任务现在什么样"，而不是重新派发（ADR-003 D1）。
export const OPEN_STATES = Object.freeze([
  'queued', 'running', 'cancel_requested', 'unknown', 'unresolved',
]);

/**
 * @param {object} broker
 * @param {object} [adapter] 默认用 broker.adapter
 * @returns {{hydrated:number, drifted:number}}
 */
export function rehydrate(broker, adapter = broker.adapter) {
  if (typeof adapter.hydrate !== 'function') return { hydrated: 0, drifted: 0 };
  const placeholders = OPEN_STATES.map(() => '?').join(',');
  const rows = broker.global
    .prepare(`SELECT command_id, contract, state FROM command_queue WHERE state IN (${placeholders})`)
    .all(...OPEN_STATES);
  let hydrated = 0;
  let drifted = 0;
  for (const r of rows) {
    const contract = JSON.parse(r.contract);
    const task = adapter.hydrate(r.command_id, contract, r.state);
    hydrated += 1;
    // 漂移：adapter 侧与账本状态不一致 → 交由 reconcile 定论，这里只计数
    const st = adapter.status(task?.task_id ?? contract.task_id);
    if (st && st.state !== r.state) drifted += 1;
  }
  return { hydrated, drifted };
}
