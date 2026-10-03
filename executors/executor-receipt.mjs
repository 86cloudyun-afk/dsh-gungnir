// Receipt admission only: this module never discovers, installs or invokes tools.
export class ExecutorAdmissionError extends Error {
  constructor(code, message, diagnostic = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.diagnostic = { code, ...diagnostic };
  }
}

/** Check source outcome before a wrapper maps or combines receipt envelopes. */
export function assertExecutorOutcome(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ExecutorAdmissionError('E_EXECUTOR_INCOMPLETE', '执行器没有返回完成回执', { phase: 'result' });
  }
  const has = (field) => Object.hasOwn(result, field);
  if ((has('state') && result.state !== 'done') ||
      (has('status') && !['done', 'success'].includes(result.status)) ||
      (has('ok') && result.ok !== true) ||
      (has('error') && result.error !== null) ||
      (has('errors') && (!Array.isArray(result.errors) || result.errors.length > 0))) {
    throw new ExecutorAdmissionError('E_EXECUTOR_INCOMPLETE',
      '执行器报告未完成或能力失败；不得转换为成功空回执', { phase: 'result' });
  }
}

/** Legacy success has no outcome marker; its source arrays must still be complete. */
export function assertSuccessfulExecutorResult(result) {
  assertExecutorOutcome(result);
  if (!Array.isArray(result.members) || !Array.isArray(result.resources)) {
    throw new ExecutorAdmissionError('E_EXECUTOR_RECEIPT_INVALID',
      '完成回执必须包含源 members/resources 数组；不得代填', { phase: 'result' });
  }
}
