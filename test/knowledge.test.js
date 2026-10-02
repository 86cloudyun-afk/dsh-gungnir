// 知识库：跨战役复用 + 回填强制脱敏（ADR-004 范围项 3）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';
import { auditSanitization, POC_CATEGORIES } from '../packages/warroom-core/src/knowledge.js';

test('脱敏审计：内网地址/环回/内部域名/未替换占位 全部命中', () => {
  const cases = [
    '目标 10.0.0.5 上存在 RCE',
    '反弹到 192.168.1.20:4444',
    '内网 172.16.5.9 可用',
    '管理端 http://127.0.0.1:8080/admin',
    '域控 dc01.corp 可打',
    '把 <TARGET> 替换为实际地址',
  ];
  for (const c of cases) {
    const r = auditSanitization(c);
    assert.equal(r.clean, false, `应命中：${c}`);
    assert.ok(r.findings.length >= 1);
  }
  assert.equal(auditSanitization('某 CMS 的 upload 接口未校验后缀（通用描述）').clean, true);
});

test('回填 POC：未脱敏被拒（E_KB_UNSANITIZED），脱敏后可入库', () => {
  const h = harness();
  const kb = h.broker.knowledge;
  assert.throws(
    () => kb.addPoc({ code: 'POC-1', title: '测试 10.0.0.5 的漏洞', category: 'rce' }),
    (e) => e.code === 'E_KB_UNSANITIZED' && e.findings.length >= 1
  );
  const poc = kb.addPoc({
    code: 'POC-1', title: '某 CMS 上传后缀绕过', category: 'upload',
    source: 'vendor-advisory-2026-001', affected_versions: '<1.4.2',
  });
  assert.equal(poc.code, 'POC-1');
  assert.equal(poc.sanitized, 1);
  assert.equal(poc.sanitization_note, null);
});

test('显式放行需留痕：allow_unsanitized 必须写理由', () => {
  const h = harness();
  const kb = h.broker.knowledge;
  const poc = kb.addPoc({
    code: 'POC-UNSAFE', title: '含内网示例 10.1.1.1 的教学条目', category: 'other',
    allow_unsanitized: true, note: '教学用例，已在正式版脱敏',
  });
  assert.equal(poc.sanitized, 0);
  assert.match(poc.sanitization_note, /allow_unsanitized: 教学用例/);
});

test('跨战役复用：同一 POC 被两个战役使用，留痕可查', () => {
  const h = harness();
  const kb = h.broker.knowledge;
  kb.addPoc({ code: 'POC-X', title: '通用未授权访问', category: 'unauth' });
  const other = h.broker.createEngagement({ user_message_id: 'um-kb', targets: ['10.9.0.0/24'] });

  kb.use('POC-X', { engagement_id: h.eng.engagement_id, asset: '10.0.0.5', result: 'hit' });
  kb.use('POC-X', { engagement_id: other.engagement_id, asset: '10.9.0.7', result: 'miss' });

  const usage = kb.usage('POC-X');
  assert.equal(usage.length, 2);
  const stats = kb.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.engagements_using, 2);
  assert.equal(stats.top_used[0].code, 'POC-X');
});

test('检索与归类约束', () => {
  const h = harness();
  const kb = h.broker.knowledge;
  kb.addPoc({ code: 'POC-SQLI', title: '某 ORM 注入', category: 'sqli' });
  kb.addPoc({ code: 'POC-RCE', title: '某中间件 RCE', category: 'rce' });

  assert.equal(kb.search({ category: 'sqli' }).length, 1);
  assert.equal(kb.search({ q: '中间件' })[0].code, 'POC-RCE');
  assert.throws(() => kb.addPoc({ code: 'BAD', title: 'x', category: 'not-a-category' }), /category 必须是/);
  assert.equal(POC_CATEGORIES.length, 14);
});

test('工具面：poc_search / add / use 三件套可用且脱敏约束在工具路径同样生效', () => {
  const h = harness();
  const tools = h.broker.knowledge;
  tools.addPoc({ code: 'POC-T', title: '工具路径测试', category: 'traversal' });
  assert.equal(tools.search({ q: 'POC-T' }).length, 1);
  assert.throws(
    () => tools.addPoc({ code: 'POC-BAD', title: '打 10.2.2.2', category: 'traversal' }),
    (e) => e.code === 'E_KB_UNSANITIZED'
  );
});

test('addPoc 拒绝未知字段（静默丢字段 = 静默丢证据）', () => {
  const h = harness();
  assert.throws(() => h.broker.knowledge.addPoc({
    code: 'UNK-1', title: 't', category: 'other', summary: '这个字段不存在',
  }), /未知字段：summary/);
  // 正常字段仍可入库
  const ok = h.broker.knowledge.addPoc({ code: 'UNK-2', title: 't', category: 'other', body: 'TARGET 默认口令' });
  assert.equal(ok.code, 'UNK-2');
});
