// 工具包装：把 warroom-tools 的定义映射为 DSH 侧工具对象（execute 绑定到 host 服务）。
// 这里只做形态转换与参数校验；业务逻辑全在 broker（服务端唯一副作用通道）。
import { TOOLS } from '../../warroom-tools/src/index.js';
import { validateFourTuple, ERR } from '../../shared-types/src/index.js';

/**
 * @param {{broker:object}} service
 * @returns {Array<{name:string, description:string, input_schema:object, execute:(args:object)=>any}>}
 */
export function dshTools(service) {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    execute: (args = {}) => {
      // 执行类工具先做四元组形状校验（其余校验在 broker 内部，缺一不可）
      if (t.name === 'warroom_execute') {
        const contract = args.contract ?? {};
        validateFourTuple({
          engagement_id: args.engagement_id,
          auth_version: args.auth_version,
          task_id: contract.task_id ?? args.task_id ?? 'pre-allocated-by-broker',
          action_class: contract.action_class ?? args.action_class ?? '',
        });
      }
      return t.run({ broker: service.broker, jumps: service.jumps }, args);
    },
  }));
}

/** 供宿主/测试使用的工具名清单（允许清单校验用）。 */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

export { ERR };
