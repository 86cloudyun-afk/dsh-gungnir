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
        contract: { type: 'object', additionalProperties: true },
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
      properties: { engagement_id: { type: 'string' }, task_id: { type: 'string' }, receipt: { type: 'object', additionalProperties: true } },
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
  {
    name: 'warroom_secret_put',
    description: '登记秘密（host 加密 at-rest 存储）；返回 secret_ref，agent 永不见明文',
    input_schema: {
      type: 'object',
      properties: { plaintext: { type: 'string' }, label: { type: 'string' } },
      required: ['plaintext'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.secrets.put(args.plaintext, { label: args.label ?? 'secret' }),
  },
  {
    name: 'warroom_secret_grant',
    description: '为（secret × 任务 × 用途）签发限时解析授权；解析本身只能由 host 执行',
    input_schema: {
      type: 'object',
      properties: {
        secret_ref: { type: 'string' },
        engagement_id: { type: 'string' },
        task_id: { type: 'string' },
        purpose: { type: 'string' },
        ttl_seconds: { type: 'integer' },
      },
      required: ['secret_ref', 'task_id', 'purpose'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.secrets.grant(args.secret_ref, {
      engagement_id: args.engagement_id, task_id: args.task_id,
      purpose: args.purpose, ttlSeconds: args.ttl_seconds ?? 300,
    }),
  },
  {
    name: 'warroom_secret_status',
    description: '秘密与授权的元数据视图（仅 ref/label/TTL，绝不含明文）',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' } },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => {
      const secrets = core.broker.global
        .prepare('SELECT secret_ref, label, created_at FROM secret_store').all();
      const grants = core.broker.global
        .prepare('SELECT grant_id, secret_ref, task_id, purpose, expires_at FROM secret_grants WHERE engagement_id = ?')
        .all(args.engagement_id);
      return { secrets, active_grants: grants };
    },
  },
  {
    name: 'warroom_report_export',
    description: '导出战役报告（水位绑定 + IOC/清理附录初稿，全出口脱敏）',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' }, out_dir: { type: 'string' } },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.exportReport(args.engagement_id, { outDir: args.out_dir }),
  },
  {
    name: 'warroom_status',
    description: '任务全景：账本态 / 运行态 / 资源清单探针 / 尝试次数',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' }, task_id: { type: 'string' } },
      required: ['engagement_id', 'task_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.status(args.engagement_id, args.task_id),
  },
  {
    name: 'warroom_reconcile',
    description: '对账 unknown/unresolved 任务（探针定论，绝不默认失败重做）',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' }, task_id: { type: 'string' } },
      required: ['engagement_id', 'task_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.reconcile(args.engagement_id, args.task_id),
  },
  {
    name: 'warroom_redispatch',
    description: '重派 failed/unresolved 任务（attempt+1、换 generation，旧代回执隔离）',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' }, task_id: { type: 'string' }, reason: { type: 'string' },
      },
      required: ['engagement_id', 'task_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.redispatch(args.engagement_id, args.task_id, args.reason ?? 'manual'),
  },
];

export { ERR };
