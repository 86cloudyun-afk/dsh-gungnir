// 真实执行层接入点（ADR-004 项 4）：
//   把 job 交给 DSH 侧的红队模式插件服务（或任何等价执行器），再把结果映射成桥回执。
//
// 配置方式（env）：
//   GUNGNIR_EXECUTOR_CMD="/path/to/executor --json"   执行器命令（读取 stdin 的 job JSON，输出回执 JSON）
// 输出格式（stdout，JSON）：
//   { "generation":"...", "members": [...], "resources": [{"id":"…","kind":"session|container|process|port","stopped":false}] }
//   实际停止证明可含源确认的 stop_request_id；缺确认保持 unresolved，适配层不得代填。
//
// 设计约束（fail-closed）：未配置 = 明确失败，绝不返回"看起来成功"的假回执；
// 执行器崩溃/输出非法 → 抛错，主控侧表现为任务 unknown/unresolved，而不是完成。
import { execFile } from 'node:child_process';
import { parseCmdline } from './parse-cmdline.mjs';
import { assertSuccessfulExecutorResult } from './executor-receipt.mjs';

function runCommand(cmdline, job, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = parseCmdline(cmdline, 'GUNGNIR_EXECUTOR_CMD');
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`executor 执行失败（exit=${err.code ?? 'unknown'}, killed=${Boolean(err.killed)}, signal=${err.signal ?? 'none'}）：${err.message}; stderr=${stderr?.slice(0, 500)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`executor 输出不是合法 JSON：${e.message}; stdout=${stdout?.slice(0, 300)}`));
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

export default {
  name: 'dsh-redteam',
  async run(job) {
    const cmdline = process.env.GUNGNIR_EXECUTOR_CMD;
    if (!cmdline) {
      throw new Error('未配置 GUNGNIR_EXECUTOR_CMD：拒绝伪造回执（fail-closed）');
    }
    const out = await runCommand(cmdline, job);
    // Do not erase an explicit capability/incomplete report while normalizing arrays.
    assertSuccessfulExecutorResult(out);
    if (!out || !Array.isArray(out.members)) throw new Error('executor 回执缺少 members 数组');
    if (typeof out.generation !== 'string' || out.generation !== job.contract?.generation) {
      throw new Error('executor 回执 source generation 不匹配或缺失');
    }
    return {
      generation: out.generation,
      ...(out.stop_request_id === undefined ? {} : { stop_request_id: out.stop_request_id }),
      ...(out.external_id === undefined ? {} : { external_id: out.external_id }),
      members: out.members,
      resources: out.resources,
    };
  },
};
