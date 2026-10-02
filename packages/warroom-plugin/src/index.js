// GUNGNIR DSH 插件入口。
export { plugin, apply, createWarroomService, makeAdapter, SERVICE_NAME } from './service.js';
export { dshTools, TOOL_NAMES } from './tools.js';
export { default } from './service.js'; // cordis 可加载入口：name=dsh-warroom 时宿主取默认导出（{name, apply}）
