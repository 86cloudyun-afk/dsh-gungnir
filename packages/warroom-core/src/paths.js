// 路径安全：战役 ID / 证据子目录等必须是单段路径，且解析后不得逃出家目录。
// 背景：`${home}/engagements/${id}` 在 id 含 `../` 时会写到 engagements/ 之外甚至 home 之外
//（授权边界与数据面布局同时被破坏）。一律 fail-closed。
import { resolve, sep } from 'node:path';
import { warroomError, ERR } from '../../shared-types/src/index.js';

/** 单段安全名：字母数字开头，允许 ._-；禁止 `/` `\` `..` 与空串。 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function assertSafeSegment(value, label = 'id') {
  if (typeof value !== 'string' || !SEGMENT_RE.test(value)) {
    throw warroomError(
      ERR.E_GATE_MISSING_TUPLE,
      `${label} must be a single path-safe segment (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * 把 parts 接到 base 下并 resolve；若结果逃出 base 则拒绝。
 * @param {string} base
 * @param {...string} parts
 * @returns {string}
 */
export function resolveUnder(base, ...parts) {
  if (typeof base !== 'string' || base === '') {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'resolveUnder requires a non-empty base');
  }
  for (const p of parts) assertSafeSegment(p, 'path segment');
  const root = resolve(base);
  const resolved = resolve(root, ...parts);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw warroomError(ERR.E_GATE_MISSING_TUPLE, `path escapes base directory`);
  }
  return resolved;
}
