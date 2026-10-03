#!/usr/bin/env node
import { startDashboardServer } from '../packages/warroom-dashboard/src/server.js';

const HELP = `GUNGNIR 对话战图（本地只读）

用法：node bin/dashboard.mjs [--home <WARROOM_HOME>] [--host 127.0.0.1] [--port <0-65535>]

未提供 --home 时展示真实空状态，不创建目录。演示数据只能在页面中主动选择。
`;

function parseArgs(args) {
  const options = { host: '127.0.0.1', port: 0 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!['--home', '--host', '--port'].includes(arg)) throw new TypeError(`未知参数：${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`${arg} 需要参数`);
    if (arg === '--home') options.home = value;
    if (arg === '--host') options.host = value;
    if (arg === '--port') {
      if (!/^\d+$/.test(value)) throw new TypeError('--port 必须是 0 到 65535 的整数');
      options.port = Number(value);
    }
  }
  if (options.port > 65535) throw new TypeError('--port 必须是 0 到 65535 的整数');
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); process.exitCode = 0; }
  else {
    const running = await startDashboardServer(options);
    process.stdout.write(`GUNGNIR 战图已启动：${running.url}\n`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try { await running.close(); process.exitCode = 0; }
      catch (error) { process.stderr.write(`关闭失败：${error.message}\n`); process.exitCode = 1; }
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.once('beforeExit', close);
  }
} catch (error) {
  process.stderr.write(`dashboard: ${error.message}\n`);
  process.stderr.write(HELP);
  process.exitCode = 2;
}
