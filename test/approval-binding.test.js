// 批准与动作的绑定（ADR-007）+ 授权对象的「手段」维度（ADR-001 D3）。
//
// 修的是这一类缺口：**要求是声明出来的，动作是实际发生的，两者之间没有绑定**——
//   ① 批准只绑战役与 action_class（`reason` 是自由文本），一张令牌可授权该战役内任何 destructive 动作；
//   ② 一次性消费是 SELECT + 无条件 UPDATE（无 compare-and-set，也没有记下是哪条命令消费的）；
//   ③ `allowed_means` 只冻结、从不校验，`allowed_means:['passive']` 的战役照样能派任意命令；
//   ④ 执行层的动作档位（exploit = destructive）不被契约声明的档位约束。
// 全部离线：harness（临时 home + FakeAdapter），不碰网络与真实工具。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../packages/warroom-core/src/testing.js';
import { ERR } from '../packages/shared-types/src/index.js';
import { ACTION_MEANS, addressKey, approvalFingerprint, contractFingerprint, hostOf, meansOf } from '../packages/warroom-core/src/gates.js';
import { CAPABILITIES, TIER_ORDER } from '../executors/tool-runner.mjs';

const mk = (over = {}) => harness({ authOverrides: { rhythm: 'open', action_class_limit: 'destructive', ...over } });
// 宿主后台派发（deferDispatch）需要执行层暴露观察源；Fake adapter 默认是同步的，这里补一个惰性观察源
const mkHost = (over = {}) => { const h = mk(over); h.adapter.observe = () => null; return h; };
const destructive = (h, over = {}) => h.contract({ action_class: 'destructive', action: 'exec', ...over });
const parent = { session_id: 'approval-binding-parent', created_at: 1000 };

function expectCode(fn, code) {
  try {
    fn();
    assert.fail(`expected error ${code}`);
  } catch (e) {
    assert.equal(e.code, code, `want ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
}

test('批准绑定「动作 + 靶标」：换动作或换靶标一律拒收（不再是一张万能令牌）', () => {
  const h = mk();
  const ap = h.broker.createApproval({
    engagement_id: h.eng.engagement_id, reason: '只批 exec @ 10.0.0.5',
    bound: { action: 'exec', targets: ['10.0.0.5'] },
  });
  assert.match(ap.contract_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(ap.bound_scope, ['10.0.0.5']);

  // 换动作
  expectCode(() => h.broker.execute({
    ...h.base, command_id: 'ab-1', manual_approval_token: ap.approval_id,
    contract: destructive(h, { action: 'internal', command: 'netexec smb 10.0.0.5' }),
  }), ERR.E_APPROVAL_MISMATCH);
  // 换靶标
  expectCode(() => h.broker.execute({
    ...h.base, command_id: 'ab-2', manual_approval_token: ap.approval_id,
    contract: destructive(h, { targets: ['10.0.0.6'] }),
  }), ERR.E_APPROVAL_MISMATCH);
  // 命令内容不参与绑定（批的是"动作 + 靶标"，不是某条具体命令），对上了才放行
  const ok = h.broker.execute({
    ...h.base, command_id: 'ab-3', manual_approval_token: ap.approval_id,
    contract: destructive(h, { command: 'msfconsole -q -x "use exploit/x; run"' }),
  });
  assert.equal(ok.state, 'running');
});

test('绑定粒度含端口/路径/scheme：换端口、换路径、换 scheme 一律拒（同一主机上的两个服务不是同一个靶标）', () => {
  const h = mk();
  const ap = h.broker.createApproval({
    engagement_id: h.eng.engagement_id,
    bound: { action: 'exec', targets: ['10.0.0.5'], url: 'https://10.0.0.5:8443/safe' },
  });
  assert.deepEqual(ap.bound_scope, ['10.0.0.5', 'https://10.0.0.5:8443/safe'], '台账要显示真正绑定的东西（含端口与路径）');
  const base = { action_class: 'destructive', action: 'exec', command: 'curl -k https://10.0.0.5/x' };
  for (const [cid, url] of [
    ['pk-1', 'https://10.0.0.5:9443/safe'],
    ['pk-2', 'https://10.0.0.5:8443/admin/delete-all'],
    ['pk-3', 'http://10.0.0.5:8443/safe'],
  ]) {
    expectCode(() => h.broker.execute({
      ...h.base, command_id: cid, manual_approval_token: ap.approval_id,
      contract: h.contract({ ...base, url }),
    }), ERR.E_APPROVAL_MISMATCH);
  }
  const ok = h.broker.execute({
    ...h.base, command_id: 'pk-4', manual_approval_token: ap.approval_id,
    contract: h.contract({ ...base, url: 'https://10.0.0.5:8443/safe' }),
  });
  assert.equal(ok.state, 'running', '逐字一致才放行');
});

test('chain 步内 url 也参与绑定；动作大小写/空白归一（EXEC == exec）', () => {
  const h = mk();
  const ap = h.broker.createApproval({
    engagement_id: h.eng.engagement_id, bound: { action: 'exec', targets: ['10.0.0.5'] },
  });
  expectCode(() => h.broker.execute({
    ...h.base, command_id: 'su-1', manual_approval_token: ap.approval_id,
    contract: h.contract({ action_class: 'destructive', action: 'exec', steps: [{ action: 'exec', command: 'id', url: 'https://10.0.0.5:8443/x' }] }),
  }), ERR.E_APPROVAL_MISMATCH);

  const ap2 = h.broker.createApproval({ engagement_id: h.eng.engagement_id, bound: { action: 'EXEC ', targets: ['10.0.0.5'] } });
  assert.equal(ap2.bound_action, 'exec', '签发侧归一化');
  const ok = h.broker.execute({
    ...h.base, command_id: 'su-2', manual_approval_token: ap2.approval_id,
    contract: h.contract({ action_class: 'destructive', action: 'EXEC', command: 'id' }),
  });
  assert.equal(ok.state, 'running', '派发侧同一口径归一化（不再出现"动作其实一样却被判成换动作"）');
});

test('死令牌在签发时就被挡住：没有靶标 / 幽灵战役 / 解析不出主机', () => {
  const h = mk();
  expectCode(() => h.broker.createApproval({ engagement_id: h.eng.engagement_id, bound: { action: 'exec' } }),
    ERR.E_APPROVAL_MISMATCH);
  // 幽灵战役 → 拒绝签发（否则签出一张永远消费不掉的死令牌）
  assert.throws(() => h.broker.createApproval({ engagement_id: 'eng_does_not_exist', bound: { action: 'exec', targets: ['10.0.0.5'] } }),
    (e) => e.code === ERR.E_TASK_NOT_FOUND);
  const e = expectCode(() => h.broker.createApproval({ engagement_id: h.eng.engagement_id, bound: { action: 'exec', targets: ['  '] } }),
    ERR.E_APPROVAL_MISMATCH);
  assert.match(e.message, /可寻址对象/);
});

test('手段判定把 intent/role 一并算进去：被动标签 + 主动意图不再放行', () => {
  const h = mk({ allowed_means: ['passive'] });
  expectCode(() => h.broker.execute({
    ...h.base, command_id: 'mi-1',
    contract: h.contract({ action: 'recon', action_class: 'readonly', intent: 'exploit' }),
  }), ERR.E_GATE_MEANS_NOT_ALLOWED);
  expectCode(() => h.broker.execute({
    ...h.base, command_id: 'mi-2',
    contract: h.contract({ action: 'recon', action_class: 'readonly', role: 'exec' }),
  }), ERR.E_GATE_MEANS_NOT_ALLOWED);
  assert.equal(meansOf({ action: 'recon', intent: 'exploit' }), 'active');
  assert.equal(meansOf({ action: 'recon', intent: 'recon-nonsense' }), 'active', '未知词按最保守处理');
  assert.equal(meansOf({ action: 'recon', intent: 'recon' }), 'passive');
});

test('可寻址键与主机解析的形状覆盖（协议相对 URL / 裸 IPv6 / 端口路径）', () => {
  assert.equal(hostOf('//10.0.0.5/x'), '10.0.0.5');
  assert.equal(hostOf('[::1]:8080'), '::1');
  assert.equal(hostOf('user:pw@host:443/x'), 'host');
  assert.equal(hostOf('file:///etc/passwd'), null, '无主机 → 不参与绑定（本地文件不是远端资产）');
  assert.equal(addressKey('HTTPS://Example.TEST:8443/Safe'), 'https://example.test:8443/safe');
  assert.equal(addressKey('10.0.0.5:9443'), '10.0.0.5:9443', '裸主机保留端口');
  assert.equal(addressKey('10.0.0.5'), '10.0.0.5');
});

test('裸批准（未绑定动作）拒收：旧令牌必须重新签发', () => {
  const h = mk();
  const legacyExpires = new Date(Date.now() + 3600_000).toISOString();
  h.broker.global.prepare(`INSERT INTO approvals
    (approval_id, engagement_id, action_class, reason, issued_by, expires_at, single_use, ts)
    VALUES ('ap_legacy', ?, 'destructive', '历史裸批准', 'operator', ?, 1, ?)`)
    .run(h.eng.engagement_id, legacyExpires, new Date().toISOString());
  const e = expectCode(() => h.broker.execute({
    ...h.base, command_id: 'ab-4', manual_approval_token: 'ap_legacy', contract: destructive(h),
  }), ERR.E_APPROVAL_MISMATCH);
  assert.match(e.message, /未绑定动作/);
  // 签发侧也拒收裸批准
  expectCode(() => h.broker.createApproval({ engagement_id: h.eng.engagement_id }), ERR.E_APPROVAL_MISMATCH);
});

test('destructive 契约必须声明 action（否则无从绑定）；缺令牌仍先报"需人工批准"', () => {
  const h = mk();
  const ap = h.broker.createApproval({ engagement_id: h.eng.engagement_id, bound: { action: 'exec', targets: ['10.0.0.5'] } });
  const noAction = h.contract({ action_class: 'destructive' });
  expectCode(() => h.broker.execute({ ...h.base, command_id: 'ab-5', contract: noAction }),
    ERR.E_GATE_DESTRUCTIVE_NEEDS_APPROVAL);
  const e = expectCode(() => h.broker.execute({
    ...h.base, command_id: 'ab-6', contract: noAction, manual_approval_token: ap.approval_id,
  }), ERR.E_GATE_ACTION_REQUIRED);
  assert.match(e.message, /必须声明 action/);
});

test('一次性批准：消费记**真实 command_id**，compare-and-set 守卫挡并发双花', () => {
  const h = mk();
  const ap = h.broker.createApproval({ engagement_id: h.eng.engagement_id, bound: { action: 'exec', targets: ['10.0.0.5'] } });
  const ok = h.broker.execute({ ...h.base, command_id: 'ab-7', manual_approval_token: ap.approval_id, contract: destructive(h) });
  assert.equal(ok.state, 'running');
  const row = h.broker.global.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(ap.approval_id);
  assert.equal(row.used_by_command, 'ab-7', '必须记下消费它的那条命令（可审计：批准 → 命令）');
  expectCode(() => h.broker.execute({
    ...h.base, command_id: 'ab-8', manual_approval_token: ap.approval_id, contract: destructive(h),
  }), ERR.E_APPROVAL_USED);

  // CAS 本身：同一条件更新两次，第二次必须是 0 行（跨进程竞态下也不会双花）
  const ap2 = h.broker.createApproval({ engagement_id: h.eng.engagement_id, bound: { action: 'exec', targets: ['10.0.0.5'] } });
  const cas = () => h.broker.global.prepare(
    'UPDATE approvals SET used_by_command = ? WHERE approval_id = ? AND used_by_command IS NULL').run('cmd-x', ap2.approval_id);
  assert.equal(Number(cas().changes), 1);
  assert.equal(Number(cas().changes), 0, '已有消费方时第二次更新必须 0 行');
});

test('宿主派发前复核：批准已被别的命令占用 → 不执行（批条不能换给别的命令）', () => {
  const h = mkHost();
  const ap = h.broker.createApproval({ engagement_id: h.eng.engagement_id, bound: { action: 'exec', targets: ['10.0.0.5'] } });
  h.broker.execute({ ...h.base, command_id: 'ab-9', manual_approval_token: ap.approval_id, contract: destructive(h, { wire_cost: 0 }) },
    { deferDispatch: true, parent });
  // 模拟"批条被换走"：消费方改成另一条命令
  h.broker.global.prepare('UPDATE approvals SET used_by_command = ? WHERE approval_id = ?').run('other-command', ap.approval_id);
  h.broker.dispatchQueued('ab-9');
  assert.equal(h.adapter.tasks.size, 0, '宿主侧复核不通过 → 不得派发');
});

test('授权手段落地：allowed_means 只有 passive 时，主动手段被拒、被动手段放行', () => {
  const h = mk({ allowed_means: ['passive'] });
  // 主动手段一律被拒（exploit 连"需要人工批准"这一步都到不了：这个战役根本不允许主动手段）
  for (const [command_id, action] of [['am-1', 'exec'], ['am-2', 'nuclei_scan'], ['am-3', 'exploit']]) {
    const e = expectCode(() => h.broker.execute({
      ...h.base, command_id,
      contract: h.contract({ action, action_class: action === 'exploit' ? 'destructive' : 'active' }),
    }), ERR.E_GATE_MEANS_NOT_ALLOWED);
    assert.match(e.message, /passive/);
  }
  const ok = h.broker.execute({ ...h.base, command_id: 'am-4', contract: h.contract({ action: 'http_get', action_class: 'readonly' }) });
  assert.equal(ok.state, 'running');
  const ok2 = h.broker.execute({ ...h.base, command_id: 'am-5', contract: h.contract({ action: 'recon', action_class: 'readonly' }) });
  assert.equal(ok2.state, 'running');
});

test('手段判定口径：按动作（不看请求方声明的标签），未知动作按最保守的 active', () => {
  assert.equal(meansOf({ action: 'exec', action_class: 'readonly' }), 'active', '标签不能把主动手段洗成被动');
  assert.equal(meansOf({ action: 'http_get', action_class: 'active' }), 'passive');
  assert.equal(meansOf({ action: 'whatever' }), 'active');
  assert.equal(meansOf({}), 'active', '未声明动作 → 不给"被动"白名单');
});

test('手段词表与执行层能力面一致（双向断言：动作 + 别名，防两张表漂移）', () => {
  for (const [name, cap] of Object.entries(CAPABILITIES)) {
    const want = cap.tier === 'readonly' ? 'passive' : 'active';
    assert.equal(ACTION_MEANS[name], want, `${name}（tier=${cap.tier}）的手段应为 ${want}`);
    for (const alias of cap.aliases) {
      assert.equal(ACTION_MEANS[alias], want, `别名 ${alias} 的手段应与 ${name} 一致`);
    }
  }
  for (const [action, means] of Object.entries(ACTION_MEANS)) {
    assert.ok(['passive', 'active'].includes(means), `${action} 的手段取值非法：${means}`);
  }
  assert.equal(TIER_ORDER.destructive > TIER_ORDER.active, true, '档位次序：destructive > active > readonly');
});

test('批准指纹稳定：同一动作 + 同一可寻址集合得到同一指纹，换任一维度即变', () => {
  const one = contractFingerprint({ action: 'exec', action_class: 'destructive', targets: ['10.0.0.5'] });
  const two = contractFingerprint({ action: 'exec', action_class: 'destructive', targets: ['10.0.0.5'], command: 'id' });
  assert.equal(one, two, '命令内容不参与绑定');
  assert.notEqual(one, contractFingerprint({ action: 'exec', action_class: 'destructive', targets: ['10.0.0.6'] }));
  assert.notEqual(one, contractFingerprint({ action: 'internal', action_class: 'destructive', targets: ['10.0.0.5'] }));
  assert.equal(approvalFingerprint({ action: 'exec', targets: ['10.0.0.5'] }),
    approvalFingerprint({ action: 'exec', targets: ['10.0.0.5'], url: null }), '缺失 url 与显式 null 等价');
});

test('归一化：域名大小写不改变指纹；allowed_means 写错在冻结时就报错', () => {
  // 同一靶标的不同大小写写法 → 同一指纹（否则操作员复制粘贴不同写法就被假拒）
  assert.equal(
    contractFingerprint({ action: 'exec', action_class: 'destructive', targets: ['TARGET.Example.TEST'] }),
    contractFingerprint({ action: 'exec', action_class: 'destructive', targets: ['target.example.test'] }),
  );
  const h = mk();
  const ap = h.broker.createApproval({ engagement_id: h.eng.engagement_id, bound: { action: 'exec', targets: ['10.0.0.5'] } });
  const lower = h.broker.global.prepare('SELECT bound_scope FROM approvals WHERE approval_id = ?').get(ap.approval_id);
  assert.deepEqual(JSON.parse(lower.bound_scope), ['10.0.0.5']);

  // 手段白名单：写错的值在冻结授权时直接报错（而不是把战役变成"什么都拒"的哑门）
  assert.throws(() => harness({ authOverrides: { allowed_means: ['passiv'] } }), (e) => e.code === ERR.E_GATE_MEANS_NOT_ALLOWED);
  // 大小写与重复项被规范化
  const ok = harness({ authOverrides: { allowed_means: ['PASSIVE', 'passive', ' Active '] } });
  assert.deepEqual(ok.eng.auth_object.allowed_means, ['passive', 'active']);
});

test('批准台账（只读）：绑定、已用、过期一眼可见', () => {
  const h = mk();
  const used = h.broker.createApproval({ engagement_id: h.eng.engagement_id, issued_by: 'operator-1', bound: { action: 'exec', targets: ['10.0.0.5'] } });
  h.broker.execute({ ...h.base, command_id: 'ab-l1', manual_approval_token: used.approval_id, contract: destructive(h) });
  const expired = h.broker.createApproval({ engagement_id: h.eng.engagement_id, ttlSeconds: -1, bound: { action: 'exec', targets: ['10.0.0.5'] } });
  const rows = h.broker.listApprovals(h.eng.engagement_id);
  assert.equal(rows.length, 2);
  const u = rows.find((r) => r.approval_id === used.approval_id);
  assert.equal(u.used, true);
  assert.equal(u.used_by_command, 'ab-l1');
  assert.deepEqual(u.bound_scope, ['10.0.0.5']);
  assert.equal(u.bound_action, 'exec');
  assert.equal(u.single_use, true, '批准一律一次性（不签可复制的不记名批条）');
  assert.equal(rows.find((r) => r.approval_id === expired.approval_id).expired, true);
});
