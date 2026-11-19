# ClearAct

面向网站开发者的网页 Agent 操作框架。网站显式注册业务动作，Agent 经 MCP 发现和调用动作；高危动作等待独立审批，原页面显示操作意图、参数、状态与真实结果。

这是独立的 MIT 源码 beta 快照，不包含旧仓分支、日志或实验原件。本仓不包含评测环境，也不依赖评测仓库。

| 包 | 职责 |
| --- | --- |
| `@clearact/core` | Runtime、页面观测 JSON/校验、动作与操作类型、浏览器 WebSocket、原生 WebMCP 适配 |
| `@clearact/dom` | 原生 HTML 呈现事实、当前表单值、页面对象与动作绑定 |
| `@clearact/element-plus` | 固定版普通 Table、基础 Form、Dialog 参考适配 |
| `@clearact/react` | `ClearActProvider`、`useClearActRuntime`、动作与页面视图/绑定 hooks |
| `@clearact/vue` | `createClearActPlugin`、动作与页面视图/绑定 composable |
| `@clearact/observer` | 无色透镜顶岛、自然叙述、操作频率、紧凑历史与审批、虚拟鼠标及目标锁定 |
| `@clearact/server` | `createClearActServer`、`ClearActBroker`、审批与一次性执行凭据 |
| `@clearact/mcp` | `clearact-mcp` CLI；四个业务协议工具 |

## 开发与验证

项目固定 pnpm 10.30.2，使用具备 WebSocket/fetch 的现代浏览器；本地验证使用 Node 24。首次安装需要准备依赖；已有完整缓存可加 `--offline`。

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm check:packages
```

`build` 生成八包的 ESM JavaScript 与类型。`check:packages` 在仓库外临时 consumer 中验证八个 tgz 的导入和严格类型；归档与证据位于 `work/package-distribution/`。源码 beta，尚未发布 npm；项目原始代码采用 MIT 许可证。详见 [构建与消费](docs/PACKAGES.md)。

## 版本与贡献

[版本及制品索引](VERSIONS.md) · [发布流程](docs/RELEASING.md) · [Agent 协作规则](AGENTS.md)。SDK 改动通过 Changesets 管理版本和 changelog；当前只启用只读验证，发布流程仅为非执行模板，没有配置凭据或 npm 发布。

## 页面接入

```ts
import {createClearActRuntime} from '@clearact/core';
import {installDOMPage} from '@clearact/dom';
import {mountClearActObserver} from '@clearact/observer';
const runtime = createClearActRuntime({
  sessionId: 'orders', serverUrl: 'http://127.0.0.1:4310',
  contextMode: 'page', operationIntervalMs: 500,
});
installDOMPage(runtime); // 挂载后读取现有 HTML，不复制业务数据
runtime.registerView({key:'orders-page',kind:'region',root:()=>document.querySelector('main')});
const entry = () => document.querySelector<HTMLElement>('#open-orders');
runtime.registerAction({
  name: 'orders.open', description: '通过当前页面入口打开订单界面。',
  risk: 'read', resultMode: 'page',
  inputSchema: {type: 'object', additionalProperties: false},
  async execute() {
    entry()!.click(); // 复用页面现有 handler
    return {outcome:'completed',observationRequired:true};
  },
});
runtime.registerActionBinding({
  key:'open-orders',viewKey:'orders-page',action:'orders.open',
  target:entry,trigger:entry,objectKey:()=>'orders-entry',guard:{scope:'target'},
});
const unmount = mountClearActObserver(runtime);
runtime.connect();
// Agent 先 get_context 读取区域，再携 snapshotId/bindingRef 调用。
// 页面退出时调用 unmount() 和 runtime.dispose()。
```

Observer 默认显示可拖动的无色透镜顶岛，桌面展开约 600 × 64px。自然叙述说明 Agent 正在做什么及其目的，长意图单行省略并保留完整提示。展开态内置从慢到快的短连续“操作频率”滑块和醒目的 Shut Down。历史默认关闭，以紧凑节点供用户手选，每次只展开一条记录。收起后只留下浏览器内容顶部中央的薄弧与轨道游标入口，点击恢复；新审批到来时自动展开。页面保留虚拟鼠标和当前目标的四角锁定框。

顶岛默认使用 `theme: 'auto'`，根据宿主页背景适配明暗文字。可通过 `mountClearActObserver(runtime, undefined, {theme: 'light'})` 或 `{theme: 'dark'}` 显式覆盖；复杂图片或混合背景可使用此选项。省略 `theme` 与指定 `'auto'` 相同。

同一页面 session 的动作串行执行，默认两次实际启动至少间隔 500ms。频率滑块对应 5000–0ms 的间隔，显示执行频率上限；“尽快”仍保持串行。拖动立即调整尚未开始的操作。代码继续使用 `runtime.getOperationIntervalMs()` / `runtime.setOperationIntervalMs(ms)`，接受 0–5000 的整数毫秒。长操作已经超过间隔时，结束后不再附加完整等待。

每次调用必须提供 `intent`，用一句话说明动作、目标与用户目标的关系，不提前宣称成功。page 模式原生 WebMCP 输入为 `{intent, arguments, observation}`，MCP 同样携带已交付的 snapshotId/bindingRef。未启用 page 的 legacy 接入保留 `{intent, arguments}`。参见 [迁移说明](docs/MIGRATION.md)。

页面感知范围、迁移和覆盖限制见 [页面感知接入](docs/PAGE-PERCEPTION.md)。完整 React/Vue 生命周期、CSP 与后端执行关口见 [开发者指南](docs/DEVELOPER-GUIDE.md)。React peer 为 >=18，Vue 为 >=3.3；范围声明不等于全部版本已验证。

## Broker 与 MCP

构建后在两个独立进程中运行：

```sh
corepack pnpm server
corepack pnpm mcp
```

Broker 默认监听 `127.0.0.1:4310`，独立审批凭据保存在 `work/approval-token`。MCP 仅公开 `list_actions`、`get_context`、`invoke_action`、`get_operation`，不提供审批工具。外部 consumer 可启动已安装的 `clearact-server`/`clearact-mcp`；Node 可用 `import.meta.resolve('@clearact/mcp/cli')` 获取已构建入口。

高危动作的业务后端应在写入前调用 broker 的 `verify-execution`，校验操作 ID、session、动作名和完整参数。仅前端标记 `risk:'high'` 不能代替后端验证。现有业务身份验证和权限检查仍由网站负责。详见 [server](packages/server/README.md) 与 [MCP](packages/mcp/README.md)。

操作、审批和幂等索引保存在内存中，重启失效；未实现生产级持久审计、多租户认证或业务数据版本锁。超时与断线不能证明业务回滚，重试前应独立读回。测试与 Chrome fixture 的范围见 [验证说明](docs/VALIDATION.md)。

React/Vue 接入以本仓开发者指南为准。真实应用评测和镜像是单独验证的交付，不属于本源码 beta。

## 许可

项目原始代码采用 [MIT](LICENSE) 许可证。第三方依赖仍遵循其各自许可，见 [依赖说明](docs/DEPENDENCIES.md)。这是独立、无历史的源码 beta 快照，不是 npm 发布。
