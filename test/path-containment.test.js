import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Broker } from '../packages/warroom-core/src/broker.js';
import { exportEvidence } from '../packages/warroom-core/src/evidence.js';
import { assertSafeSegment, resolveUnder } from '../packages/warroom-core/src/paths.js';

const clean = (d) => { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };

test('assertSafeSegment：合法 eng_uuid 通过，穿越串拒绝', () => {
  assert.equal(assertSafeSegment('eng_a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'engagement_id'),
    'eng_a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  for (const bad of ['../evil', '..', 'eng/nested', 'eng\\nested', '', null, 'a/../b', '.hidden']) {
    assert.throws(() => assertSafeSegment(bad, 'engagement_id'), (e) => e.code === 'E_GATE_MISSING_TUPLE');
  }
});

test('resolveUnder：拒绝逃出 base 的拼接', () => {
  const base = mkdtempSync(join(tmpdir(), 'base-'));
  try {
    const ok = resolveUnder(base, 'engagements', 'eng_ok');
    assert.equal(ok, resolve(base, 'engagements', 'eng_ok'));
    assert.throws(() => resolveUnder(base, 'engagements', '../evil'), (e) => e.code === 'E_GATE_MISSING_TUPLE');
  } finally { clean(base); }
});

test('createEngagement：../ 不得把 fact.db 写到 engagements/ 之外', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-'));
  try {
    const b = new Broker({ home });
    assert.throws(
      () => b.createEngagement({ user_message_id: 'm', targets: ['10.0.0.1'], engagement_id: '../evil_eng' }),
      (e) => e.code === 'E_GATE_MISSING_TUPLE',
    );
    assert.equal(existsSync(join(home, 'evil_eng')), false);
    assert.equal(existsSync(join(home, 'engagements', 'evil_eng')), false);
    // 拒绝发生在 mkdir 之前：engagements/ 可能尚未创建
    if (existsSync(join(home, 'engagements'))) {
      assert.ok(!readdirSync(join(home, 'engagements')).includes('evil_eng'));
    }
  } finally { clean(home); }
});

test('createEngagement：../../ 不得逃出 WARROOM_HOME', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wrp-'));
  const home = join(parent, 'home');
  mkdirSync(home);
  try {
    const b = new Broker({ home });
    assert.throws(
      () => b.createEngagement({ user_message_id: 'm', targets: ['10.0.0.1'], engagement_id: '../../outside_eng' }),
      (e) => e.code === 'E_GATE_MISSING_TUPLE',
    );
    assert.equal(existsSync(join(parent, 'outside_eng')), false);
  } finally { clean(parent); }
});

test('_eng：打开时同样拒绝穿越 id', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-'));
  try {
    const b = new Broker({ home });
    assert.throws(() => b._eng('../evil_eng'), (e) => e.code === 'E_GATE_MISSING_TUPLE');
  } finally { clean(home); }
});

test('exportEvidence：target=../escape 不得逃出 outDir', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-'));
  try {
    const b = new Broker({ home });
    const eng = b.createEngagement({ user_message_id: 'm', targets: ['10.0.0.1'] });
    const out = join(home, 'out');
    mkdirSync(out);
    assert.throws(
      () => exportEvidence({ broker: b, engagementId: eng.engagement_id, outDir: out, target: '../escape' }),
      (e) => e.code === 'E_GATE_MISSING_TUPLE',
    );
    assert.equal(existsSync(join(home, 'escape')), false);
  } finally { clean(home); }
});

test('合法 engagement_id 与证据 target 仍可用', () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-'));
  try {
    const b = new Broker({ home });
    const eng = b.createEngagement({
      user_message_id: 'm', targets: ['10.0.0.1'], engagement_id: 'eng_path_ok_1',
    });
    assert.equal(eng.engagement_id, 'eng_path_ok_1');
    assert.equal(existsSync(join(home, 'engagements', 'eng_path_ok_1', 'fact.db')), true);
    const out = join(home, 'out');
    const pack = exportEvidence({
      broker: b, engagementId: eng.engagement_id, outDir: out, target: 'host-a', audiences: ['client'],
    });
    assert.equal(existsSync(join(out, 'host-a', 'EVIDENCE_INDEX.md')), true);
    assert.ok(pack.files?.index);
  } finally { clean(home); }
});
