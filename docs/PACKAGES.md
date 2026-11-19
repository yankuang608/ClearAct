# 八包构建与仓库外消费

ClearAct 提供八个 ESM 包：`@clearact/core`、`@clearact/dom`、`@clearact/element-plus`、`@clearact/react`、`@clearact/vue`、`@clearact/observer`、`@clearact/server`、`@clearact/mcp`。公开入口指向 `dist`，消费方不需要 tsx 或框架源码。尚未发布 npm；项目原始代码采用根目录 MIT 许可证，第三方依赖许可保持不变。

## 构建与归档

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm build
corepack pnpm check:packages
```

SDK 按 core、dom、React、Vue、element-plus、observer 顺序构建；server/MCP 使用 Node 平台构建。每包生成 `dist/index.js` 与 `dist/index.d.ts`，server/MCP 另含带 shebang 的 `dist/cli.js` 和 CLI 类型。归档位于 `work/package-distribution/clearact-<包>-0.1.0.tgz`，同目录保存 hash、tar 内容、独立 consumer 的安装、导入与类型检查证据。包内 README 会被包含，不包含源码、测试、业务环境或凭据。

consumer 默认离线安装。缓存不完整时检查明确失败；先准备缓存，或用 `CLEARACT_CONSUMER_OFFLINE=0` 允许联网。`CLEARACT_PACKAGES_OUTPUT` 设置输出目录，`CLEARACT_PNPM_STORE` 指定缓存根目录，`CLEARACT_PNPM_BINARY` 指定 pnpm 可执行文件。默认使用当前 node_modules 的实际 store。

## 外部消费

复制需要的 tgz 到目标 vendor 目录，再由项目包管理器安装：

```sh
pnpm add ./vendor/clearact-core-0.1.0.tgz ./vendor/clearact-react-0.1.0.tgz ./vendor/clearact-observer-0.1.0.tgz react
```

Vue 使用 core/vue/observer；原生 JavaScript 页面使用 core/observer。adapter 将 core 声明为 peer，宿主提供同版本系列的 core。所有模块统一从 `@clearact/*` 导入，不添加指向 ClearAct checkout 的 alias，也不混用源码类与分发声明。保持宿主原生 React/Vue 版本。

server 声明 core 依赖。尚未发布 registry 时，pnpm consumer 应把八包固定到本地归档，避免传递依赖查询 registry；本仓 consumer 检查与 WebWorkBench 使用相同约定：

```json
{"pnpm":{"overrides":{
  "@clearact/core":"file:vendor/clearact-core-0.1.0.tgz",
  "@clearact/dom":"file:vendor/clearact-dom-0.1.0.tgz",
  "@clearact/element-plus":"file:vendor/clearact-element-plus-0.1.0.tgz",
  "@clearact/react":"file:vendor/clearact-react-0.1.0.tgz",
  "@clearact/vue":"file:vendor/clearact-vue-0.1.0.tgz",
  "@clearact/observer":"file:vendor/clearact-observer-0.1.0.tgz",
  "@clearact/server":"file:vendor/clearact-server-0.1.0.tgz",
  "@clearact/mcp":"file:vendor/clearact-mcp-0.1.0.tgz"
}}}
```

## Server/MCP 入口

```ts
import {createClearActServer, canonical, ClearActBroker, type ClearActBrokerOptions} from '@clearact/server';
const app = createClearActServer({approvalToken:'独立操作者凭据'});
app.server.listen(4310, '127.0.0.1');
// 退出时调用 await app.close()。
```

server 还导出 `ClearActBrokerError`、`Invocation`、`ExecutionBinding`。`canonical` 供独立审批端核对完整参数，忽略对象字段顺序但保留值差异。

命令为 `clearact-server` 和 `clearact-mcp`。两包的 `./cli` export 解析到 `dist/cli.js`；可信 runner 可用 `import.meta.resolve('@clearact/mcp/cli')` 后以 Node 启动。MCP 根 export 提供 `operationContent`，导入根入口不启动 stdio。

## 检查范围

`check:packages` 在仓库外临时 consumer 真实安装八个归档，检查 tar 内容、正式 exports/bin、workspace 依赖转换、ESM import 来自 consumer node_modules、严格 NodeNext 公共类型（无 paths、skipLibCheck=false）、CLI 解析、runtime 注册/注销和临时 localhost broker + 已打包 MCP CLI 的四工具发现/调用。另外仅安装 Core 的独立 consumer 使用 ES2022 lib（无 DOM lib）编译并在 Node 运行，确认不依赖 DOM 包、React、Vue 或 Element Plus。完成后删除 consumer，保留证据。

localhost 协议测试由 `pnpm test` 覆盖。真实业务、模型运行、普通浏览器基线与历史成绩属于 `WebWorkBench`（配套候选仓库，未保证已创建）。

## 可选页面适配包

见 [页面感知接入](./PAGE-PERCEPTION.md)。新增 `@clearact/dom` 和 `@clearact/element-plus`，八包统一构建、归档并检查独立 consumer。legacy 默认保留；page 显式启用，须使用实时观测、动作绑定及受约束结果。
