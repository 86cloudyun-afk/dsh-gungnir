// DSH 插件 host 服务：进程级单例，持有事实库、门闸 broker、跳板池与命令队列。
// 设计：不 import 任何 DSH 内部模块（依赖倒置）——只暴露纯 JS 服务工厂；
// apply(ctx) 按 cordis 约定向宿主注册服务与工具，便于在真实 DSH 中挂载。
import { join } from 'node:path';
import { Broker } from '../../warroom-core/src/broker.js';
import { JumphostManager } from '../../warroom-core/src/jumphosts.js';
import { FakeAdapter } from '../../warroom-core/src/adapters/fake.js';
import { RedteamModeAdapter, LocalRedteamDriver } from '../../warroom-core/src/adapters/redteam-mode.js';
import { DshRedteamDriver } from '../../warroom-core/src/adapters/dsh-bridge.js';
import { rehydrate } from '../../warroom-core/src/rehydrate.js';
import { loadConfig } from '../../warroom-core/src/config.js';

export const SERVICE_NAME = 'warroom';

/** 依执行层选择 adapter：fake（离线）| local（内存红队驱动）| bridge（DSH 文件桥）。 */
export function makeAdapter(kind = 'fake', opts = {}) {
  switch (kind) {
    case 'bridge':
      return new RedteamModeAdapter({
        driver: new DshRedteamDriver({ root: opts.bridgeRoot ?? join(opts.home ?? '.', 'dsh-bridge'), ...opts.driver }),
      });
    case 'local':
      return new RedteamModeAdapter({ driver: new LocalRedteamDriver() });
    default:
      return new FakeAdapter();
  }
}

/**
 * 工厂：创建 GUNGNIR 服务（host 平面）。
 * @param {{home:string, adapterKind?:string, adapter?:object}} opts
 */
export function createWarroomService({ home, adapterKind = null, adapter } = {}) {
  if (!home) throw new Error('createWarroomService 需要 home');
  const cfg = loadConfig(home);
  const kind = adapterKind ?? cfg.adapterKind;
  const broker = new Broker({ home, adapter: adapter ?? makeAdapter(kind, { home }) });
  const jumps = new JumphostManager({
    globalDb: broker.global,
    getFactStore: (id) => broker._eng(id).store,
    listEngagements: () => broker.listEngagements(),   // 路由巡检需要跨战役清单
  });
  // 启动即再水化：把非终态命令交回 adapter（跨进程/重启恢复执行层视角）
  const recovered = rehydrate(broker);
  return { broker, jumps, recovered, home };
}

/** cordis 形态的插件入口：向宿主注册服务（若宿主支持），并返回服务实例。 */
export function apply(ctx, config = {}) {
  const home = config.home ?? process.env.WARROOM_HOME ?? './.warroom';
  const service = createWarroomService({ home, adapterKind: config.adapterKind ?? 'fake' });
  if (typeof ctx?.provide === 'function') ctx.provide(SERVICE_NAME, service);
  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      try { service.broker.global.close(); } catch { /* 关闭失败不阻断卸载 */ }
    });
  }
  return service;
}

export const plugin = { name: 'dsh-warroom', apply };
export default plugin;
