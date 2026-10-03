// DSH 桥驱动：以文件协议与 DSH host 侧的执行层通信（SPI Driver 实现之一）。
// 优点：协议可见、可离线测试、崩溃后可从 spool 恢复；真实链路只需 DSH 侧写一个应答器。
// 协议见 docs/DSH-BRIDGE-PROTOCOL.md。所有写文件走 tmp + rename（原子），避免半截文件被读到。
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ERR, warroomError } from '../../../shared-types/src/index.js';

const PROTOCOL = 'gungnir-bridge/1';

function atomicWrite(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, path);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export class FileBridgeDriver {
  /**
   * @param {{root:string, onJob?:(job:object)=>void, pollMs?:number, timeoutMs?:number}} opts
   *   root      spool 根目录（默认 <home>/dsh-bridge）
   *   onJob     可选：进程内应答器钩子（测试用，同步应答）
   *   timeoutMs 等待执行层应答的上限；超时 → unknown（绝不默认失败）
   */
  constructor({ root, onJob, pollMs = 20, timeoutMs = 2000, background = false }) {
    this.root = root;
    this.outbox = join(root, 'outbox');
    this.inbox = join(root, 'inbox');
    mkdirSync(this.outbox, { recursive: true });
    mkdirSync(this.inbox, { recursive: true });
    this.onJob = onJob;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.background = background;
    this.generations = new Map();
  }

  _jobPath(id) { return join(this.outbox, `${id}.job.json`); }
  _statusPath(id) { return join(this.inbox, `${id}.status.json`); }
  _factsPath(id) { return join(this.inbox, `${id}.facts.json`); }
  _probesPath(id) { return join(this.inbox, `${id}.probes.json`); }
  _stopPath(id) { return join(this.outbox, `${id}.stop.json`); }

  _readTaskEvidence(path, externalId) {
    let source;
    try { source = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null; // No response is still unknown, not success.
      throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'bridge evidence is unreadable or malformed');
    }
    if (typeof source?.external_id !== 'string' || !source.external_id) {
      throw warroomError(ERR.E_GATE_MISSING_TUPLE, 'bridge evidence requires a non-empty external identity');
    }
    if (source.external_id !== externalId) {
      throw warroomError(ERR.E_APPROVAL_MISMATCH, 'bridge evidence belongs to another task');
    }
    return source;
  }

  _awaitFile(path, phase, externalId) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const v = this._readTaskEvidence(path, externalId);
      if (v) return v;
      // 真实模式：等执行层落盘；这里用忙等 + 小睡（Node 同步上下文下最简实现）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.pollMs);
    }
    return null; // 超时 → 调用方转 unknown
  }

  spawnRole(role, contract) {
    this.seq += 1;
    const external_id = contract.task_id ?? `bridge-${this.seq}`;
    this.generations.set(external_id, contract.generation);
    const job = { protocol: PROTOCOL, external_id, role, contract, background: this.background, issued_at: new Date().toISOString() };
    atomicWrite(this._jobPath(external_id), job);
    if (this.background) return { external_id, state: 'queued' };
    if (this.onJob) this.onJob(job); // 进程内应答器（测试/彩排）
    const st = this._awaitFile(this._statusPath(external_id), 'spawn', external_id);
    return { external_id, state: st?.state ?? 'unknown' };
  }

  stopRole(externalId, _reason, { request_id } = {}) {
    if (this.background && (typeof request_id !== 'string' || !request_id)) throw new Error('durable cancellation identity required');
    const source = this.statusOf(externalId);
    const after_event_seq = source?.generation === this.generations.get(externalId) &&
      Number.isSafeInteger(source.event_seq) && source.event_seq >= 0 ? source.event_seq : 0;
    atomicWrite(this._stopPath(externalId), { protocol: PROTOCOL, external_id: externalId,
      generation: this.generations.get(externalId), request_id, after_event_seq, action: 'stop', at: new Date().toISOString() });
    if (this.background) return { state: 'cancel_requested' };
    const st = this._awaitFile(this._statusPath(externalId), 'stop', externalId);
    return { state: st?.state ?? 'unknown' };
  }

  statusOf(externalId) {
    const st = this._readTaskEvidence(this._statusPath(externalId), externalId);
    return st ? { state: st.state, generation: st.generation, event_seq: st.event_seq } : null;
  }

  attachRole(_role, contract) {
    this.generations.set(contract.task_id, contract.generation);
    const job = readJson(this._jobPath(contract.task_id));
    if (job && (job.external_id !== contract.task_id || job.contract?.generation !== contract.generation)) {
      throw new Error('existing bridge job identity/generation mismatch');
    }
    // Recovery never creates a file, including after an attempted write was lost.
    return { external_id: contract.task_id, state: this.statusOf(contract.task_id)?.state ?? 'unknown' };
  }

  collectReceipt(externalId) {
    const f = this._readTaskEvidence(this._factsPath(externalId), externalId);
    return { generation: f?.generation, members: f?.members ?? [] };
  }

  observationOf(externalId) {
    const st = readJson(this._statusPath(externalId));
    if (!st || st.external_id !== externalId) return null;
    const f = readJson(this._factsPath(externalId));
    const receipt = f && f.external_id === externalId &&
      (!this.background || f.event_seq === st.event_seq) ? {
      receipt_id: `bridge-${externalId}-${st.event_seq}`, generation: f.generation, members: f.members,
    } : null;
    return { state: st.state, generation: st.generation, event_seq: st.event_seq, receipt };
  }

  collectFacts(externalId) {
    const f = this._readTaskEvidence(this._factsPath(externalId), externalId);
    return f?.members ?? [];
  }

  /** 探针：执行层上报"各资源是否已停止"，host 侧可再叠加自己的实测（端口/PID/容器）。 */
  resourcesOf(externalId) {
    const source = readJson(this._probesPath(externalId));
    if (source?.external_id !== externalId || source.generation !== this.generations.get(externalId) ||
        !Array.isArray(source.resources)) return [];
    // Suspected resource identities remain required even if their proof is stale.
    return source.resources.map((r, i) => ({ id: typeof r.id === 'string' && r.id ? r.id : `${externalId}-unidentified-${i}`,
      kind: typeof r.kind === 'string' && r.kind ? r.kind : 'unknown' }));
  }

  probes(externalId, { stopping = false, stop_request_id, generation = this.generations.get(externalId) } = {}) {
    const p = this.background ? readJson(this._probesPath(externalId))
      : this._readTaskEvidence(this._probesPath(externalId), externalId);
    if (this.background && (p?.external_id !== externalId || p?.generation !== this.generations.get(externalId) || p.generation !== generation)) return [];
    if (this.background) {
      const status = readJson(this._statusPath(externalId));
      if (!Number.isSafeInteger(p.event_seq) || p.event_seq <= 0 || status?.external_id !== externalId ||
          status.generation !== p.generation || status.event_seq !== p.event_seq) return [];
      if (stopping) {
        const stop = readJson(this._stopPath(externalId));
        if (stop?.generation !== p.generation || !Number.isSafeInteger(stop.after_event_seq) ||
            p.event_seq <= stop.after_event_seq || typeof stop_request_id !== 'string' || !stop_request_id ||
            stop.request_id !== stop_request_id ||
            p.stop_request_id !== stop.request_id) return [];
      }
    }
    if (!p?.resources) return [];
    return p.resources.map((r) => ({
      id: r.id,
      kind: r.kind,
      reported_stopped: r.stopped === true,
      check: () => r.stopped === true,
    }));
  }

  /** spool 中未应答的 job（重启后可用于恢复与审计）。 */
  pendingJobs() {
    return readdirSync(this.outbox)
      .filter((f) => f.endsWith('.job.json'))
      .map((f) => readJson(join(this.outbox, f)))
      .filter(Boolean)
      .filter((j) => !existsSync(this._statusPath(j.external_id)));
  }
}

/** DSH 红队模式专用驱动：协议版本 + 角色映射（与 RedteamModeAdapter 搭配使用）。 */
export class DshRedteamDriver extends FileBridgeDriver {
  constructor(opts) {
    super(opts);
    this.protocol = PROTOCOL;
  }
}
