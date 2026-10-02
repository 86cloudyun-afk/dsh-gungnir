// 参考执行器：按 contract 生成回执（彩排/契约测试用）。
export default {
  name: 'echo',
  async run(job) {
    const c = job.contract ?? {};
    const members = (c.fake_members ?? []).map((m) => ({
      entity_type: m.entity_type, source_id: m.source_id, revision_no: m.revision_no,
      content_hash: m.content_hash, payload: m.payload ?? {},
    }));
    const resources = [
      { id: `${job.external_id}-session`, kind: 'session', stopped: false },
      ...((c.resources ?? []).includes('container') ? [{ id: `${job.external_id}-container`, kind: 'container', stopped: false }] : []),
    ];
    return { members, resources };
  },
};
