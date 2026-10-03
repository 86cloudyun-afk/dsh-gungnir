// DSH 插件 host 服务：进程级单例，持有事实库、门闸 broker、跳板池与命令队列。
// 设计：不 import 任何 DSH 内部模块（依赖倒置）——只暴露纯 JS 服务工厂；
// apply(ctx) 按 cordis 约定向宿主注册服务与工具，便于在真实 DSH 中挂载。
import { join } from 'node:path';
import { Broker } from '../../warroom-core/src/broker.js';
import { aggregateView } from '../../warroom-core/src/aggregate.js';
import { JumphostManager } from '../../warroom-core/src/jumphosts.js';
import { FakeAdapter } from '../../warroom-core/src/adapters/fake.js';
import { RedteamModeAdapter, LocalRedteamDriver } from '../../warroom-core/src/adapters/redteam-mode.js';
import { DshRedteamDriver } from '../../warroom-core/src/adapters/dsh-bridge.js';
import { rehydrate } from '../../warroom-core/src/rehydrate.js';
import { loadConfig } from '../../warroom-core/src/config.js';
import { HostTaskRunner } from './host-tasks.js';

export const SERVICE_NAME = 'warroom';

/** 依执行层选择 adapter：fake（离线）| local（内存红队驱动）| bridge（DSH 文件桥）。
 * 未知 kind 一律抛错（fail-closed）：不得静默退回 FakeAdapter——否则操作员以为走了
 * bridge/local，实际在离线假适配器上「跑通」，静默降级。缺省/undefined → fake。
 */
export function makeAdapter(kind = 'fake', opts = {}) {
  const k = kind ?? 'fake';
  switch (k) {
    case 'bridge':
      return new RedteamModeAdapter({
        driver: new DshRedteamDriver({ root: opts.bridgeRoot ?? join(opts.home ?? '.', 'dsh-bridge'), background: opts.background ?? false, ...opts.driver }),
      });
    case 'local':
      return new RedteamModeAdapter({ driver: new LocalRedteamDriver() });
    case 'fake':
      return new FakeAdapter();
    default: {
      const e = new Error(`unknown adapterKind ${JSON.stringify(k)}（允许：fake|local|bridge）`);
      e.code = 'E_GATE_MISSING_TUPLE';
      throw e;
    }
  }
}

/**
 * 工厂：创建 GUNGNIR 服务（host 平面）。
 * @param {{home:string, adapterKind?:string, adapter?:object}} opts
 */
export function createWarroomService({ home, adapterKind = null, adapter, hostDelivery = null, autoStart = true } = {}) {
  if (!home) throw new Error('createWarroomService 需要 home');
  const cfg = loadConfig(home);
  const kind = adapterKind ?? cfg.adapterKind;
  const broker = new Broker({ home, adapter: adapter ?? makeAdapter(kind, { home, background: !!hostDelivery }) });
  const jumps = new JumphostManager({
    globalDb: broker.global,
    getFactStore: (id) => broker._eng(id).store,
    listEngagements: () => broker.listEngagements(),   // 路由巡检需要跨战役清单
  });
  // 启动即再水化：把非终态命令交回 adapter（跨进程/重启恢复执行层视角）
  const recovered = rehydrate(broker);
  // 聚合视图（只读）：工具与 CLI 共用
  const aggregateViewOf = ({ sessionsDbPath = null } = {}) => aggregateView({ home, sessionsDbPath });
  const tasks = hostDelivery ? new HostTaskRunner({ broker, delivery: hostDelivery }) : null;
  if (tasks && autoStart) tasks.start();
  let closing;
  const dispose = () => closing ??= (async () => {
    await tasks?.dispose();
    for (const eng of broker.engagements.values()) eng.db.close();
    broker.knowledge.db.close();
    broker.global.close();
  })();
  return { broker, jumps, recovered, home, tasks, dispose, aggregateView: aggregateViewOf };
}

/** cordis 形态的插件入口：向宿主注册服务（若宿主支持），并返回服务实例。 */
export function apply(ctx, config = {}) {
  const home = config.home ?? process.env.WARROOM_HOME ?? './.warroom';
  const service = createWarroomService({ home, adapterKind: config.adapterKind ?? 'fake' });
  if (typeof ctx?.provide === 'function') ctx.provide(SERVICE_NAME, service);
  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => service.dispose());
  }
  return service;
}

export const plugin = { name: 'dsh-warroom', apply };
export default plugin;
