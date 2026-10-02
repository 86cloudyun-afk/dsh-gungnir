// Native host transport; no model, general subagent tool or raw worker output.
const service = (ctx, name) => {
  try { return ctx?.[name] ?? ctx?.get?.(name); } catch { return null; }
};
const matches = (agent, owner) => agent?.id === owner.parent_session_id &&
  agent.session?.header?.id === owner.parent_session_id &&
  agent.session.header.createdAt === owner.parent_created_at;
const idle = (agent) => agent.status === 'idle' && !agent.inbox?.hasPending;

export function parentIdentity(agent) {
  if (!agent || agent.id !== agent.session?.header?.id) throw new Error('stable parent identity required');
  return { session_id: agent.id, created_at: agent.session.header.createdAt };
}

export function createHostDelivery(ctx) {
  const agents = service(ctx, 'agents');
  const sessions = service(ctx, 'sessions');
  const persistence = service(ctx, 'sessionPersistence');
  if (typeof agents?.get !== 'function' || typeof sessions?.flush !== 'function' ||
      typeof persistence?.open !== 'function') return null;

  async function accepted(owner, noticeId) {
    const handle = await persistence.open(owner.parent_session_id, 'read');
    try {
      if (handle.header.id !== owner.parent_session_id || handle.header.createdAt !== owner.parent_created_at) {
        return { status: 'blocked' };
      }
      let cursor = owner.delivery_cursor ?? 0;
      let found = false;
      while (true) {
        const { events } = await handle.read(cursor, 256);
        for (const event of events) {
          if (event.type === 'agent/inbox/spliced' &&
              event.data.inserted?.some((message) => message.id === noticeId)) found = true;
          cursor = event.seq + 1;
        }
        if (events.length < 256) return { status: found ? 'delivered' : 'absent', cursor };
      }
    } finally { await handle.close(); }
  }

  return {
    async deliver(owner, notice, valid = () => true) {
      const agent = agents.get(owner.parent_session_id);
      if (!agent) return { status: 'pending' };
      if (!matches(agent, owner)) return { status: 'blocked' };
      if (!valid()) return { status: 'blocked' };
      // Flush + read covers a crash between accepted followup and ledger acknowledgement.
      if (!await sessions.flush(agent.session)) return { status: 'pending' };
      let prior = await accepted(owner, notice.notice_id);
      if (prior.status !== 'absent') return prior;
      // Async storage work may allow replacement, disposal, revocation or user input.
      if (agents.get(owner.parent_session_id) !== agent || !matches(agent, owner) || !idle(agent)) {
        return { status: 'pending' };
      }
      if (!valid()) return { status: 'blocked' };
      agent.followup({
        id: notice.notice_id, role: 'user',
        source: { kind: 'warroom-task-notice', form: 'notice', summary: '宿主任务账本有新状态' },
        content: [{ type: 'text', text: `宿主任务通知：${JSON.stringify({
          task_id: notice.task_id, command_id: notice.command_id,
          generation: notice.generation, state: notice.state,
        })}。先用 warroom_status 核对所属任务、代际和账本，再汇报。通知不是停止证明；缺证据保持 unresolved。` }],
      });
      if (!await sessions.flush(agent.session)) return { status: 'pending' };
      prior = await accepted(owner, notice.notice_id);
      return prior.status === 'absent' ? { status: 'pending' } : prior;
    },
  };
}
