// 家目录配置（$WARROOM_HOME/warroom.json）：一次配置，全命令生效。
// 原则：缺失即用安全默认；非法配置**明确报错**而不是静默忽略（否则用户以为生效了）。
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RHYTHM, warroomError, ERR } from '../../shared-types/src/index.js';

export const DEFAULT_CONFIG = Object.freeze({
  rhythm: 'restricted',        // 新战役默认节奏档
  timeoutMin: 30,              // sweep 默认超时（分钟）
  adapterKind: 'fake',         // fake | local | bridge
  bridgeTimeoutMs: 2000,       // 桥等待执行层应答上限
  fenceImage: 'alpine:latest', // 围栏任务容器镜像
  waveConcurrency: null,       // 波内并发提示（null = 由节奏档决定）
});

const FILE = 'warroom.json';

export function configPath(home) { return join(home, FILE); }

/**
 * 读取并校验配置；不存在则返回默认（不自动写文件）。
 * @param {string} home
 * @param {{allowMissing?:boolean}} opts
 */
export function loadConfig(home, { allowMissing = true } = {}) {
  const path = configPath(home);
  if (!existsSync(path)) {
    if (!allowMissing) throw warroomError(ERR.E_GATE_MISSING_TUPLE, `配置文件不存在：${path}`);
    return { ...DEFAULT_CONFIG, _source: 'defaults' };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw warroomError(ERR.E_GATE_MISSING_TUPLE, `配置文件不是合法 JSON：${path}（${e.message}）`); }

  const cfg = { ...DEFAULT_CONFIG, ...raw, _source: path };
  const errors = [];
  if (!RHYTHM.includes(cfg.rhythm)) errors.push(`rhythm 必须是 ${RHYTHM.join('|')}`);
  if (!Number.isInteger(cfg.timeoutMin) || cfg.timeoutMin <= 0) errors.push('timeoutMin 必须是正整数');
  if (!['fake', 'local', 'bridge'].includes(cfg.adapterKind)) errors.push('adapterKind 必须是 fake|local|bridge');
  if (!Number.isInteger(cfg.bridgeTimeoutMs) || cfg.bridgeTimeoutMs <= 0) errors.push('bridgeTimeoutMs 必须是正整数');
  if (cfg.waveConcurrency !== null && (!Number.isInteger(cfg.waveConcurrency) || cfg.waveConcurrency <= 0)) {
    errors.push('waveConcurrency 必须是正整数或 null');
  }
  const unknown = Object.keys(raw).filter((k) => !(k in DEFAULT_CONFIG));
  if (unknown.length) errors.push(`未知字段：${unknown.join(', ')}（拼错会被静默忽略，故此处报错）`);
  if (errors.length) throw warroomError(ERR.E_GATE_MISSING_TUPLE, `配置校验失败：${errors.join('；')}`);
  return cfg;
}

/** 写出示例配置（--force 覆盖）。 */
export function writeExampleConfig(home, { force = false, overrides = {} } = {}) {
  const path = configPath(home);
  if (existsSync(path) && !force) throw warroomError(ERR.E_GATE_MISSING_TUPLE, `已存在：${path}（用 --force 覆盖）`);
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { path, config: cfg };
}
