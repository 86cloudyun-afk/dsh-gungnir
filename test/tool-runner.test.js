// 真实工具执行器：出口纪律（fail-closed）、角色命令计划、输出解析、失败不伪造事实。
// 全离线：用 PATH 里的假工具替换真工具，绝不接触网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planCommands, parseDomains, parseAssets, parseFindings, runJob } from '../executors/tool-runner.mjs';

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
    await assert.rejects(() => runJob(jobFor('recon', 'target.example.com')), /拒绝执行：目标是外部地址但未提供出口/);
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

test('未实装角色：明确拒绝，不猜不造', async () => {
  await assert.rejects(() => runJob(jobFor('exploit', '10.0.0.5')), /未实装/);
  await assert.rejects(() => runJob(jobFor('internal', '10.0.0.5')), /未实装/);
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

test('命令行形态：CLI 读 stdin → stdout 回执；未实装角色非零退出', () => {
  process.env.GUNGNIR_ALLOW_DIRECT = '1';
  process.env.PATH = `${fakeTools()}:${process.env.PATH}`;
  try {
    const out = execFileSync('node', ['executors/tool-runner.mjs'],
      { input: JSON.stringify(jobFor('recon', '10.0.0.5')), encoding: 'utf8',
        env: { ...process.env, GUNGNIR_ARTIFACT_DIR: mkdtempSync(join(tmpdir(), 'wr-art5-')) } });
    const receipt = JSON.parse(out);
    assert.ok(Array.isArray(receipt.members) && receipt.members.length >= 3);

    let code = 0;
    try {
      execFileSync('node', ['executors/tool-runner.mjs'],
        { input: JSON.stringify(jobFor('exploit', '10.0.0.5')), encoding: 'utf8', stdio: 'pipe' });
    } catch (e) { code = e.status; }
    assert.equal(code, 4, '未实装角色必须非零退出（fail-closed）');
  } finally { delete process.env.GUNGNIR_ALLOW_DIRECT; }
});

test('计划是纯函数：域名/URL 都能取到目标', () => {
  assert.equal(planCommands('recon', ['https://a.example.test/path']).commands[0].cmd.includes('a.example.test'), true);
  assert.equal(planCommands('recon', []).commands.length, 0);
  assert.deepEqual(parseDomains('x.example.test\n\n# comment\n', 't').length, 1);
  assert.equal(parseAssets('{"url":"https://z.test"}').length, 1);
  assert.equal(parseFindings('not json').length, 0);
});
