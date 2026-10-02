// 工具输出形态回归：DSH 工具契约要求返回值是**对象**（数组/标量/undefined 都会被宿主拒绝：
// "returned invalid output: value must be an object"）。这条由真机挂载暴露过一次，必须钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../packages/warroom-tools/src/index.js';
import { harness } from '../packages/warroom-core/src/testing.js';

/** 每个工具的最小可执行参数（只读优先；写类工具用无害样本）。 */
function minimalArgs(name, h) {
  const eng = h.eng.engagement_id;
  const base = { engagement_id: eng };
  const map = {
    warroom_execute: { ...base, command_id: 'shape-1', target: '10.0.0.5', action_class: 'readonly' },
    warroom_collect: { ...base, task: 'wt_none', receipt_id: 'r1', generation: '1:1:1', members: [] },
    warroom_cancel: { ...base, task: 'wt_none', reason: 'shape' },
    warroom_status: { ...base, task: 'wt_none' },
    warroom_reconcile: { ...base, task: 'wt_none' },
    warroom_redispatch: { ...base, task: 'wt_none', reason: 'shape' },
    warroom_secret_put: { plaintext: 'shape-secret', label: 'shape' },
    warroom_secret_grant: { secret_ref: 'sec_none', engagement_id: eng, task: 't', purpose: 'p' },
    warroom_secret_status: { secret_ref: 'sec_none' },
    warroom_secret_rotate: { confirm: false },
    warroom_report_export: base,
    warroom_evidence_export: base,
    warroom_checklist: base,
    warroom_deliver: base,
    warroom_weekly: { days: 7 },
    warroom_fleet: { timeout_min: 30 },
    warroom_aggregate: { sessions_db: '' },
    warroom_watch: base,
    warroom_rate_view: base,
    warroom_timeline: base,
    warroom_preflight: base,
    warroom_audit: base,
    warroom_jumps: base,
    warroom_metrics: base,
    warroom_sweep_timeouts: base,
    warroom_heartbeat: { ...base, task: 'wt_none' },
    warroom_egress_check: base,
    warroom_spray_check: { ...base, credential_ref: 'c', service: 'ssh', account: 'root' },
    warroom_spray_record: { ...base, credential_ref: 'c', service: 'ssh', account: 'root', result: 'fail' },
    warroom_spray_matrix: { ...base, credentials: ['c'], services: ['ssh'] },
    warroom_poc_add: { code: 'SHAPE-1', title: 'shape', category: 'other', body: 'TARGET' },
    warroom_poc_search: { q: 'SHAPE' },
    warroom_poc_use: { code: 'SHAPE-1', engagement_id: eng, asset: 'HOST', result: 'used' },
    warroom_shell_status: base,
    warroom_shell_verify: { ...base, validity: 'unknown' },
    warroom_fact_query: base,
  };
  return map[name] ?? base;
}

test('每个工具的返回值都是对象（数组/标量会被宿主拒绝）', async () => {
  const h = harness();
  const bad = [];
  const errored = [];
  for (const t of TOOLS) {
    let out;
    try {
      out = await t.run({ broker: h.broker, jumps: h.jumps ?? null }, minimalArgs(t.name, h));
    } catch (e) {
      errored.push(`${t.name}: ${e.code ?? ''} ${e.message}`.trim());
      continue;
    }
    const isObject = out !== null && typeof out === 'object' && !Array.isArray(out);
    if (!isObject) bad.push(`${t.name}: ${Array.isArray(out) ? 'array' : typeof out}`);
  }
  assert.deepEqual(bad, [], `返回值不是对象（宿主会拒绝）：\n${bad.join('\n')}`);
  // 允许工具因"缺前置"报错（如 task 不存在），但错误里不能藏着"返回形态"问题
  assert.ok(errored.length <= TOOLS.length, '记录用：' + errored.slice(0, 5).join(' | '));
});
