// Host-only durable ownership/outbox. Model arguments never supply parent identity.
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
