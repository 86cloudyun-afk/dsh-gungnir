// Host-only durable ownership/outbox. Model arguments never supply parent identity.
//
// Append-only by design（审计账本）：task_notifications / task_resources 只增不删。
// 重放证据必须活得比投递确认更久（_tick 注释：Keep its replay evidence until all
// acknowledgements settle），行级自动清理会破坏"同一事件不重复通知"的不变式。
// 长期运行的归档走 SQLite 文件级备份/轮转，不要在这里加 TTL 删除。
export const TASK_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS task_owners (
  command_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL, parent_created_at INTEGER NOT NULL,
  auth_version INTEGER NOT NULL, approval_id TEXT,
  registration_ready INTEGER NOT NULL DEFAULT 0,
  dispatch_attempted INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  stop_attempted INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  delivery_cursor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_notifications (
  notice_id TEXT PRIMARY KEY, command_id TEXT NOT NULL,
  generation TEXT NOT NULL, event_seq INTEGER NOT NULL,
  state TEXT NOT NULL, delivery_state TEXT NOT NULL DEFAULT 'pending',
  detail TEXT, ts TEXT NOT NULL,
  UNIQUE(command_id, generation, event_seq)
);
CREATE TABLE IF NOT EXISTS task_resources (
  command_id TEXT NOT NULL, generation TEXT NOT NULL,
  resource_id TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY(command_id, generation, resource_id, kind)
);
CREATE TABLE IF NOT EXISTS task_cancellations (
  command_id TEXT NOT NULL, generation TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(command_id, generation)
);
`;

export function validateParent(parent) {
  if (typeof parent?.session_id !== 'string' || !parent.session_id ||
      !Number.isSafeInteger(parent.created_at) || parent.created_at < 0) {
    throw Object.assign(new Error('stable parent session identity required'), { code: 'E_PARENT_IDENTITY' });
  }
}
