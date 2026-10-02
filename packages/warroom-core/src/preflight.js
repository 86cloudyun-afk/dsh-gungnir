// 开工前预检（框架 §2 原则 6 / 宪法 §12）：把"能不能开工"变成一次可复算的检查。
// 六个维度：环境 → 配置 → 战役 → 出口（路由/验证）→ 门禁自检 → 备份。
// 结论三态：ready / degraded（可开工但有提示）/ blocked（有必须先解决的问题）。
import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RHYTHM_CONCURRENCY } from '../../shared-types/src/index.js';
import { inScopeEntry } from './gates.js';
import { planWave } from './wave.js';
import { planBucket as planBucketImpl } from './buckets.js';


const require_wave = () => ({ planWave });

/** 授权目标：库里以 JSON 数组存储，兼容逗号分隔的写法。 */
function parseScope(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) return arr.map((t) => String(t).trim()).filter(Boolean);
    } catch { /* 退化为逗号分隔解析 */ }
  }
  return text.split(',').map((t) => t.trim()).filter(Boolean);
}

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

/**
 * @param {{broker:object, engagementId:string, home?:string}} p
 * @returns {{verdict:'ready'|'degraded'|'blocked', checks:Array, blockers:string[], warnings:string[]}}
 */
export function preflight({ broker, engagementId, home = null, meeting = null }) {
  const checks = [];
  const add = (dim, name, status, detail = '') => checks.push({ dim, name, status, detail });
  const root = home ?? broker.home;

  // 1) 环境
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('env', 'Node ≥ 22.13', (major > 22 || (major === 22 && minor >= 13)) ? OK : FAIL, process.versions.node);
  add('env', '家目录可写', (() => {
    try {
      const probe = join(root, '.preflight-probe');
      writeFileSync(probe, 'x');
      unlinkSync(probe);
      return OK;
    } catch { return FAIL; }
  })());

  // 2) 配置
  try {
    const cfg = broker.config;
    add('config', '配置已加载', OK, `rhythm=${cfg.rhythm} timeoutMin=${cfg.timeoutMin} adapter=${cfg.adapterKind}`);
    add('config', '出口验证策略', cfg.requireEgressCheck ? WARN : OK,
      cfg.requireEgressCheck ? `强制中（有效期 ${cfg.egressMaxAgeMin} 分钟）——开工前必须记录一次 pass` : '未强制');
  } catch (e) {
    add('config', '配置可读', FAIL, e.message);
  }

  // 3) 战役
  let row = null;
  try {
    row = broker._engWithRow(engagementId).row;
    add('engagement', '战役存在', OK, `${engagementId}（auth_version=${row.auth_version}，rhythm=${row.rhythm}）`);
    const nowIso = new Date().toISOString();
    if (row.window_start && nowIso < row.window_start) add('engagement', '授权时间窗', FAIL, `尚未开始（${row.window_start}）`);
    else if (row.window_end && nowIso > row.window_end) add('engagement', '授权时间窗', FAIL, `已过期（${row.window_end}）`);
    else add('engagement', '授权时间窗', OK, `${row.window_start ?? '-'} → ${row.window_end ?? '-'}`);
    add('engagement', '授权目标', (row.target_scope ?? '').trim() ? OK : FAIL, row.target_scope ?? '（空）');
  } catch (e) {
    // 战役不存在时 `_engWithRow().row` 是 undefined，直接取 auth_version 会抛原始 TypeError
    // （真机症状：blocker="Cannot read properties of undefined (reading 'auth_version')"，
    //  使用者据此无法判断"该先冻结授权"）。这里给可读结论 + 自举指引，fail-closed 语义不变。
    const missing = /Cannot read properties of undefined|null is not|not found/i.test(String(e?.message ?? ''));
    add('engagement', '战役存在', FAIL,
      missing
        ? `战役不存在：${engagementId}（请先冻结授权：warroom_engage / CLI \`warroom engage\`）`
        : e.message);
  }

  // 4) 出口（活跃 route + 出口验证）
  let activeRoutes = [];
  try {
    activeRoutes = broker._eng(engagementId).store.db
      .prepare("SELECT * FROM jump_routes WHERE state = 'active' ORDER BY ts").all();
    if (activeRoutes.length === 0) {
      add('egress', '活跃路由', WARN, '无活跃 route：需要真实出口前先 jump acquire（本地/离线动作不受影响）');
    } else {
      const last = activeRoutes.at(-1);
      add('egress', '活跃路由', OK, `${last.route_id}（跳板 ${last.jumphost_id}，${last.socks}）`);
    }
  } catch (e) {
    add('egress', '活跃路由', WARN, `无法读取路由表：${e.message}`);
  }
  try {
    const st = broker.egressStatus(engagementId);
    add('egress', '出口验证', st.valid ? OK : (broker.config.requireEgressCheck ? FAIL : WARN),
      st.last ? `最近：${st.last.verdict}（${st.age_min} 分钟前，IP ${st.last.exit_ip}）` : '从未验证');
  } catch (e) {
    add('egress', '出口验证', WARN, e.message);
  }

  // 5) 备份新鲜度
  const backupsDir = join(root, 'backups');
  if (!existsSync(backupsDir) || readdirSync(backupsDir).length === 0) {
    add('backup', '近期备份', WARN, '从未备份（建议 warroom backup --keep 7）');
  } else {
    const latest = readdirSync(backupsDir)
      .map((n) => ({ n, m: statSync(join(backupsDir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    const days = (Date.now() - latest.m) / 86400000;
    add('backup', '近期备份', days <= 7 ? OK : WARN, `${latest.n}（${days.toFixed(1)} 天前）`);
  }

  // 6) 秘密密钥权限（若已启用）
  const keyPath = join(root, 'secrets', 'key.bin');
  if (existsSync(keyPath)) {
    const mode = statSync(keyPath).mode & 0o777;
    add('secret', '密钥权限 600', mode === 0o600 ? OK : FAIL, mode.toString(8));
  } else {
    add('secret', '密钥文件', OK, '尚未启用秘密库');
  }

  // 7) 执行桶自洽性（框架 §4）：桶 A 要有活跃出口；桶 B 不得挂 socks
  try {
    const bucket = broker.config?.bucket ?? 'A';
    const route = activeRoutes.at(-1) ? { socks: activeRoutes.at(-1).socks, route_id: activeRoutes.at(-1).route_id, jumphost_id: activeRoutes.at(-1).jumphost_id } : null;
    const plan = planBucketImpl({ bucket, route, engagementId });
    add('bucket', `执行桶 ${bucket} 自洽`, OK, plan.plan.kind);
  } catch (e) {
    // 语义分层：缺出口/缺跳板只是"还没取出口"（提示）；桶配置本身矛盾才阻塞
    const notYet = e.code === 'E_FENCE_NO_ROUTE' || e.code === 'E_NO_JUMPHOST';
    add('bucket', `执行桶 ${broker.config?.bucket ?? 'A'} 自洽`, notYet ? WARN : FAIL, e.message);
  }

  // 8) 演练计划 × 授权范围（给了会议文件才检查）：每个目标逐个核范围，越界即阻塞
  let wavePlan = null;
  if (meeting?.tasks?.length) {
    try {
      const { planWave } = require_wave();
      wavePlan = planWave({ wave: meeting });
      const scope = parseScope(row?.target_scope);
      const outOfScope = [];
      for (const t of wavePlan.tasks) {
        for (const target of t.targets ?? []) {
          const ok = scope.some((entry) => inScopeEntry(target, entry));
          if (!ok) outOfScope.push(`${t.id}:${target}`);
        }
      }
      if (outOfScope.length > 0) {
        add('plan', '波次目标 ⊆ 授权范围', FAIL, `越界目标：${outOfScope.join(', ')}（授权：${scope.join(', ') || '空'}）`);
      } else {
        add('plan', '波次目标 ⊆ 授权范围', OK, `${wavePlan.tasks.length} 个任务的目标全部在范围内`);
      }
      const conc = RHYTHM_CONCURRENCY[row?.rhythm] ?? 1;
      add('plan', '并发与层数', wavePlan.layers.length <= 1 ? OK : OK,
        `${wavePlan.layers.length} 层 · 同时在飞上限 ${conc}（节奏档 ${row?.rhythm}）`);
    } catch (e) {
      add('plan', '波次计划可生成', FAIL, e.message);
    }
  }

  const blockers = checks.filter((c) => c.status === FAIL).map((c) => `${c.dim}/${c.name}：${c.detail}`);
  const warnings = checks.filter((c) => c.status === WARN).map((c) => `${c.dim}/${c.name}：${c.detail}`);
  const verdict = blockers.length > 0 ? 'blocked' : (warnings.length > 0 ? 'degraded' : 'ready');
  const next = verdict === 'blocked'
    ? ['先解决阻塞项（见 blockers），再开工']
    : [
      wavePlan ? `按计划开工：${wavePlan.order.join(' → ')}` : null,
      activeRoutes.length === 0 ? '取出口：node bin/warroom.mjs jump acquire --engagement <id> --target <资产>' : null,
      broker.config.requireEgressCheck ? '记录出口验证：node scripts/egress-check.mjs --home <home> --engagement <id>' : null,
      '先演练：node bin/warroom.mjs wave --dry-run --engagement <id> --meeting wave.json',
    ].filter(Boolean);
  return { verdict, checks, blockers, warnings, next };
}
