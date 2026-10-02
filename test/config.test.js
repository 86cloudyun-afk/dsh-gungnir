// 家目录配置：默认应用、非法配置明确报错、未知字段不静默。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { loadConfig, writeExampleConfig, DEFAULT_CONFIG } from '../packages/warroom-core/src/config.js';
import { execFileSync } from 'node:child_process';

test('缺失配置 → 安全默认（不自动写文件）', () => {
  const h = harness();
  const cfg = loadConfig(h.home);
  assert.equal(cfg.rhythm, DEFAULT_CONFIG.rhythm);
  assert.equal(cfg._source, 'defaults');
});

test('配置生效：新战役默认节奏档来自配置（stealth）', async () => {
  const { Broker } = await import('../packages/warroom-core/src/broker.js');
  const h = harness();
  writeFileSync(join(h.home, 'warroom.json'), JSON.stringify({ rhythm: 'stealth', timeoutMin: 5 }));
  const broker = new Broker({ home: h.home });
  const eng = broker.createEngagement({ user_message_id: 'cfg-1', targets: ['10.0.0.0/24'] });
  assert.equal(eng.auth_object.rhythm, 'stealth', '默认节奏档应取自配置');
  assert.equal(broker.config.timeoutMin, 5);
});

test('非法配置明确报错（未知字段/类型错误），不静默忽略', () => {
  const h = harness();
  const p = join(h.home, 'warroom.json');
  writeFileSync(p, JSON.stringify({ rhythm: 'turbo' }));
  assert.throws(() => loadConfig(h.home), /rhythm 必须是/);
  writeFileSync(p, JSON.stringify({ timeoutMin: -1 }));
  assert.throws(() => loadConfig(h.home), /timeoutMin 必须是正整数/);
  writeFileSync(p, JSON.stringify({ rhythem: 'open' }));  // 拼错
  assert.throws(() => loadConfig(h.home), /未知字段：rhythem/);
  writeFileSync(p, '{ 不是 JSON');
  assert.throws(() => loadConfig(h.home), /不是合法 JSON/);
});

test('示例配置生成与 --force 语义', () => {
  const h = harness();
  const r1 = writeExampleConfig(h.home, { overrides: { rhythm: 'open' } });
  assert.equal(JSON.parse(readFileSync(r1.path, 'utf8')).rhythm, 'open');
  assert.throws(() => writeExampleConfig(h.home), /已存在/);
  const r2 = writeExampleConfig(h.home, { force: true });
  assert.equal(JSON.parse(readFileSync(r2.path, 'utf8')).rhythm, DEFAULT_CONFIG.rhythm);
});

test('CLI config show/init 可用', () => {
  const h = harness();
  const env = { ...process.env, DSH_PROFILE_DIR: '', DSH_HOME: '' };
  const show = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'config', 'show', '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.equal(show.config.rhythm, DEFAULT_CONFIG.rhythm);
  const init = JSON.parse(execFileSync('node', ['bin/warroom.mjs', 'config', 'init', '--home', h.home, '--json'], { encoding: 'utf8', env }));
  assert.ok(init.path.endsWith('warroom.json'));
});

test('配置写错文件名 → 明确报错（不许静默用默认值）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-cfg-name-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ adapterKind: 'bridge' }));
  assert.throws(() => loadConfig(home), /配置文件名不对/);
  // 正确文件名下正常生效
  rmSync(join(home, 'config.json'));
  writeFileSync(join(home, 'warroom.json'), JSON.stringify({ adapterKind: 'bridge' }));
  assert.equal(loadConfig(home).adapterKind, 'bridge');
});
