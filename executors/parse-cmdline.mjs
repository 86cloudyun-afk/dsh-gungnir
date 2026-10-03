// GUNGNIR_EXECUTOR_CMD / GUNGNIR_DSH_TOOL_CMD 的 argv 解析（fail-closed）。
//
// 背景：原先 `cmdline.split(' ')` 在路径含空格时会把可执行文件截断，
// 触发 ENOENT 假失败（例如 "/opt/node versions/node" → 只执行 "/opt/node"）。
// Codex 审 #165 时点出；本模块在生产侧按边界保留 argv，而不是靠测试侧别名绕开。
//
// 支持三种写法（均 fail-closed：空串 / 未闭合引号 / 非法 JSON 数组 → 抛错）：
//   1. JSON 数组（推荐有空格时用）：'["/path/with spaces/node","script.mjs"]'
//   2. 引号分词：'"/path/with spaces/node" script.mjs --flag'
//   3. 无空格纯空白分词（向后兼容）：'node script.mjs'
//
// 零依赖；executors/ 下脚本可直接 import。

/**
 * @param {string} cmdline
 * @param {string} [label='CMD']  错误信息里的配置名
 * @returns {string[]} 非空 [cmd, ...args]
 */
export function parseCmdline(cmdline, label = 'CMD') {
  const s = String(cmdline ?? '').trim();
  if (!s) throw new Error(`${label} 为空`);

  if (s.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(s);
    } catch (e) {
      throw new Error(`${label} JSON 数组非法：${e.message}`);
    }
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(`${label} JSON 数组必须为非空字符串列表`);
    }
    if (arr.some((x) => typeof x !== 'string' || x.length === 0)) {
      throw new Error(`${label} JSON 数组元素必须为非空字符串`);
    }
    return arr;
  }

  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;
    const q = s[i];
    if (q === '"' || q === "'") {
      i += 1;
      let tok = '';
      while (i < s.length && s[i] !== q) {
        // 允许 \" 与 \' 转义（保留其它反斜杠原样，避免过度解释）
        if (s[i] === '\\' && i + 1 < s.length && (s[i + 1] === q || s[i + 1] === '\\')) {
          tok += s[i + 1];
          i += 2;
          continue;
        }
        tok += s[i];
        i += 1;
      }
      if (i >= s.length) throw new Error(`${label} 引号未闭合`);
      i += 1; // closing quote
      out.push(tok);
    } else {
      let tok = '';
      while (i < s.length && !/\s/.test(s[i])) {
        tok += s[i];
        i += 1;
      }
      out.push(tok);
    }
  }

  if (!out.length || !out[0]) throw new Error(`${label} 解析后无命令`);
  return out;
}

export default parseCmdline;
