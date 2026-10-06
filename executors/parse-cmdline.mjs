// GUNGNIR_EXECUTOR_CMD / GUNGNIR_DSH_TOOL_CMD 的 argv 解析（fail-closed）。
//
// 背景：原先 `cmdline.split(' ')` 在路径含空格时会把可执行文件截断，
// 触发 ENOENT 假失败（例如 "/opt/node versions/node" → 只执行 "/opt/node"）。
// Codex 审 #165 时点出；本模块在生产侧按边界保留 argv，而不是靠测试侧别名绕开。
//
// 支持三种写法（空串 / 未闭合引号 / 非法 JSON 数组均报结构性错误，不回显数据）：
//   1. JSON 数组（推荐有空格时用）：'["/path/with spaces/node","script.mjs"]'
//   2. 引号分词：'"/path/with spaces/node" script.mjs --flag'
//   3. 无空格纯空白分词（向后兼容）：'node script.mjs'
// 引号可在词内出现，相邻 spans 合成一个参数。引号内仅反斜杠 + 当前引号转义；
// 其余反斜杠（含 UNC 前缀）原样保留。不是 shell 语法；复杂边界用 JSON argv。
//
// 零依赖；executors/ 下脚本可直接 import。

/**
 * @param {string} cmdline
 * @param {string} [label='CMD']  错误信息里的配置名
 * @returns {string[]} 非空 [cmd, ...args]
 */
export function parseCmdline(cmdline, label = 'CMD') {
  if (typeof cmdline !== 'string') throw new Error(`${label} 必须为字符串`);
  const s = cmdline.trim();
  if (!s) throw new Error(`${label} 为空`);
  if (s.includes('\0')) throw new Error(`${label} 参数不能包含 NUL`);

  if (s.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(s);
    } catch {
      throw new Error(`${label} JSON 数组非法`);
    }
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(`${label} JSON 数组必须为非空字符串列表`);
    }
    if (arr.some((x) => typeof x !== 'string' || x.length === 0)) {
      throw new Error(`${label} JSON 数组元素必须为非空字符串`);
    }
    if (!arr[0].trim()) throw new Error(`${label} 解析后无命令`);
    if (arr.some((x) => x.includes('\0'))) throw new Error(`${label} 参数不能包含 NUL`);
    return arr;
  }

  const out = [];
  let tok = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && s[i + 1] === '\\') {
        let end = i + 2;
        while (s[end] === '\\') end += 1;
        if (s[end] === quote) throw new Error(`${label} 反斜杠与引号边界有歧义，请使用 JSON 数组`);
        tok += s.slice(i, end);
        i = end - 1;
        continue;
      }
      // Only the active quote is escaped. Consecutive backslashes stay literal (UNC).
      if (ch === '\\' && s[i + 1] === quote) {
        tok += quote;
        i += 1;
      } else if (ch === quote) quote = null;
      else tok += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(tok);
      tok = '';
      started = false;
    } else {
      tok += ch;
      started = true;
    }
  }
  if (quote) throw new Error(`${label} 引号未闭合`);
  if (started) out.push(tok);
  if (!out.length || !out[0].trim()) throw new Error(`${label} 解析后无命令`);
  return out;
}

export default parseCmdline;
