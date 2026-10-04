// 修复建议（客户版报告的最后一块）：优先用事实里自带的逐条修复说明；
// 没有就按**类型/关键词**给通用建议——并且**明确标注这是通用建议**，不冒充逐条结论。
const GENERIC = [
  { match: /sqli|注入/i, advice: '参数化查询/预编译语句；对输入做类型与长度校验；数据库账号最小权限' },
  { match: /xss|跨站/i, advice: '输出编码 + 内容安全策略（CSP）；富文本白名单过滤' },
  { match: /ssrf/i, advice: '出站白名单；禁用不必要的 URL 方案（file/gopher）；云元数据接口加鉴权' },
  { match: /deserial|反序列/i, advice: '禁用不安全反序列化；升级组件到修复版本；对输入做类型白名单' },
  { match: /upload|上传/i, advice: '扩展名与 MIME 双白名单；上传目录不可执行；随机化文件名' },
  { match: /unauth|未授权|越权|idor/i, advice: '服务端逐请求鉴权；对象级授权校验；避免仅靠前端隐藏' },
  { match: /weak|弱口令|默认口令|凭据/i, advice: '强制口令策略与多因素；禁用出厂默认凭据；限制登录失败次数' },
  { match: /credential|泄露|leak/i, advice: '轮换已泄露凭据；密钥入密钥库；清理历史快照与错误回显' },
  { match: /traversal|目录穿越|lfi/i, advice: '路径规范化与白名单；禁止拼接用户输入到文件路径' },
  { match: /rce|命令执行|命令注入/i, advice: '避免拼接命令；使用参数数组调用；最小权限运行' },
  { match: /privesc|提权/i, advice: '收敛 SUID/capability；修补内核与计划任务权限；最小权限服务账号' },
];

/**
 * @param {Array} facts 有效事实（内部 source_id 保持原值；payload 已解析为对象）
 * @param {object} opts textForMatching 只控制通用建议关键词输入，逐条说明与引用保留原形
 * @returns {{items:Array<{ref:string, source:string, advice:string, generic:boolean}>, generic_count:number}}
 */
export function buildRemediation(facts = [], { textForMatching = (f) => `${f.source_id} ${JSON.stringify(f.payload ?? {})}` } = {}) {
  const items = [];
  for (const f of facts) {
    if (!['vuln', 'credential', 'chain'].includes(f.entity_type)) continue;
    const payload = typeof f.payload === 'object' && f.payload !== null ? f.payload : {};
    const explicit = payload.remediation ?? payload.fix ?? payload.advice ?? null;
    if (typeof explicit === 'string' && explicit.trim()) {
      items.push({ ref: f.source_id, source: '事实自带修复说明', advice: explicit.trim(), generic: false });
      continue;
    }
    const haystack = textForMatching(f);
    const hit = GENERIC.find((g) => g.match.test(haystack));
    items.push({
      ref: f.source_id,
      source: '按类型通用建议',
      advice: hit ? hit.advice : '（无匹配的通用建议）按最小权限与补丁管理基线处置，并复核该组件的已知漏洞',
      generic: true,
    });
  }
  return { items, generic_count: items.filter((i) => i.generic).length };
}
