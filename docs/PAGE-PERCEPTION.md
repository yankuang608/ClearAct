# 页面感知接入（v1）

page 模式使 Agent 读取当前已呈现界面，再绑定到同一个对象调用已有业务动作。它适用于人和 Agent 共同使用一张页面的场景。legacy 默认行为保留。

## 安装与最小接入

安装 `@clearact/core` 与可选 `@clearact/dom`；React/Vue 页面再安装相应封装。Core/server 在 Node 中导入不需要 document、DOM 包或 Element Plus。

```ts
import {createClearActRuntime} from '@clearact/core';
import {installDOMPage} from '@clearact/dom';

const runtime = createClearActRuntime({
  sessionId: 'orders', serverUrl: 'http://127.0.0.1:4310', contextMode: 'page',
});
installDOMPage(runtime); // 在浏览器挂载后调用；默认读取 document.body，跳过 Observer

runtime.registerView({
  key: 'orders', kind: 'table', root: () => tableElement,
  read: reader => reader.table(),
});
runtime.registerAction({
  name: 'orders.edit', description: '打开当前订单编辑窗口', risk: 'write',
  resultMode: 'page', inputSchema: {
    type: 'object', properties: {orderId: {type: 'string'}},
    required: ['orderId'], additionalProperties: false,
  },
  async execute({orderId}) {
    await existingOpenEditor(orderId); // 原页面 handler、业务权限和校验
    return {outcome: 'completed', observationRequired: true};
  },
});
runtime.registerActionBinding({
  key: 'edit-instance', viewKey: 'orders', action: 'orders.edit',
  target: () => currentRowElement, trigger: () => currentEditButton,
  objectKey: () => currentOrderId,
  argumentBindings: () => ({orderId: currentOrderId}),
  guard: {scope: 'row', relatedViews: ['filters']},
});
// filters 必须是已注册且当前呈现的筛选视图。
runtime.connect();
```

`root`、`target`、`trigger` 与 objectKey 必须解析当前实例；对象 ID 仅做路由定位。不要把未呈现记录、完整 form model 或 store 填进观测。注册函数返回清理函数。一个 view 内 binding key 唯一；显式 view 优先于原生 fallback，重复所有权会失败。

## Agent 读取和操作

保留四个 MCP 工具：`list_actions`、`get_context`、`invoke_action`、`get_operation`。会话发现标明 `contextMode: page`、`documentId` 与 `capabilities.pageObservation: 1.0`。

1. `get_context({sessionId})` 实时读取 overview，得到区域目录。
2. `get_context({sessionId,detail:'region',regionRef})` 读取已呈现区域的详细节点与绑定。
3. 只调用 `enabled:true, callable:true` 的绑定，把当前 `snapshotId`、`bindingRef` 放到 `invoke_action.observation`；完整业务参数须符合固定 argumentBindings。
4. 等待 operation 终态；动作后重新读取验证 UI 事实。`succeeded` 仅表示 callback 返回，`validation_failed` 或 `in_progress` 仍需处理。

runtime 的异步 `observe(options)` 与保留原生工具 `clearact.page.observe` 都通过 Broker 登记观测。原生业务工具输入为 `{intent, arguments, observation}`。直接调用为 `runtime.invoke(action,args,intent,requestId,{observation})`。浏览器未提供 WebMCP API 时不注册原生入口，MCP 仍可用。

公开响应是 JSON。`overview` 不默认展开表单字段与表格行；区域输出可能 partial。协议 cursor 只切分已呈现节点，不触发 UI 翻页。继续读取须保持同一 region、detail 和 limit；UI 变化后旧 cursor 返回 `STALE_CURSOR`。每次默认 200、最多 500 节点；公开快照和内部依据分别最多 48 KiB，WS 总消息最多 120 KiB（传输上限仍 128 KiB）。超大文本按节点标记截断；依赖未完整交付的绑定为不可调用，不跨多个 snapshot 拼装授权。

大表单可使用聚焦读取：`get_context({sessionId, detail:'region', regionRef:binding.targetRef, bindingRef:binding.ref, limit:500})`。绑定必须来自已经交付的观察，且目标在指定区域内。该读取保留区域事实并补齐绑定声明的全部 guard 节点，只交付所选动作，避免其他动作及其重复 canonical 占满预算。它不改变 48 KiB 上限、完整 canonical 比较或最终重采样；超过预算、部分裁剪或未完整交付的 guard 仍不可调用。继续 cursor 时也必须保持同一 bindingRef。

Broker 观察默认 3 秒超时，按连接保留最近 64 次、最长 5 分钟；断线与重连失效旧文档。超时不会返回旧 context。操作接受后复制依据，审批期间不受后续快照淘汰影响。

## React / Vue 与 Element Plus

React 的 `useClearActView(view)` 返回实例命名空间中的 viewKey；将其用于 `useClearActActionBinding({viewKey,...})`。视图和 resolver 的更新在提交后的 layout effect 生效，放弃的 render 不对外暴露。Vue 同名 composable 接受对象或返回对象的 getter，在 mounted/updated 后更新。卸载清理注册；读取时仍检查根节点是否连接。

Portal/Teleport 的子视图用 `ownerKey` 指向父视图返回的 key；绑定当前真实根节点，不把整个 document 当作弹窗内容。SSR 不调用 DOM 安装；在 hydration/挂载后安装适配并连接，尚无可读界面时返回未就绪。

`@clearact/element-plus` 是可选参考适配，实际固定验证 **Element Plus 2.11.5**、Vue 3.5.43。`useClearActElementPlusView({key,kind,root,ownerKey?})` 支持普通 Table、基础 Form/FormItem 和 Dialog；root 可以解析组件公开 `$el` 或真实 DOM。它只读取已渲染单元格、当前控件、标签和已显示错误，formatter/slot 以呈现内容为准。两个业务页面可复用同一包装组件，无需复制业务数组或校验逻辑。

不宣称兼容全部 Element Plus 版本或控件：Table V2、未渲染虚拟行、日期/级联等复合控件需要单独适配与 fixture。CSS 选择器集中在参考包。组件公开行为依据 [Table](https://element-plus.org/en-US/component/table.html)、[Form](https://element-plus.org/en-US/component/form.html)、[Dialog](https://element-plus.org/en-US/component/dialog.html) 文档；兼容结论以本仓固定版浏览器测试为准。

## 边界与执行一致性

默认读取可滚动到的已渲染内容，排除隐藏面板、未展开详情、未切换分页和未呈现选项。原生 input 的当前 `.value` 直接读取，程序无事件改值也会反映；不触发 validate、焦点、滚动、展开或后台请求。密码/私密控件只返回 redacted。自绘 Canvas、iframe、closed Shadow DOM、裁剪文本或不支持的自定义控件会报告 partial/unsupported。

RenderedReader 生成带本次来源的 fact，read 回调只组织这些事实；伪造值、Promise、重复所有权、可检测的 DOM/网络副作用会失败。这是合作适配契约，不能沙箱隔离恶意宿主代码。

行内动作校验目标行及父表格条件；提交校验整个公开表单；批量动作包含当前选择。最终同步采样与 canonical 比较位于队列、审批、频率等待、Observer 准备和同步 execution 订阅之后，紧接 callback。无关提示或其他行内容、纯滚动不应无条件使已观察目标失效。

复合日期面板、使用 div 包装的富文本编辑器等组件，应将当前呈现字段组织为 form 视图，或通过 `guard.relatedViews` 把提交动作关联到当前可见草稿。适配器负责声明这类依赖；同一组件包装可以在业务页面之间复用。

只有 callback 尚未开始的确定性页面拒绝才有 `effect:'not_started'`；超时、断线和执行中取消保留结果不确定性。校验只覆盖 callback 入口；callback 内再次 await 后的并发仍需业务自身权限、对象版本、事务与 AbortSignal。

page callback 只返回 `{outcome, message?, refreshRefs?, observationRequired}`；outcome 和 observationRequired 必填。消息必须来自 UI 或固定协议状态，refreshRefs 必须是当前文档已知范围。未知字段/旧任意结果不外传，并返回 `ACTION_RESULT_CONTRACT_VIOLATION`，不自动重试，因为业务可能已写入。未呈现的后台异常不会成为新的感知通道。

## 迁移

- 删除 `context`/`setContext` 中的业务摘要，显式设置 page；同步 `getContext()` 改为异步 `observe()`。
- 将后台读取动作改成可见的导航/展开动作，随后重新观察；同一 page session 不保留 legacy 查询或任意结果动作。
- 每个动作声明 `resultMode:'page'`、注册真实 trigger/target 绑定；既有 schema、handler、风险分级和业务参数保留。
- 加入当前 UI 一致性 fixture，特别是直接改值、隐藏内容、虚拟化复用、模态、排队/审批竞态及 callback 计数。
- Broker 程序调用 `getContext` 现在按会话可能异步；支持 page 的调用方应 await，或明确使用 observe。legacy 会话的返回内容与同步运行行为保留。
