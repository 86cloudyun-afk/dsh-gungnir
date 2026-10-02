// 秘密边界验收（ADR-001 D7）：at-rest 加密、权限化 resolve、TTL、全出口脱敏。
// 注：本文件含**合成示例值**（AWS/GitHub/OpenAI 官方文档示例串），标记 synthetic-example，
// 供脱敏器形态测试使用，绝非真实凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { harness } from '../packages/warroom-core/src/testing.js';
import { redact, redactDeep, PATTERNS } from '../packages/warroom-core/src/redactor.js';

const SECRET = 'S3cr3t-P@ssw0rd-长口令-2026';

test('at-rest 加密：库文件不含明文，密钥文件 600 / 目录 700', () => {
  const h = harness();
  const { secret_ref } = h.broker.secrets.put(SECRET, { label: 'ssh-pw' });
  assert.ok(secret_ref.startsWith('sec_'));

  const raw = readFileSync(join(h.home, 'global.db'));
  assert.equal(raw.includes(Buffer.from(SECRET)), false, 'global.db 不应出现明文');

  const keyMode = statSync(join(h.home, 'secrets', 'key.bin')).mode & 0o777;
  const dirMode = statSync(join(h.home, 'secrets')).mode & 0o777;
  assert.equal(keyMode, 0o600);
  assert.equal(dirMode, 0o700);
});

test('resolve 需要匹配的授权：无授权拒绝 / 用途不匹配拒绝', () => {
  const h = harness();
  const { secret_ref } = h.broker.secrets.put(SECRET, { label: 'ssh-pw' });
  assert.throws(() => h.broker.secrets.resolve(secret_ref, { task_id: 't1', purpose: 'ssh-login' }),
    (e) => e.code === 'E_SECRET_NO_GRANT');
  h.broker.secrets.grant(secret_ref, { engagement_id: h.eng.engagement_id, task_id: 't1', purpose: 'ssh-login' });
  assert.throws(() => h.broker.secrets.resolve(secret_ref, { task_id: 't1', purpose: 'other-purpose' }),
    (e) => e.code === 'E_SECRET_NO_GRANT');
  const r = h.broker.secrets.resolve(secret_ref, { task_id: 't1', purpose: 'ssh-login' });
  assert.equal(r.value, SECRET);
});

test('授权 TTL 到期后拒绝解析', () => {
  let now = Date.now();
  const h = harness({ nowMs: () => now });
  const { secret_ref } = h.broker.secrets.put(SECRET);
  h.broker.secrets.grant(secret_ref, { engagement_id: h.eng.engagement_id, task_id: 't1', purpose: 'p', ttlSeconds: 60 });
  assert.equal(h.broker.secrets.resolve(secret_ref, { task_id: 't1', purpose: 'p' }).value, SECRET);
  now += 61_000; // 越过 TTL
  assert.throws(() => h.broker.secrets.resolve(secret_ref, { task_id: 't1', purpose: 'p' }),
    (e) => e.code === 'E_SECRET_GRANT_EXPIRED');
});

test('全出口脱敏：gate_log / collect 结果 / 错误路径 都不含明文', () => {
  const h = harness();
  const { secret_ref } = h.broker.secrets.put(SECRET, { label: 'ssh-pw' });
  assert.ok(secret_ref);

  // ① gate_log：detail 里塞明文
  h.store().appendGateLog({ decision: 'test', detail: h.broker.secrets.redact(`found ${SECRET} in config`) });
  const row = h.store().db.prepare("SELECT detail FROM gate_log WHERE decision = 'test'").get();
  assert.equal(row.detail.includes(SECRET), false);
  assert.match(row.detail, /\[REDACTED:ssh-pw\]/);

  // ② collect 结果脱敏
  const ex = h.broker.execute({
    ...h.base, command_id: 'sec-c1',
    contract: h.contract({
      fake_members: [{
        entity_type: 'credential', source_id: 'c-1', revision_no: 1, content_hash: 'h-c1',
        payload: { password: SECRET, note: 'plain' },
      }],
    }),
  });
  const rc = h.broker.collect(h.eng.engagement_id, ex.task_id, h.adapter.collect(ex.task_id));
  assert.equal(JSON.stringify(rc).includes(SECRET), false, 'collect 返回不应含明文');
});

test('形态脱敏：token/私钥/kv 口令被掩码（未注册明文也能挡）', () => {
  const samples = [
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWX',
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'AKIAIOSFODNN7EXAMPLE',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    'password=hunter2xyz',
  ];
  for (const s of samples) {
    const out = redact(s);
    assert.match(out, /\[REDACTED:/, `未脱敏: ${s}`);
  }
  assert.ok(PATTERNS.length >= 5);
  const deep = redactDeep({ a: ['sk-abcdefghijklmnopqrstuvwxyz012345'], b: { c: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX' } });
  assert.equal(JSON.stringify(deep).includes('sk-abcdefghijklmnopqrstuvwxyz012345'), false);
});

test('密钥不随备份走：备份产物中无 key.bin（脚本只收 .db）', () => {
  const h = harness();
  h.broker.secrets.put(SECRET);
  // 备份脚本只处理 .db；key.bin 位于 secrets/ 目录，天然排除
  const dest = join(h.home, 'bk-secrets-check');
  execFileSync('node', ['scripts/backup.mjs', h.home, dest], { encoding: 'utf8' });
  assert.equal(existsSync(join(dest, 'secrets', 'key.bin')), false);
});
