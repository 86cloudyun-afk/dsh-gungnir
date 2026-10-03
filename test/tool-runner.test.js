// 真实工具执行器：出口纪律（fail-closed）、角色命令计划、输出解析、失败不伪造事实。
// 全离线：用 PATH 里的假工具替换真工具，绝不接触网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  planCommands, parseDomains, parseAssets, parseFindings, parseHttp, parseEvidence, artifactMember,
  runJob, runTool, CAPABILITIES, capabilityOf,
} from '../executors/tool-runner.mjs';

function fakeTools() {
  const dir = mkdtempSync(join(tmpdir(), 'wr-fake-tools-'));
  const mk = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); return p; };
  mk('subfinder', 'echo a.example.test; echo b.example.test; echo "not a domain"');
  mk('httpx', 'echo "https://a.example.test [200] Welcome"; echo \'{"url":"https://b.example.test","status_code":403,"title":"nope","tech":["nginx"]}\'');
  mk('nuclei', 'echo \'{"template-id":"CVE-2026-0001","matched-at":"https://a.example.test/x","info":{"severity":"high","name":"demo"}}\'');
  return dir;
}

const jobFor = (role, target) => ({
  protocol: 'gungnir-bridge/1', external_id: `t-${role}`, role,
  contract: { targets: [target], intent: role, action_class: 'active' },
});

test('出口纪律：外部目标没有代理 → 拒绝执行（fail-closed）', async () => {
  const prev = process.env.GUNGNIR_EXIT_SOCKS; const prevDirect = process.env.GUNGNIR_ALLOW_DIRECT;
  delete process.env.GUNGNIR_EXIT_SOCKS; delete process.env.GUNGNIR_ALLOW_DIRECT;
  try {
    await assert.rejects(() => runJob(jobFor('recon', 'target.example.com')), /拒绝执行：目标是外部地址/);
  } finally {
    if (prev) process.env.GUNGNIR_EXIT_SOCKS = prev;
    if (prevDirect) process.env.GUNGNIR_ALLOW_DIRECT = prevDirect;
  }
});

test('本地/实验室目标：显式 GUNGNIR_ALLOW_DIRECT=1 才放行；未提供代理则不加代理变量', async () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  process.env.PATH = `${fakeTools()}:${process.env.PATH}`;
  try {
    const out = await runJob(jobFor('recon', '10.0.0.5'), { artifactDir: mkdtempSync(join(tmpdir(), 'wr-art-')) });
    assert.equal(out._debug.exit, 'direct-local');
  } finally { delete process.env.GUNGNIR_ALLOW_DIRECT; }
});

test('recon：subfinder + httpx 产出 domain/asset 成员，且原文落盘', async () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  process.env.PATH = `${fakeTools()}:${process.env.PATH}`;
  const art = mkdtempSync(join(tmpdir(), 'wr-art2-'));
  try {
    const out = await runJob(jobFor('recon', '10.0.0.5'), { artifactDir: art });
    const kinds = out.members.map((m) => m.entity_type);
    assert.ok(kinds.includes('domain') && kinds.includes('asset'), `应有 domain+asset，实得 ${kinds.join(',')}`);
    assert.equal(out.members.filter((m) => m.entity_type === 'domain').length, 2, '非法域名行不该入库');
    assert.ok(out.members.every((m) => m.source_id && m.content_hash && m.revision_no === 1), '成员必须带幂等三件套');
    assert.ok(existsSync(join(art, 'subfinder.stdout.txt')), '原始输出必须落盘');
    assert.equal(out.resources[0].stopped, true, '进程类资源要如实标记已停止');
  } finally { delete process.env.GUNGNIR_ALLOW_DIRECT; }
});

test('assess：nuclei 产出 vuln 成员（带 severity/matched_at）', async () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  process.env.PATH = `${fakeTools()}:${process.env.PATH}`;
  try {
    const out = await runJob(jobFor('assess', '10.0.0.5'), { artifactDir: mkdtempSync(join(tmpdir(), 'wr-art3-')) });
    const v = out.members.find((m) => m.entity_type === 'vuln');
    assert.ok(v, '必须产出 vuln');
    assert.equal(v.payload.severity, 'high');
    assert.match(v.source_id, /CVE-2026-0001@https:\/\/a\.example\.test\/x/);
  } finally { delete process.env.GUNGNIR_ALLOW_DIRECT; }
});

test('角色缺契约字段：精确报缺（不是"未实装"空话）', async () => {
  await assert.rejects(() => runJob(jobFor('exploit', '10.0.0.5')), /contract\.command|contract\.argv/);
  await assert.rejects(() => runJob(jobFor('internal', '10.0.0.5')), /contract\.command|contract\.argv/);
  await assert.rejects(() => runJob(jobFor('chain', '10.0.0.5')), /contract\.steps|contract\.command/);
});

test('工具失败 → 抛错（主控记 unknown），绝不返回安慰性事实', async () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  const dir = mkdtempSync(join(tmpdir(), 'wr-fail-tools-'));
  const p = join(dir, 'subfinder'); writeFileSync(p, '#!/bin/bash\necho boom >&2; exit 3\n'); chmodSync(p, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  try {
    await assert.rejects(() => runJob(jobFor('recon', '10.0.0.5'), { artifactDir: mkdtempSync(join(tmpdir(), 'wr-art4-')) }),
      /工具 subfinder 执行失败（exit=3/);
  } finally { delete process.env.GUNGNIR_ALLOW_DIRECT; }
});

test('命令行形态：CLI 读 stdin → stdout 回执；exec 无命令 → 非零退出', () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  process.env.PATH = `${fakeTools()}:${process.env.PATH}`;
  try {
    const out = execFileSync('node', ['executors/tool-runner.mjs'],
      { input: JSON.stringify(jobFor('recon', '10.0.0.5')), encoding: 'utf8',
        env: { ...process.env, GUNGNIR_ARTIFACT_DIR: mkdtempSync(join(tmpdir(), 'wr-art5-')) } });
    const receipt = JSON.parse(out);
    assert.ok(Array.isArray(receipt.members) && receipt.members.length >= 3);

    let code = 0;
    let stderr = '';
    try {
      execFileSync('node', ['executors/tool-runner.mjs'],
        { input: JSON.stringify(jobFor('exploit', '10.0.0.5')), encoding: 'utf8', stdio: 'pipe' });
    } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 4, '缺契约字段必须非零退出（fail-closed）');
    assert.match(stderr, /contract\.command|contract\.argv/, '报错要说清缺哪个字段');
  } finally { delete process.env.GUNGNIR_ALLOW_DIRECT; }
});

test('计划是纯函数：域名/URL 都能取到目标', () => {
  assert.equal(planCommands('recon', ['https://a.example.test/path']).commands[0].cmd.includes('a.example.test'), true);
  assert.equal(planCommands('recon', []).commands.length, 0);
  assert.deepEqual(parseDomains('x.example.test\n\n# comment\n', 't').length, 1);
  assert.equal(parseAssets('{"url":"https://z.test"}').length, 1);
  assert.equal(parseFindings('not json').length, 0);
});

test('动作对齐：http_get 只发一次请求（不按角色猜成扫描）', () => {
  const plan = planCommands('assess', ['t.example'], { action: 'http_get', url: 'https://t.example/login' });
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0].tool, 'http_get');
  assert.match(plan.commands[0].cmd, /curl -sS -i -m 20/);
  assert.match(plan.commands[0].cmd, /https:\/\/t\.example\/login/);
  assert.equal(plan.requests, 1, '只看一眼 = 1 个请求');
});

test('动作对齐：exec 全实装 —— contract.command 直接成计划（不再"未实装"）', () => {
  const plan = planCommands('assess', ['t.example'], { action: 'exec', command: 'id; uname -a' });
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0].cmd, 'id; uname -a');
  assert.equal(plan.commands[0].artifact, true, '操作员命令必须留 artifact 事实');
  assert.equal(plan.commands[0].strict, false, '非零退出是被派命令的真实结果，不算执行层故障');
});

test('动作对齐：exec 缺命令 → 精确报缺字段（可诊断，不是空话）', () => {
  const plan = planCommands('assess', ['t.example'], { action: 'exec' });
  assert.equal(plan.commands.length, 0);
  assert.match(plan.reason, /contract\.command/);
  assert.match(plan.reason, /contract\.argv/);
});

test('argv 形态：按参数边界拼壳（空格路径不拆开，引号正确转义）', () => {
  const plan = planCommands('recon', [], { action: 'exec', argv: ['/opt/my tools/run.sh', '--x', "a b'c"] });
  assert.equal(plan.commands[0].cmd, `'/opt/my tools/run.sh' --x 'a b'\\''c'`);
});

test('动作对齐：role=assess 但 action 是别的 → 不默认跑 nuclei，且列出全量能力面', () => {
  const plan = planCommands('assess', ['t.example'], { action: 'whatever' });
  assert.equal(plan.commands.length, 0, '无法识别的动作必须拒绝，而不是退化成扫描');
  assert.match(plan.reason, /无法识别/);
  for (const k of Object.keys(CAPABILITIES)) assert.match(plan.reason, new RegExp(k), `能力面缺 ${k}`);
});

test('能力面配齐：文档承诺的动作 == 注册表动作（双向），元数据齐备', () => {
  const doc = readFileSync('presets/roles/commander.md', 'utf8');
  const documented = [...doc.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.ok(documented.length >= 8, `commander.md 可派动作表太少：${documented.join(',')}`);
  assert.deepEqual([...documented].sort(), Object.keys(CAPABILITIES).sort(),
    '文档承诺的动作与执行层注册表必须一一对应（配齐，不多不少）');
  for (const [k, v] of Object.entries(CAPABILITIES)) {
    assert.ok(v.tier && v.note && v.requires.length > 0 && v.produces.length > 0, `${k} 缺能力元数据`);
  }
  assert.equal(capabilityOf('shell'), 'exec', '别名必须解析到同一能力');
  assert.equal(capabilityOf('assess'), 'nuclei_scan');
  assert.equal(capabilityOf('nope'), null);
});

test('能力面现查：--capabilities 输出机器可读清单', () => {
  const snap = JSON.parse(execFileSync('node', ['executors/tool-runner.mjs', '--capabilities'], { encoding: 'utf8' }));
  assert.equal(snap.protocol, 'gungnir-executor/1');
  assert.deepEqual(Object.keys(snap.actions).sort(), Object.keys(CAPABILITIES).sort());
  assert.match(snap.evidence_protocol, /GUNGNIR_MEMBER:/);
  assert.ok(snap.limits.max_steps >= 1);
});

test('chain 多跳：contract.steps 顺序成计划，步内失败即整单拒绝', () => {
  const plan = planCommands('chain', ['10.0.0.5'], {
    action: 'chain',
    steps: [{ action: 'exec', command: 'id' }, { action: 'exec', command: 'whoami' }],
  });
  assert.equal(plan.commands.length, 2);
  assert.match(plan.commands[0].id, /^step1\.1\./);
  assert.match(plan.commands[1].id, /^step2\.1\./);
  assert.equal(plan.commands[0].cmd, 'id');

  const bad = planCommands('chain', ['10.0.0.5'], { action: 'chain', steps: [{ action: 'exploit' }] });
  assert.equal(bad.commands.length, 0);
  assert.match(bad.reason, /chain\.steps\[0\]/);
  assert.match(bad.reason, /contract\.command/);
});

test('chain 步数上限：超过 MAX_STEPS 直接拒绝（不让一次派单变成无界批处理）', () => {
  const steps = Array.from({ length: 13 }, () => ({ action: 'exec', command: 'id' }));
  const plan = planCommands('chain', ['10.0.0.5'], { action: 'chain', steps });
  assert.equal(plan.commands.length, 0);
  assert.match(plan.reason, /最多 12 步/);
});

test('证据协议：GUNGNIR_MEMBER 行原样入库，非法行忽略（不猜）', () => {
  const raw = [
    'noise line',
    'GUNGNIR_MEMBER: {"entity_type":"credential","source_id":"cred:10.0.0.5:root","payload":{"user":"root"}}',
    'GUNGNIR_MEMBER: not json',
    'GUNGNIR_MEMBER: {"entity_type":"alien","source_id":"x"}',
    'GUNGNIR_MEMBER: {"entity_type":"session","payload":{}}',
  ].join('\n');
  const members = parseEvidence(raw);
  assert.equal(members.length, 1);
  assert.equal(members[0].entity_type, 'credential');
  assert.match(members[0].content_hash, /^sha256:[0-9a-f]{64}$/, '缺 content_hash 时按内容补，保证幂等键完整');
});

test('exec 端到端：非零退出也如实入账（artifact 事实 + 退出码），超时才抛', async () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  const art = mkdtempSync(join(tmpdir(), 'wr-exec-'));
  const cmd = `echo ok; echo 'GUNGNIR_MEMBER: {"entity_type":"session","source_id":"exec-smoke","payload":{"via":"command"}}'; exit 7`;
  try {
    const out = await runJob({ ...jobFor('recon', '10.0.0.5'), role: 'recon',
      contract: { targets: [], action: 'exec', command: cmd, action_class: 'active' } }, { artifactDir: art });
    const art_ = out.members.find((m) => m.entity_type === 'artifact');
    assert.ok(art_, '操作员命令必须留下 artifact 事实');
    assert.equal(art_.payload.exit, 7, '退出码要如实入账');
    assert.equal(art_.payload.timed_out, false);
    assert.ok(existsSync(join(art, 'exec.stdout.txt')), '原始输出必须落盘');
    assert.equal(out.members.find((m) => m.entity_type === 'session')?.source_id, 'exec-smoke');
  } finally { delete process.env.GUNGNIR_ALLOW_DIRECT; }
});

test('回执带 generation/external_id：文档那条接线（桥 → dsh-redteam-executor → tool-runner）真能落地', async () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  const art = mkdtempSync(join(tmpdir(), 'wr-wire-'));
  const prevCmd = process.env.GUNGNIR_EXECUTOR_CMD;
  const prevArt = process.env.GUNGNIR_ARTIFACT_DIR;
  process.env.GUNGNIR_EXECUTOR_CMD = `${process.execPath} executors/tool-runner.mjs`;
  process.env.GUNGNIR_ARTIFACT_DIR = art;
  try {
    const plugin = (await import('../executors/dsh-redteam-executor.mjs')).default;
    const receipt = await plugin.run({
      protocol: 'gungnir-bridge/1', external_id: 'wire-1', role: 'recon',
      contract: { targets: [], action: 'exec', action_class: 'active', generation: '7:7:7', command: 'echo wired' },
    });
    assert.equal(receipt.generation, '7:7:7', '回执必须回带契约代际（否则插件层整单退 exit=4）');
    assert.ok(Array.isArray(receipt.members) && receipt.members.some((m) => m.entity_type === 'artifact'));
    assert.equal(receipt.resources[0].stopped, true);
  } finally {
    if (prevCmd === undefined) delete process.env.GUNGNIR_EXECUTOR_CMD; else process.env.GUNGNIR_EXECUTOR_CMD = prevCmd;
    if (prevArt === undefined) delete process.env.GUNGNIR_ARTIFACT_DIR; else process.env.GUNGNIR_ARTIFACT_DIR = prevArt;
    delete process.env.GUNGNIR_ALLOW_DIRECT;
  }
});

test('超时与信号杀都不算成功：证据不完整即抛错（不写"跑过且无异常"的假事实）', async () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  const art = () => mkdtempSync(join(tmpdir(), 'wr-kill-'));
  try {
    await assert.rejects(() => runJob({
      protocol: 'gungnir-bridge/1', external_id: 'k1', role: 'recon',
      contract: { targets: [], action: 'exec', action_class: 'active', command: 'sleep 5', timeout_ms: 300 },
    }, { artifactDir: art() }), /命令超时|证据不完整/);

    await assert.rejects(() => runJob({
      protocol: 'gungnir-bridge/1', external_id: 'k2', role: 'recon',
      contract: { targets: [], action: 'exec', action_class: 'active', command: 'kill -9 $$' },
    }, { artifactDir: art() }), /信号终止|证据不完整/);
  } finally { delete process.env.GUNGNIR_ALLOW_DIRECT; }
});

test('artifact 幂等键不变式：同命令同输出稳定；输出变了就是新事实', () => {
  const base = { id: 'exec', action: 'exec', cmd: 'id', exit: 0, stderr: '', artifactDir: '/tmp/a' };
  const a = artifactMember({ ...base, stdout: 'uid=0\n' });
  const b = artifactMember({ ...base, stdout: 'uid=0\n' });
  const c = artifactMember({ ...base, stdout: 'uid=1000\n' });
  assert.equal(a.source_id, b.source_id, '同命令同输出必须幂等（否则每次派单都造重复事实）');
  assert.equal(a.content_hash, b.content_hash);
  assert.notEqual(a.source_id, c.source_id, '输出不同必须是两条事实（不许互相覆盖）');
});

test('出口纪律覆盖 url 与 chain 步内目标（不只 targets）——否则 url 是直连旁路', async () => {
  const prev = { socks: process.env.GUNGNIR_EXIT_SOCKS, direct: process.env.GUNGNIR_ALLOW_DIRECT };
  delete process.env.GUNGNIR_EXIT_SOCKS; delete process.env.GUNGNIR_ALLOW_DIRECT;
  try {
    // targets 是本地，url 指向外网 → 必须拒绝（真机踩过：url 一路直连出去）
    await assert.rejects(() => runJob({
      protocol: 'gungnir-bridge/1', external_id: 'e1', role: 'recon',
      contract: { targets: ['10.0.0.5'], action: 'http_get', url: 'https://outside.example.test/x', action_class: 'readonly' },
    }), /拒绝执行：目标是外部地址（outside\.example\.test）/);

    // chain 步内 targets 指向外网 → 同样拒绝
    await assert.rejects(() => runJob({
      protocol: 'gungnir-bridge/1', external_id: 'e2', role: 'chain',
      contract: { targets: [], action: 'chain', action_class: 'active', steps: [{ action: 'exec', targets: ['203.0.113.9'], command: 'id' }] },
    }), /拒绝执行：目标是外部地址（203\.0\.113\.9）/);
  } finally {
    if (prev.socks) process.env.GUNGNIR_EXIT_SOCKS = prev.socks;
    if (prev.direct) process.env.GUNGNIR_ALLOW_DIRECT = prev.direct;
  }
});

test('证据协议：自报 hash 与键序都不得改变幂等键（同一条证据两次入库必须同 hash）', () => {
  const line = (payload, hash) => `GUNGNIR_MEMBER: ${JSON.stringify({ entity_type: 'credential', source_id: 'c1', payload, ...(hash ? { content_hash: hash } : {}) })}`;
  const one = parseEvidence(line({ user: 'root', pass_ref: 'ref-1' }));
  const two = parseEvidence(line({ pass_ref: 'ref-1', user: 'root' }));
  const three = parseEvidence(line({ user: 'root', pass_ref: 'ref-1' }, 'sha256:deadbeef'));
  assert.equal(one.length, 1);
  assert.equal(one[0].content_hash, two[0].content_hash, '键序不同必须得到同一个 hash（否则进 conflict_review 被隔离）');
  assert.equal(one[0].content_hash, three[0].content_hash, '自报 hash 不得覆盖本地重算值');
});

test('vuln 选择器：按 token 引号拼装，不裸拼、不折叠引号内空白', () => {
  const plan = planCommands('vuln', ['10.0.0.5'], {
    action: 'vuln', severity: 'critical', template: 'http/cves/2017/ x.yaml', tags: 'cve, log4j',
  });
  assert.equal(plan.commands.length, 1);
  assert.match(plan.commands[0].cmd, /-t 'http\/cves\/2017\/ x\.yaml'/, '模板路径必须整体引号包裹（空格不被折叠）');
  assert.match(plan.commands[0].cmd, /-tags 'cve, log4j'/);
  assert.match(plan.commands[0].cmd, /-severity critical/);
  const bad = planCommands('vuln', ['10.0.0.5'], { action: 'vuln', severity: ' , ' });
  assert.equal(bad.commands.length, 0, '空的 severity 不该退化成"扫全部"');
});

test('chain 上界按展开后的命令数：步内多命令也算数', () => {
  const steps = Array.from({ length: 12 }, () => ({ action: 'recon', targets: ['10.0.0.5'] })); // 每步 2 条命令
  const plan = planCommands('chain', ['10.0.0.5'], { action: 'chain', steps });
  assert.equal(plan.commands.length, 0);
  assert.match(plan.reason, /展开后共 24 条命令/);
});

test('操作员命令只走显式证据协议：契约里的 parse 不得把 exec 输出解析成 asset/vuln', () => {
  const plan = planCommands('recon', [], { action: 'exec', command: 'echo x', parse: 'findings' });
  assert.equal(plan.commands[0].parse, 'evidence');
});

test('能力面文档无冲突标记：角色提示词必须是可直接投喂的成品', () => {
  const doc = readFileSync('presets/roles/commander.md', 'utf8');
  assert.doesNotMatch(doc, /^(<<<<<<<|=======|>>>>>>>)/m, '角色提示词里残留了合并冲突标记');
});

test('http_get 解析：状态码/标题/Server/跳转/耗时进事实', () => {
  const raw = [
    'HTTP/1.1 200 OK', 'Server: nginx/1.25', 'X-Powered-By: Express', 'Set-Cookie: session=x; Path=/',
    '', '<html><head><title>登录 - 门户</title></head>', '', '__CURL__200 1234 0.42',
  ].join('\n');
  const members = parseHttp(raw);
  assert.equal(members.length, 1);
  const p = members[0].payload;
  assert.equal(p.status, 200);
  assert.equal(p.title, '登录 - 门户');
  assert.equal(p.server, 'nginx/1.25');
  assert.equal(p.powered_by, 'Express');
  assert.equal(p.set_cookie_name, 'session');
  assert.equal(p.size, 1234);
});

test('执行器失败必须可诊断：包装层带上 killed/exit 与输出尾部', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-wrap-'));
  const ex = join(dir, 'boom.mjs');
  writeFileSync(ex, `process.stderr.write('具体原因: 工具没装\\n'); process.exit(9);`);
  // 用当前解释器路径，避免硬编码 /usr/local/bin/node（nvm/云盒上不存在 → ENOENT 假失败）
  process.env.GUNGNIR_EXECUTOR_CMD = `${process.execPath} ${ex}`;
  try {
    const mod = await import('../executors/dsh-redteam-executor.mjs');
    await assert.rejects(() => mod.default.run({ external_id: 'x', role: 'recon', contract: { targets: ['t'] } }),
      (e) => /exit=9/.test(e.message) && /具体原因/.test(e.message));
  } finally { delete process.env.GUNGNIR_EXECUTOR_CMD; }
});

test('curl 必须显式 -x（只靠 ALL_PROXY 会 CONNECT 后失败）+ 子进程环境里不许残留代理变量', () => {
  const withExit = planCommands('assess', ['t.example'], { action: 'http_get', url: 'https://t.example/login', exit: 'socks5h://127.0.0.1:21071' });
  assert.match(withExit.commands[0].cmd, /-x socks5h:\/\/127\.0\.0\.1:21071/, '必须显式带 -x');

  // runTool 清代理变量：注入一个「会打印代理环境」的假命令
  const dir = mkdtempSync(join(tmpdir(), 'wr-env-'));
  const probe = join(dir, 'env.sh');
  writeFileSync(probe, 'echo "HTTP_PROXY=${HTTP_PROXY:-none} ALL_PROXY=${ALL_PROXY:-none}"');
  const prev = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://127.0.0.1:18780';      // 模拟本机环境代理在场
  try {
    const r = runTool(`bash ${probe}`, { artifactDir: mkdtempSync(join(tmpdir(), 'wr-art6-')), id: 'env', timeoutMs: 20000 });
    assert.match(r.stdout, /HTTP_PROXY=none/, '子进程里不得残留本机代理变量（否则静默回落本机出口）');
    assert.match(r.stdout, /ALL_PROXY=none/);
  } finally {
    if (prev === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = prev;
  }
});
