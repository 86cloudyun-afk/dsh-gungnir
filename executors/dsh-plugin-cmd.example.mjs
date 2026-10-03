#!/usr/bin/env node
// 示例：**DSH 侧执行器命令**（把 job 转成对红队模式插件服务的一次调用）。
//
// 定位：这是 `GUNGNIR_EXECUTOR_CMD` 的落点——指挥层发出 job，本脚本负责在你的 DSH 环境里
// 真正派单（调红队模式五角色服务 / 起一个 DSH 会话 / 派给人），再把结果转成桥回执。
//
// 配置：
//   GUNGNIR_DSH_TOOL_CMD="<你的派单命令>"   # 例：dsh tool redteam_dispatch --role {role} --targets {targets}
//   占位符 {role} {targets} {intent} {action_class} 会被本脚本替换后执行；命令需向 stdout 输出 JSON：
//     { "members": [...], "resources": [{ "id": "...", "kind": "session|container|process|port", "stopped": false }] }
//
// 未配置 → 明确失败（fail-closed）：绝不返回"看起来成功"的空回执。
import { execFile } from 'node:child_process';
import { parseCmdline } from './parse-cmdline.mjs';

const fill = (tpl, job) => tpl
  .replaceAll('{role}', job.role ?? 'recon')
  .replaceAll('{intent}', job.contract?.intent ?? job.role ?? 'recon')
  .replaceAll('{action_class}', job.contract?.action_class ?? 'readonly')
  .replaceAll('{targets}', (job.contract?.targets ?? []).join(','))
  .replaceAll('{external_id}', job.external_id ?? '');

const runCmd = (cmdline, timeoutMs = 180000) => new Promise((resolve, reject) => {
  const [cmd, ...args] = parseCmdline(cmdline, 'GUNGNIR_DSH_TOOL_CMD');
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(`派单命令失败：${err.message}; stderr=${String(stderr).slice(0, 500)}`));
    try { resolve(JSON.parse(stdout)); }
    catch (e) { reject(new Error(`派单命令输出非 JSON：${e.message}; stdout=${String(stdout).slice(0, 300)}`)); }
  });
});

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', async () => {
  let job;
  try { job = JSON.parse(buf); } catch (e) {
    process.stderr.write(`job JSON 解析失败：${e.message}\n`);
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
