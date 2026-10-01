// Adapter 一致性套件（框架 §11 关键交叉）：任何执行层换进来，先过这一套契约检查。
// 覆盖 ADR-003 rev2 的 SPI 语义：派发幂等、找回、清单逐项证实、回执形状、对账定论、重派。

const TERMINAL = ['done', 'partial', 'failed', 'cancelled', 'confirmed_stopped'];

function ok(name, detail = '') { return { name, ok: true, detail }; }
function fail(name, detail) { return { name, ok: false, detail }; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} adapter SPI 实例
 * @param {{commandIdPrefix?:string, awaitStopMs?:number}} opts
 *   awaitStopMs：远端执行层的停止确认会滞后（ADR-003：cancel 是请求，证实要探针）。
 *                提供该值时套件轮询到确认或超时；不提供则只校验清单可探针。
 * @returns {Promise<Array<{name:string, ok:boolean, detail:string}>>}
 */
export async function runConformance(adapter, { commandIdPrefix = 'conf', awaitStopMs = 0 } = {}) {
  const results = [];
  const cid = `${commandIdPrefix}-${Math.random().toString(36).slice(2, 8)}`;
  const contract = {
    targets: ['10.0.0.5'], action_class: 'readonly', task_id: `${commandIdPrefix}-task`,
    generation: `1:1:1`, resources: ['container'], fake_members: [
      { entity_type: 'asset', source_id: 'conf-a1', revision_no: 1, content_hash: 'h', payload: {} },
    ],
  };
  let taskId = null;

  // 1. dispatch
  try {
    const r = adapter.dispatch(cid, contract);
    taskId = r?.task_id;
    results.push(taskId ? ok('dispatch 返回 task_id') : fail('dispatch 返回 task_id', `got ${JSON.stringify(r)}`));
  } catch (e) {
    results.push(fail('dispatch 返回 task_id', e.message));
    return results; // 后续检查无意义
  }

  // 2. 幂等：同 command_id 二次派发同一任务
  try {
    const r2 = adapter.dispatch(cid, contract);
    results.push(r2?.task_id === taskId
      ? ok('同 command_id 幂等（同一 task_id）')
      : fail('同 command_id 幂等（同一 task_id）', `${r2?.task_id} != ${taskId}`));
  } catch (e) {
    results.push(fail('同 command_id 幂等（同一 task_id）', e.message));
  }

  // 3. lookup 找回
  try {
    const found = adapter.lookup(cid);
    results.push(found?.task_id === taskId ? ok('lookup 可找回') : fail('lookup 可找回', JSON.stringify(found)));
  } catch (e) {
    results.push(fail('lookup 可找回', e.message));
  }

  // 4. status 形状
  try {
    const st = adapter.status(taskId);
    results.push(st && typeof st.state === 'string'
      ? ok('status 返回 {state}')
      : fail('status 返回 {state}', JSON.stringify(st)));
  } catch (e) {
    results.push(fail('status 返回 {state}', e.message));
  }

  // 5. manifestOf 形状（逐项探针）
  let manifest = null;
  try {
    manifest = adapter.manifestOf(taskId);
    const good = Array.isArray(manifest) && manifest.length > 0
      && manifest.every((m) => m.id && m.kind && typeof m.check === 'function');
    results.push(good ? ok('manifestOf 返回可探针清单') : fail('manifestOf 返回可探针清单', JSON.stringify(manifest)));
  } catch (e) {
    results.push(fail('manifestOf 返回可探针清单', e.message));
  }

  // 6. cancel 的语义：请求发出 + 清单可探针；（可选）等待远端停止确认
  try {
    adapter.cancel(taskId, 'conformance');
    const probeable = (adapter.manifestOf(taskId) ?? []).every((m) => typeof m.check === 'function');
    if (!probeable) {
      results.push(fail('cancel 后清单可探针', '清单缺失或不可探针'));
    } else if (awaitStopMs <= 0) {
      results.push(ok('cancel 后清单可探针（未要求等待确认）'));
    } else {
      const deadline = Date.now() + awaitStopMs;
      let all = false;
      for (;;) {
        all = (adapter.manifestOf(taskId) ?? []).every((m) => m.check() === true);
        if (all || Date.now() > deadline) break;
        await sleep(10);
      }
      results.push(all
        ? ok('cancel 后清单逐项证实（等待远端确认）')
        : fail('cancel 后清单逐项证实（等待远端确认）', `${awaitStopMs}ms 内未确认`));
    }
  } catch (e) {
    results.push(fail('cancel 后清单可探针', e.message));
  }

  // 7. collect 回执形状
  try {
    const receipt = adapter.collect(taskId);
    const good = receipt && typeof receipt.receipt_id === 'string'
      && typeof receipt.generation === 'string' && Array.isArray(receipt.members);
    results.push(good ? ok('collect 回执形状') : fail('collect 回执形状', JSON.stringify(receipt).slice(0, 120)));
  } catch (e) {
    results.push(fail('collect 回执形状', e.message));
  }

  // 8. reconcile 归入终态
  try {
    const rec = adapter.reconcile(taskId);
    results.push(rec && TERMINAL.includes(rec.state)
      ? ok('reconcile 返回终态')
      : fail('reconcile 返回终态', JSON.stringify(rec)));
  } catch (e) {
    results.push(fail('reconcile 返回终态', e.message));
  }

  // 9. 声明支持重派则必须可用
  if (adapter.supportsRedispatch) {
    try {
      const r = adapter.redispatch(cid, { ...contract, generation: '1:1:2' }, 2);
      const st = adapter.status(taskId);
      results.push((r || st) ? ok('redispatch 可用（声明支持）') : fail('redispatch 可用（声明支持）', 'no result'));
    } catch (e) {
      results.push(fail('redispatch 可用（声明支持）', e.message));
    }
  }

  return results;
}

export function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  return { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => `${f.name}: ${f.detail}`) };
}
