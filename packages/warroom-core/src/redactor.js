// 脱敏器：非依赖模块（redactor 供 secrets/broker/report 共用）。
// 两层：① 已知秘密明文精确替换（按长度降序，避免子串残留）② 常见密钥形态正则。

export const PATTERNS = Object.freeze([
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { name: 'kv-secret', re: /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?([^\s"',;]{6,})/gi },
]);

/**
 * @param {string} text
 * @param {Array<{secret_ref:string,label:string,value:string}>} values 已知明文注册表
 */
export function redact(text, values = []) {
  if (text === undefined || text === null) return text;
  let out = String(text);
  // ① 精确替换（长优先）
  const sorted = [...values].sort((a, b) => b.value.length - a.value.length);
  for (const v of sorted) {
    if (!v.value) continue;
    out = out.split(v.value).join(`[REDACTED:${v.label}]`);
  }
  // ② 形态正则
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, (m, g1) => (g1 ? `${g1}=[REDACTED:${name}]` : `[REDACTED:${name}]`));
  }
  return out;
}

/** 深度脱敏：对象/数组/字符串全遍历（用于 collect 结果与报告导出）。 */
export function redactDeep(value, values = []) {
  if (typeof value === 'string') return redact(value, values);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, values));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, values);
    return out;
  }
  return value;
}

/** 分析专用：秘密与已有脱敏标记只留下分隔空格，不把 vault label/替代词送入关键词判定。 */
export function redactForAnalysis(text, values = []) {
  let out = String(text ?? '');
  // label 可含 ]：先按注册表中和完整标记，不能让首个 ] 后的风险词残留。
  const markers = values.map((v) => `[REDACTED:${v.label}]`).sort((a, b) => b.length - a.length);
  for (const marker of markers) out = out.split(marker).join(' ');
  for (const v of [...values].sort((a, b) => b.value.length - a.value.length)) {
    if (v.value) out = out.split(v.value).join(' ');
  }
  for (const { re } of PATTERNS) out = out.replace(re, ' ');
  return out.replace(/\[REDACTED(?::[^\]]*)?\]/gi, ' ');
}
