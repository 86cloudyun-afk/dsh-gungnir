// GUNGNIR DSH 插件入口。
export { plugin, apply, createWarroomService, makeAdapter, SERVICE_NAME } from './service.js';
export { dshTools, TOOL_NAMES } from './tools.js';
// cordis 插件约定：宿主按包名解析后取 `.` 入口的 **default 导出**作为插件。
// 本包按路径挂载时走 src/dsh-entry.mjs；按包名（`dsh plugin add` + name: dsh-warroom）挂载时走这里。
export { default } from './service.js';
