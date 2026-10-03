#!/usr/bin/env node
// 示例：**DSH 侧执行器命令**（把 job 转成对红队模式插件服务的一次调用）。
//
// 定位：这是 `GUNGNIR_EXECUTOR_CMD` 的落点——指挥层发出 job，本脚本负责在你的 DSH 环境里
// 真正派单（调红队模式五角色服务 / 起一个 DSH 会话 / 派给人），再把结果转成桥回执。
//
// 配置：
//   GUNGNIR_DSH_TOOL_CMD="<你的派单命令>"   # 例：dsh tool redteam_dispatch --role {role} --targets {targets}
//   先解析可信配置的 argv，再在各参数内替换 {role} {targets} {intent} {action_class} {external_id}。
//   可执行文件不能有占位符；任务字段只是字面参数数据，不重新分词、不经过 shell。
//   命令需向 stdout 输出 JSON：
//     { "members": [...], "resources": [{ "id": "...", "kind": "session|container|process|port", "stopped": false }] }
//
// 未配置 → 明确失败（fail-closed）：绝不返回"看起来成功"的空回执。
import { execFile } from 'node:child_process';
import { parseCmdline } from './parse-cmdline.mjs';

const placeholders = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const parameter = (value, field) => {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`job 参数 ${field} 必须为不含 NUL 的字符串`);
  }
  return value;
};

const fill = (tpl, job) => {
  const [cmd, ...args] = parseCmdline(tpl, 'GUNGNIR_DSH_TOOL_CMD');
  if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(cmd)) {
    throw new Error('GUNGNIR_DSH_TOOL_CMD 可执行文件不能包含占位符');
  }
  if (!isObject(job) || (job.contract != null && !isObject(job.contract))) {
    throw new Error('job 与 contract 必须为对象');
  }
  const contract = job.contract ?? {};
  const targets = contract.targets ?? [];
  if (!Array.isArray(targets)) throw new Error('job 参数 targets 必须为字符串列表');
  const values = {
    role: parameter(job.role ?? 'recon', 'role'),
    intent: parameter(contract.intent ?? job.role ?? 'recon', 'intent'),
    action_class: parameter(contract.action_class ?? 'readonly', 'action_class'),
    targets: targets.map((value) => parameter(value, 'targets')).join(','),
    external_id: parameter(job.external_id ?? '', 'external_id'),
  };
  return [cmd, ...args.map((arg) => arg.replace(placeholders, (_match, field) => {
    if (!Object.hasOwn(values, field)) throw new Error('GUNGNIR_DSH_TOOL_CMD 含不支持的占位符');
    return values[field];
  }))];
};

const runCmd = ([cmd, ...args], timeoutMs = 180000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    // err.message can include the entire argv; child output can echo task data.
    if (err) return reject(new Error(`派单命令失败：exit=${err.code}; signal=${err.signal ?? 'none'}; killed=${Boolean(err.killed)}`));
    try { resolve(JSON.parse(stdout)); }
    catch { reject(new Error('派单命令输出非 JSON')); }
  });
});

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', async () => {
  let job;
  try { job = JSON.parse(buf); } catch {
    process.stderr.write('job JSON 解析失败\n');
    process.exit(2);
  }
  const tpl = process.env.GUNGNIR_DSH_TOOL_CMD;
  if (!tpl) {
    process.stderr.write('未配置 GUNGNIR_DSH_TOOL_CMD：拒绝伪造回执（fail-closed）\n');
    process.exit(3);
  }
  try {
    const out = await runCmd(fill(tpl, job));
    const receipt = {
      members: Array.isArray(out.members) ? out.members : [],
      resources: Array.isArray(out.resources) ? out.resources
        : [{ id: `${job.external_id}-session`, kind: 'session', stopped: false }],
    };
    process.stdout.write(JSON.stringify(receipt));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(4);
  }
});
