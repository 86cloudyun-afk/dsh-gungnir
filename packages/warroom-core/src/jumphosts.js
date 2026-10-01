// 跳板池（ADR-002 D6）：op_log 先行、租约 TTL、故障补偿、未证实释放进隔离。
import { randomUUID } from 'node:crypto';
import { ERR, warroomError } from '../../shared-types/src/index.js';

const now = () => new Date().toISOString();

export class JumphostManager {
  /**
   * @param {{globalDb:object, getFactStore:(engagementId:string)=>object, egressProbe?:(host:object)=>{ok:boolean, exit_ip:string|null}, runtimeProbe?:(lease:object)=>boolean, ttlMinutes?:number}} opts
   */
  constructor({ globalDb, getFactStore, egressProbe, runtimeProbe, ttlMinutes = 30 }) {
    this.g = globalDb;
    this.getFactStore = getFactStore;
    this.egressProbe = egressProbe ?? ((h) => ({ ok: true, exit_ip: h.addr_v4 }));
    this.runtimeProbe = runtimeProbe ?? (() => false); // 默认：资源未在运行
    this.ttlMinutes = ttlMinutes;
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

  /** 分配：op 意图 → 租约 → 激活 → 出口实测（写 fact，可注入故障）→ op activated。 */
  acquire({ engagement_id, target }) {
    const candidates = this.g.prepare("SELECT * FROM jumphosts ORDER BY used_today ASC, id ASC").all()
      .filter((h) => this._usable(h.id));
    if (candidates.length === 0) throw warroomError(ERR.E_NO_JUMPHOST, 'no usable jumphost');
    const host = candidates[0];

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
      const socks = `socks5://127.0.0.1:${20000 + Math.floor(Math.random() * 20000)}`;
      const store = this.getFactStore(engagement_id);
      store.recordRoute({ route_id, lease_id, jumphost_id: host.id, socks });
      store.recordEgressCheck({ jumphost_id: host.id, exit_ip: probe.exit_ip, route_id });
      this.g.prepare('UPDATE jumphosts SET used_today = used_today + 1, day = ? WHERE id = ?')
        .run(now().slice(0, 10), host.id);
      this.g.prepare("UPDATE op_log SET state = 'activated' WHERE op_id = ?").run(op_id);
      return { lease_id, route_id, jumphost_id: host.id, socks };
    } catch (e) {
      // 4) 补偿：资源拆除 + 租约释放 + op_log 补偿态；fact 审计恢复后补齐
      this.teardowns.push({ lease_id, jumphost_id: host.id, reason: String(e.message || e) });
      this.g.prepare('UPDATE leases SET state = ? WHERE lease_id = ?').run('released', lease_id);
      this.g.prepare("UPDATE op_log SET state = 'compensation_pending' WHERE op_id = ?").run(op_id);
      this.g.prepare("UPDATE op_log SET state = 'released', recovered_at = ? WHERE op_id = ?").run(now(), op_id);
      throw warroomError(ERR.E_COMPENSATED, `acquire compensated: ${e.code ?? e.message}`, { lease_id });
    }
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
