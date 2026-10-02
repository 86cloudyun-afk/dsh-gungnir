#!/usr/bin/env node
// 示例：执行器命令（DSH 侧扮演"调红队模式服务"的角色）。
// 用法（由 dsh-redteam-executor 通过 GUNGNIR_EXECUTOR_CMD 调用）：
//   GUNGNIR_EXECUTOR_CMD="node executors/example-role-cmd.mjs" node scripts/dsh-bridge-responder.mjs ...
//
// 行为（**示例语义，不接触任何目标**）：读 stdin 的 job JSON，按 role 产出一条"任务已接收"的
// 占位事实 + 会话/容器资源探针；真实实现应在此处调用红队模式插件服务派单并回收真实事实。
//
// 输出契约（stdout，JSON）：{ members: [...], resources: [{id, kind, stopped}] }
// 失败即以非零退出并写 stderr —— 主控侧会表现为 unknown/unresolved，而不是"完成"。
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  let job;
  try { job = JSON.parse(buf); } catch (e) {
    process.stderr.write(`job JSON 解析失败：${e.message}\n`);
    process.exit(2);
  }
  const role = job.role ?? job.contract?.intent ?? 'recon';
  const c = job.contract ?? {};
  const wantsContainer = (c.resources ?? []).includes('container');
  const receipt = {
    members: [{
      entity_type: role === 'chain' ? 'chain' : 'asset',
      source_id: `${job.external_id}-${role}`,
      revision_no: 1,
      content_hash: `sha256:${job.external_id}-${role}`,
      payload: {
        note: '示例执行器：占位事实（真实实现应替换为红队模式的落库记录）',
        role,
        targets: c.targets ?? [],
        action_class: c.action_class ?? null,
        generation: c.generation ?? null,
      },
    }],
    resources: [
      { id: `${job.external_id}-session`, kind: 'session', stopped: false },
      ...(wantsContainer ? [{ id: `${job.external_id}-container`, kind: 'container', stopped: false }] : []),
    ],
  };
  process.stdout.write(JSON.stringify(receipt));
});
