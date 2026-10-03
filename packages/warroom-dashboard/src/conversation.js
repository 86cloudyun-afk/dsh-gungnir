import { redact } from '../../warroom-core/src/redactor.js';

const MAX_MESSAGES = 200;
const MAX_TEXT = 4000;

export function redactText(value) {
  const text = redact(String(value ?? '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return text.slice(0, MAX_TEXT);
}

export function normalizeConversationMessages(messages, snapshot) {
  const nodes = new Set(snapshot.nodes.map((node) => node.id));
  const routes = new Set(snapshot.routes.map((route) => route.route_id));
  const tasks = new Set(snapshot.tasks.map((task) => task.task_id));
  const sourceNodes = new Map();
  for (const node of snapshot.nodes) {
    const values = sourceNodes.get(node.source_id) || [];
    values.push(node.id); sourceNodes.set(node.source_id, values);
  }
  const normalized = messages.slice(0, MAX_MESSAGES).flatMap((message, index) => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.id !== 'string') return [];
    const nodeIds = new Set();
    for (const ref of Array.isArray(message.node_ids) ? message.node_ids : []) {
      if (typeof ref !== 'string') continue;
      if (nodes.has(ref)) nodeIds.add(ref);
      else {
        const matches = sourceNodes.get(ref) || [];
        if (matches.length === 1) nodeIds.add(matches[0]);
      }
    }
    const routeIds = cleanIds(message.route_ids, routes);
    const taskIds = cleanIds(message.task_ids, tasks);
    const rawText = String(message.text ?? '');
    const text = redactText(rawText);
    const exactToken = (value) => new RegExp(`(^|[^A-Za-z0-9._:-])${escapeRegExp(value)}(?=$|[^A-Za-z0-9._:-])`).test(text);
    for (const node of snapshot.nodes) if (exactToken(node.id)) nodeIds.add(node.id);
    for (const [sourceId, matches] of sourceNodes) if (matches.length === 1 && exactToken(sourceId)) nodeIds.add(matches[0]);
    for (const routeId of routes) if (exactToken(routeId)) routeIds.push(routeId);
    for (const taskId of tasks) if (exactToken(taskId)) taskIds.push(taskId);
    const uniqueRouteIds = [...new Set(routeIds)];
    const uniqueTaskIds = [...new Set(taskIds)];
    return [{ id: message.id.slice(0, 160) || `message-${index}`, role: message.role, text, created_at: safeTime(message.created_at), node_ids: [...nodeIds], route_ids: uniqueRouteIds, task_ids: uniqueTaskIds, text_truncated: redact(String(message.text ?? '')).length > MAX_TEXT }];
  });
  return {
    messages: normalized.map(({ text_truncated, ...message }) => message),
    total_count: messages.length,
    truncated: messages.length > MAX_MESSAGES || normalized.some((message) => message.text_truncated),
    text_truncated_count: normalized.filter((message) => message.text_truncated).length,
  };
}

export function parseDshPageRecords(records, snapshot) {
  const messages = [];
  for (const record of records) {
    if (record?.type !== 'event' || !record.event || typeof record.event !== 'object') continue;
    const event = record.event;
    const data = event.data;
    if (event.type === 'user/message' && data?.role === 'user' && data.source?.kind === 'user') {
      messages.push({ id: data.id || `user-${event.seq}`, role: 'user', text: textContent(data.content), created_at: event.time });
    } else if (event.type === 'assistant/message' && data?.message?.role === 'assistant' && data.message.source?.kind === 'model') {
      messages.push({ id: data.message.id || `assistant-${event.seq}`, role: 'assistant', text: textContent(data.message.content), created_at: event.time });
    }
  }
  return normalizeConversationMessages(messages, snapshot);
}

export function textContent(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

function cleanIds(values, allowed) { return [...new Set((Array.isArray(values) ? values : []).filter((id) => typeof id === 'string' && allowed.has(id)))]; }
function safeTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  return typeof value === 'string' && value.length < 80 ? value : null;
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
