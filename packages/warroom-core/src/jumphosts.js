// 跳板池（ADR-002 D6）：op_log 先行、租约 TTL、故障补偿、未证实释放进隔离。
import { randomUUID } from 'node:crypto';
import { ERR, warroomError } from '../../shared-types/src/index.js';

const now = () => new Date().toISOString();
const nowMs = () => Date.now();

export class JumphostManager {
  /**
   * @param {{globalDb:object, getFactStore:(engagementId:string)=>object, egressProbe?:(host:object)=>{ok:boolean, exit_ip:string|null}, runtimeProbe?:(lease:object)=>boolean, ttlMinutes?:number}} opts
   */
  constructor({ globalDb, getFactStore, egressProbe, runtimeProbe, ttlMinutes = 30,
                quotaPerDay = 3, listEngagements = null } = {}) {
    this.g = globalDb;
    this.getFactStore = getFactStore;
    this.egressProbe = egressProbe ?? ((h) => ({ ok: true, exit_ip: h.addr_v4 }));
    this.runtimeProbe = runtimeProbe ?? (() => false); // 默认：资源未在运行
    this.ttlMinutes = ttlMinutes;
    this.quotaPerDay = quotaPerDay;
    this.listEngagements = listEngagements;   // 宿主注入：跨战役巡检需要战役清单
    this.teardowns = []; // 补偿动作记录（测试可断言）
  }

  /** advisory/jumphosts.md 的导入替代：此后表为真源。 */
  importHosts(hosts) {
    const ins = this.g.prepare(`INSERT INTO jumphosts
      (id, role, ssh_host, status, quota, used_today, day, addr_v4, addr_v6)
      VALUES (?, ?, ?, 'healthy', ?, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET role=excluded.role, ssh_host=excluded.ssh_host,
        addr_v4=excluded.addr_v4, addr_v6=excluded.addr_v6`);
    for (const h of hosts) {
      ins.run(h.id, h.role ?? 'pure-relay', h.ssh_host ?? null, h.quota ?? 3,
        new Date().toISOString().slice(0, 10), h.addr_v4 ?? null, h.addr_v6 ?? null);
    }
    return hosts.length;
  }

  _usable(hostId) {
    const h = this.g.prepare('SELECT * FROM jumphosts WHERE id = ?').get(hostId);
    if (!h) return false;
    if (h.status !== 'healthy') return false;
    const cd = this.g.prepare('SELECT 1 FROM cooldowns WHERE jumphost_id = ? AND until > ?').get(hostId, now());
    if (cd) return false;
    const day = now().slice(0, 10);
    const used = h.day === day ? h.used_today : 0;
    return used < h.quota;
  }

  /**
   * 分配：op 意图 → 租约 → 激活 → 出口实测（写 fact，可注入故障）→ op activated。
   * @param {{engagement_id:string, target?:string, jumphost_id?:string|null}} p
   *   `jumphost_id` 显式指定出口（操作员按轮换策略挑机器）。不指定时**优先选有真实出口端点的**
   *   （`ssh_host` 为 socks URL），其次才是其它可用跳板——否则会挑到"台账里有、但没有出口"的机器，
   *   拿到一条占位路由（真机踩过）。
   */
  acquire({ engagement_id, target, jumphost_id = null }) {
    const all = this.g.prepare('SELECT * FROM jumphosts').all().filter((h) => this._usable(h.id));
    let host;
    if (jumphost_id) {
      host = all.find((h) => h.id === jumphost_id);
      if (!host) throw warroomError(ERR.E_NO_JUMPHOST, `指定的跳板不可用：${jumphost_id}`);
    } else {
      const withEndpoint = all.filter((h) => /^socks5h?:\/\//.test(String(h.ssh_host ?? '')));
      const pool = withEndpoint.length > 0 ? withEndpoint : all;
      if (pool.length === 0) throw warroomError(ERR.E_NO_JUMPHOST, 'no usable jumphost');
      host = pool.slice().sort((a, b) => (a.used_today - b.used_today) || a.id.localeCompare(b.id))[0];
    }

    // 1) op 意图先行（补偿唯一真源，ADR-002 D6）
    const op_id = randomUUID();
    const lease_id = `lease_${randomUUID()}`;
    this.g.prepare(`INSERT INTO op_log (op_id, kind, ref_id, state, detail, ts)
      VALUES (?, 'jumphost_acquire', ?, 'intent', ?, ?)`).run(op_id, host.id, `lease=${lease_id}`, now());

    // 2) 租约
    const expires = new Date(Date.now() + this.ttlMinutes * 60_000).toISOString();
    this.g.prepare(`INSERT INTO leases (lease_id, jumphost_id, engagement_id, state, expires_at, heartbeat_at, ts)
      VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(lease_id, host.id, engagement_id, expires, now(), now());

    // 3) 激活 + 出口实测（写 fact.db —— 可注入故障的补偿点）
    try {
      const probe = this.egressProbe(host);
      if (!probe.ok) throw warroomError(ERR.E_COMPENSATED, 'egress probe failed');
      const route_id = `route_${randomUUID()}`;
      // 出口端点**以操作员给的为准**：`ssh_host` 写成 socks URL（如 socks5h://127.0.0.1:21071）时直接采用。
      // 真机教训：旧实现无条件编一个随机端口（20000+rand），路由里于是挂着一条**并不存在**的出口，
      // 排障时会把"出口 DEAD"误判成执行层问题。未提供端点时如实标注来源，不再假装有出口。
      const provided = /^socks5h?:\/\//.test(String(host.ssh_host ?? '')) ? String(host.ssh_host) : null;
      const socks = provided ?? `socks5://127.0.0.1:${20000 + Math.floor(Math.random() * 20000)}`;
      const socks_source = provided ? 'operator' : 'placeholder';
      const store = this.getFactStore(engagement_id);
      store.recordRoute({ route_id, lease_id, jumphost_id: host.id, socks });
      store.recordEgressCheck({ jumphost_id: host.id, exit_ip: probe.exit_ip, route_id });
      this.g.prepare('UPDATE jumphosts SET used_today = used_today + 1, day = ? WHERE id = ?')
        .run(now().slice(0, 10), host.id);
      this.g.prepare("UPDATE op_log SET state = 'activated' WHERE op_id = ?").run(op_id);
      return {
        lease_id, route_id, jumphost_id: host.id, socks, socks_source,
        exit_ip: probe.exit_ip,
        note: socks_source === 'operator'
          ? '出口端点为操作员提供（ssh_host 里的 socks URL）'
          : '未提供出口端点：socks 为占位值，真实端点须由操作员经 GUNGNIR_EXIT_SOCKS 给出',
      };
    } catch (e) {
      // 4) 补偿：资源拆除 + 租约释放 + op_log 补偿态；fact 审计恢复后补齐
      this.teardowns.push({ lease_id, jumphost_id: host.id, reason: String(e.message || e) });
      this.g.prepare('UPDATE leases SET state = ? WHERE lease_id = ?').run('released', lease_id);
      this.g.prepare("UPDATE op_log SET state = 'compensation_pending' WHERE op_id = ?").run(op_id);
      this.g.prepare("UPDATE op_log SET state = 'released', recovered_at = ? WHERE op_id = ?").run(now(), op_id);
      throw warroomError(ERR.E_COMPENSATED, `acquire compensated: ${e.code ?? e.message}`, { lease_id });
    }
  }

  /**
   * 活跃 route 巡检（框架 §3.3 / 宪法 §12）：
   *   · 租约已到期/隔离 → 对应 route 转 `stale`（不再被围栏当作出口）
   *   · 路由长时间无心跳（默认 3×TTL）→ `stale` 并留痕，提示重新取出口
   * 只改状态、不删记录：证据链保留，收口仍需显式 releaseRoute。
   * @returns {{stale:Array<{route_id:string, reason:string, age_min:number}>, scanned:number}}
   */
  sweepRoutes({ ttlMinutes = this.ttlMinutes, staleFactor = 3 } = {}) {
    const leases = this.g.prepare('SELECT lease_id, state, expires_at, heartbeat_at FROM leases').all();
    const leaseById = new Map(leases.map((l) => [l.lease_id, l]));
    const maxIdleMs = ttlMinutes * staleFactor * 60_000;
    const stale = [];
    let scanned = 0;
    const routes = this._routesByEngagement();
    for (const { engagementId, routes: rows } of routes) {
      const store = this.getFactStore(engagementId);
      for (const r of rows) {
        if (r.state !== 'active') continue;
        scanned += 1;
        const lease = leaseById.get(r.lease_id);
        const ageMs = nowMs() - Date.parse(r.ts);
        let reason = null;
        if (lease && lease.state !== 'active') reason = `租约已${lease.state === 'released' ? '释放' : '隔离'}`;
        else if (lease && Date.parse(lease.expires_at) <= nowMs()) reason = '租约已到期';
        else if (ageMs > maxIdleMs) reason = `路由无心跳超过 ${staleFactor}×TTL（${Math.round(ageMs / 60000)} 分钟）`;
        if (!reason) continue;
        store.db.prepare("UPDATE jump_routes SET state = 'stale' WHERE route_id = ?").run(r.route_id);
        store.appendGateLog({ decision: 'route_stale', detail: `${r.route_id}: ${reason}`, request: r.socks });
        stale.push({ route_id: r.route_id, engagement_id: engagementId, reason, age_min: Math.round(ageMs / 60000) });
      }
    }
    return { stale, scanned };
  }

  /**
   * 遍历所有战役库的路由表（只读，表不存在即跳过）。
   * 战役清单由宿主注入（`listEngagements`）：路由属战役库，global 里没有它们的索引。
   */
  _routesByEngagement() {
    const out = [];
    const ids = typeof this.listEngagements === 'function' ? this.listEngagements() : [];
    for (const id of ids) {
      try {
        const store = this.getFactStore(id);
        out.push({ engagementId: id, routes: store.db.prepare('SELECT * FROM jump_routes ORDER BY ts').all() });
      } catch { /* 库缺失或表不存在：跳过 */ }
    }
    return out;
  }

  /** 路由心跳：续期租约并刷新路由 ts（活跃证明）。 */
  heartbeatRoute({ route_id, engagementId, lease_id = null }) {
    const store = this.getFactStore(engagementId);
    const route = store.db.prepare('SELECT * FROM jump_routes WHERE route_id = ?').get(route_id);
    if (!route) throw warroomError(ERR.E_TASK_NOT_FOUND, `route ${route_id} 不存在`);
    if (route.state !== 'active') throw warroomError(ERR.E_TASK_NOT_FOUND, `route 状态为 ${route.state}，无法续期`);
    store.db.prepare('UPDATE jump_routes SET ts = ? WHERE route_id = ?').run(now(), route_id);
    store.appendGateLog({ decision: 'route_heartbeat', detail: route_id, request: route.socks });
    const lease = lease_id ?? route.lease_id;
    if (lease) {
      this.g.prepare('UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE lease_id = ?').run(
        now(), new Date(nowMs() + this.ttlMinutes * 60_000).toISOString(), lease);
    }
    return { route_id, lease_id: lease, heartbeat_at: now(), ttl_minutes: this.ttlMinutes };
  }

  /** 台账：主机 / 租约 / 路由（routes 属战役库，按 engagement 查）。 */
  status(engagementId = null) {
    const hosts = this.g.prepare('SELECT * FROM jumphosts ORDER BY id').all();
    const leases = this.g.prepare('SELECT * FROM leases ORDER BY ts DESC').all();
    let routes = [];
    if (engagementId) {
      try { routes = this.getFactStore(engagementId).db.prepare('SELECT * FROM jump_routes ORDER BY ts').all(); }
      catch { routes = []; }
    }
    return {
      hosts,
      leases,
      routes,
      summary: {
        hosts: hosts.length,
        healthy: hosts.filter((h) => h.status === 'healthy').length,
        quarantined: hosts.filter((h) => h.status === 'quarantined').length,
        active_leases: leases.filter((l) => l.state === 'active').length,
        active_routes: routes.filter((r) => r.state === 'active').length,
      },
    };
  }

  /** 收口：释放租约并把对应路由标记为已拆除（幂等）。 */
  releaseRoute({ route_id, lease_id = null, engagementId }) {
    const store = this.getFactStore(engagementId);
    const route = store.db.prepare('SELECT * FROM jump_routes WHERE route_id = ?').get(route_id);
    if (!route) throw warroomError(ERR.E_TASK_NOT_FOUND, `route ${route_id} 不存在`);
    store.db.prepare("UPDATE jump_routes SET state = 'released' WHERE route_id = ?").run(route_id);
    const lease = lease_id ?? route.lease_id;
    if (lease) this.release(lease);
    return { route_id, lease_id: lease, state: 'released' };
  }

  release(lease_id) {
    this.g.prepare("UPDATE leases SET state = 'released', heartbeat_at = ? WHERE lease_id = ?").run(now(), lease_id);
  }

  heartbeat(lease_id) {
    this.g.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?').run(now(), lease_id);
  }

  /**
   * TTL 巡检：到期租约先实测运行资源；未证实释放 → quarantined（禁止再分配，ADR-002 D6）。
   */
  sweepExpired() {
    const expired = this.g.prepare("SELECT * FROM leases WHERE state = 'active' AND expires_at <= ?")
      .all(now());
    const out = [];
    for (const l of expired) {
      if (this.runtimeProbe(l)) {
        this.g.prepare("UPDATE leases SET state = 'quarantined' WHERE lease_id = ?").run(l.lease_id);
        this.g.prepare("UPDATE jumphosts SET status = 'quarantined' WHERE id = ?").run(l.jumphost_id);
        this.g.prepare(`INSERT INTO op_log (op_id, kind, ref_id, state, detail, ts)
          VALUES (?, 'lease_sweep', ?, 'quarantined', ?, ?)`)
          .run(randomUUID(), l.lease_id, `jumphost ${l.jumphost_id} runtime still up`, now());
        out.push({ lease_id: l.lease_id, state: 'quarantined' });
      } else {
        this.g.prepare("UPDATE leases SET state = 'released' WHERE lease_id = ?").run(l.lease_id);
        out.push({ lease_id: l.lease_id, state: 'released' });
      }
    }
    return out;
  }
}
