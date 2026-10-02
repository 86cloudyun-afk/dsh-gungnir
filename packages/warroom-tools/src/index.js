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
      properties: {
        engagement_id: { type: 'string' }, entity_type: { type: 'string' }, source_id: { type: 'string' },
        since: { type: 'string' }, include_history: { type: 'boolean' },
        adapter_instance: { type: 'string' }, limit: { type: 'integer' },
      },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => {
      const { store } = core.broker._eng(args.engagement_id);
      return store.queryFacts({
        entityType: args.entity_type ?? null, sourceId: args.source_id ?? null,
        since: args.since ?? null, includeHistory: args.include_history ?? false,
        adapterInstance: args.adapter_instance ?? null, limit: args.limit ?? 500,
      });
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
      properties: {
        engagement_id: { type: 'string' }, out_dir: { type: 'string' },
        format: { type: 'string', enum: ['md', 'json', 'both'] },
        max_facts_per_type: { type: 'integer' },
      },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.exportReport(args.engagement_id, {
      outDir: args.out_dir, format: args.format ?? 'md', maxFactsPerType: args.max_facts_per_type ?? 50,
    }),
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
  {
    name: 'warroom_shell_status',
    description: 'shell 状态三字段：历史最高证明 / 当前有效性 / 最后验证时间',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' } },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.shell(args.engagement_id) ?? {
      highest_proof: null, current_validity: 'unknown', last_verified_at: null,
    },
  },
  {
    name: 'warroom_shell_verify',
    description: '记录 shell 历史最高证明或再验证当前有效性（当前可控性不得由历史默认继承）',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        proof: { type: 'string' },
        validity: { type: 'string', enum: ['unknown', 'likely', 'confirmed_lost'] },
        evidence_ref: { type: 'string' },
      },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => {
      if (args.proof) return core.broker.recordShellProof(args.engagement_id, { proof: args.proof, evidence_ref: args.evidence_ref });
      if (args.validity) return core.broker.verifyShell(args.engagement_id, { validity: args.validity, evidence_ref: args.evidence_ref });
      throw Object.assign(new Error('需要 proof 或 validity'), { code: 'E_GATE_MISSING_TUPLE' });
    },
  },
  {
    name: 'warroom_spray_check',
    description: '喷洒前查断点：该(凭据×服务×账号)是否已试过、账号是否已锁定',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' }, credential_ref: { type: 'string' },
        service: { type: 'string' }, account: { type: 'string' },
      },
      required: ['engagement_id', 'credential_ref', 'service', 'account'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.sprayCheck(args.engagement_id, args),
  },
  {
    name: 'warroom_spray_record',
    description: '登记一次喷洒结果（success/fail/locked/skipped）；锁定后拒绝继续（防锁死）',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' }, credential_ref: { type: 'string' },
        service: { type: 'string' }, account: { type: 'string' },
        result: { type: 'string', enum: ['success', 'fail', 'locked', 'skipped'] },
      },
      required: ['engagement_id', 'credential_ref', 'service', 'account', 'result'],
      additionalProperties: false,
    },
    run: (core, args) => {
      const { engagement_id, ...rest } = args;
      return core.broker.sprayRecord(engagement_id, rest);
    },
  },
  {
    name: 'warroom_metrics',
    description: '效率遥测：记录任务级 tokens/耗时/有效产出，或查询战役聚合（无成本门闸）',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' }, command_id: { type: 'string' },
        tokens_in: { type: 'integer' }, tokens_out: { type: 'integer' },
        wall_time_ms: { type: 'integer' }, verified_facts: { type: 'integer' },
        role: { type: 'string' }, model_tier: { type: 'string' },
      },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => {
      const { engagement_id, command_id, ...rest } = args;
      if (!command_id) return core.broker.metrics(engagement_id);
      return core.broker.recordMetrics(engagement_id, command_id, rest);
    },
  },
  {
    name: 'warroom_poc_search',
    description: '知识库检索（跨战役复用）：按关键词/归类查 POC，打 Nday 前先查库',
    input_schema: {
      type: 'object',
      // 全部参数可选（纯查询）：用 additionalProperties:true，避免空 required 的非法形态
      properties: { q: { type: 'string' }, category: { type: 'string' } },
      additionalProperties: true,
    },
    run: (core, args) => core.broker.knowledge.search(args),
  },
  {
    name: 'warroom_poc_add',
    description: '回填 POC 到知识库（默认强制脱敏：内网地址/自有痕迹一律拒绝）',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' },
        source: { type: 'string' }, affected_versions: { type: 'string' },
        evidence_ref: { type: 'string' }, body: { type: 'string' },
      },
      required: ['code', 'title', 'category'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.knowledge.addPoc(args),
  },
  {
    name: 'warroom_poc_use',
    description: '登记 POC 在某战役某资产上的使用（跨战役复用留痕）',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string' }, engagement_id: { type: 'string' },
        asset: { type: 'string' }, result: { type: 'string' },
      },
      required: ['code', 'engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.knowledge.use(args.code, args),
  },
  {
    name: 'warroom_sweep_timeouts',
    description: '超时治理：运行超阈值的任务转 unknown（绝不自动重试，交由 reconcile 定论）',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' }, timeout_min: { type: 'integer' } },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.sweepTimeouts(args.engagement_id, {
      timeoutMs: (args.timeout_min ?? 30) * 60 * 1000,
    }),
  },
  {
    name: 'warroom_evidence_export',
    description: '证据落盘：报告 + 水位 + 三段式 EVIDENCE_INDEX（凭据仅引用，无明文）',
    input_schema: {
      type: 'object',
      properties: { engagement_id: { type: 'string' }, out_dir: { type: 'string' }, target: { type: 'string' } },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => core.broker.exportEvidence(args.engagement_id, { outDir: args.out_dir, target: args.target }),
  },
  {
    name: 'warroom_spray_matrix',
    description: '凭据喷洒矩阵：展开 凭据×服务×账号，标注断点/锁定并给出可执行格子',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        credentials: { type: 'array', items: { type: 'string' } },
        services: { type: 'array', items: { type: 'string' } },
        accounts: { type: 'array', items: { type: 'string' } },
      },
      required: ['engagement_id', 'credentials', 'services'],
      additionalProperties: false,
    },
    run: (core, args) => {
      const { engagement_id, ...rest } = args;
      return core.broker.sprayMatrix(engagement_id, rest);
    },
  },
  {
    name: 'warroom_audit',
    description: '审计查询/导出：门闸每次判定（allow/deny/meeting/settle/timeout…）可查可交',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' }, decision: { type: 'string' },
        since: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        export_dir: { type: 'string' }, export_format: { type: 'string', enum: ['jsonl', 'csv'] },
      },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => {
      const { engagement_id, export_dir, export_format, ...opts } = args;
      if (export_dir) {
        return export_format === 'csv'
          ? core.broker.auditExportCsv(engagement_id, { outDir: export_dir, decision: opts.decision, since: opts.since })
          : core.broker.auditExport(engagement_id, { outDir: export_dir });
      }
      return core.broker.audit(engagement_id, opts);
    },
  },
  {
    name: 'warroom_jumps',
    description: '跳板台账：主机/租约/路由总览，或收口动作（release route / sweep 到期租约）',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        action: { type: 'string', enum: ['status', 'release', 'sweep'] },
        route_id: { type: 'string' },
      },
      required: ['engagement_id'],
      additionalProperties: false,
    },
    run: (core, args) => {
      const action = args.action ?? 'status';
      if (action === 'release') return core.jumps.releaseRoute({ route_id: args.route_id, engagementId: args.engagement_id });
      if (action === 'sweep') return { swept: core.jumps.sweepExpired() };
      return core.jumps.status(args.engagement_id);
    },
  },
  {
    name: 'warroom_secret_rotate',
    description: '轮换秘密库密钥：旧密钥归档（600）并重加密全部秘密；旧秘密仍可解',
    input_schema: {
      type: 'object',
      properties: { confirm: { type: 'boolean' } },
      required: ['confirm'],
      additionalProperties: false,
    },
    run: (core, args) => {
      if (args.confirm !== true) {
        throw Object.assign(new Error('轮换属于高风险动作：需 confirm=true'), { code: 'E_GATE_MISSING_TUPLE' });
      }
      return core.broker.secrets.rotateKey();
    },
  },
];

export { ERR };
