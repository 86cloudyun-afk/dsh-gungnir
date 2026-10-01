// warroom-tools：agent 平面工具定义（v0.1 骨架）。
// 每个 entry = { name, description, input_schema, run(core, args) }；
// DSH 工具 schema 包裹（cordis preset 挂载）在集成波次接入（框架 §11 真实宿主适配）。
import { ERR } from '../../shared-types/src/index.js';

export const TOOLS = [
  {
    name: 'warroom_execute',
    description: '唯一副作用入口：四元组 + 契约经服务端 broker 校验后派发',
    input_schema: {
      type: 'object',
      properties: {
        command_id: { type: 'string' },
        engagement_id: { type: 'string' },
        auth_version: { type: 'integer' },
        action_class: { type: 'string', enum: ['readonly', 'active', 'destructive'] },
        contract: { type: 'object' },
        manual_approval_token: { type: 'string' },
      },
      required: ['command_id', 'engagement_id', 'auth_version', 'action_class', 'contract'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.execute(args),
  },
  {
    name: 'warroom_collect',
    description: '回执入库（成员级幂等 + 代际隔离）',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' }, task_id: { type: 'string' }, receipt: { type: 'object' } },
      required: ['engagement_id', 'task_id', 'receipt'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.collect(args.engagement_id, args.task_id, args.receipt),
  },
  {
    name: 'warroom_cancel',
    description: '请求取消（幂等）；停止由资源清单逐项探针证实',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' }, task_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['engagement_id', 'task_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.cancel(args.engagement_id, args.task_id, args.reason ?? 'manual'),
  },
  {
    name: 'warroom_fact_query',
    description: '事实查询（只读）',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' }, entity_type: { type: 'string' } },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => {
      const { store } = core.broker._eng(args.engagement_id);
      const rows = args.entity_type
        ? store.db.prepare('SELECT * FROM fact_members WHERE entity_type = ? AND active = 1').all(args.entity_type)
        : store.db.prepare('SELECT * FROM fact_members WHERE active = 1').all();
      return { count: rows.length, rows };
    },
  },
];

export { ERR };
