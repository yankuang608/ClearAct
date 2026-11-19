# ClearAct localhost broker

本仓先运行 `pnpm build`，再运行 `pnpm server`。外部 consumer 启动已安装的 `clearact-server`。默认监听 `127.0.0.1:4310`，可用 `CLEARACT_PORT` 覆盖。默认只接受 loopback 来源；需要其他开发站点时使用逗号分隔的 `CLEARACT_ALLOWED_ORIGINS`。

`CLEARACT_APPROVAL_TOKEN` 只用于独立人类审批器。未设置时服务端生成随机凭据，写入 `work/approval-token`（权限 0600），标准错误只打印文件路径。不要将该值传入模型、MCP 环境或模型 prompt。

页面 WebSocket `/page` 注册 `{type:'register',sessionId,actions,context}`。动作元数据包含 `name/description/inputSchema/risk`，风险为 `read/write/high`。服务端对参数做 AJV 校验；高危动作创建 `waiting_approval`，不发送执行消息。批准后才向注册页面发送 `execute`，其中独立的一次性 `executionToken` 不会放入 ClearActOperation、查询结果或事件。

页面控制只接受已注册页面连接的 WebSocket 消息 `{type:'control',enabled:false|true,requestId}`。停止会关闭该 session 的新调用入口，取消待审批操作、废止未使用执行凭据，并向在途动作发送取消请求。停止栅栏跨连接重连保留；普通注册更新不会恢复，需要该页面显式请求 `enabled:true`。该控制不使用审批 token，也没有公开的 HTTP 恢复路由或 MCP 恢复工具。

操作可以进入 `cancelled`；正在执行的动作收到 `cancelRequested:true` 后仍可能返回真实 `succeeded`，因为取消不保证业务回滚。停止后的相同 requestId 仍只读返回既有操作，不重新派发。broker 重启会清除包括停止栅栏在内的内存状态。

HTTP：

- `GET /api/sessions`、`/api/actions?sessionId=...`、`/api/context?sessionId=...`
- `POST /api/invoke`：`{sessionId,action,arguments,intent,requestId}`，直接返回 ClearActOperation。
- `GET /api/operations/:id`：直接返回 ClearActOperation。
- `POST /api/operations/:id/approve|reject`：独立 `Authorization: Bearer <approvalToken>`，直接返回 ClearActOperation。
- `POST /api/verify-execution`：`Authorization: Bearer <executionToken>`，正文 `{operationId,sessionId,action,arguments}`。动作、参数必须与原请求完全一致；JSON对象字段顺序不影响比较。成功 `{valid:true,operationId}`，凭据立即消费；不匹配、过期、重放均 403。

上游业务服务应在实际 mutation 前调用 verify-execution。被拒绝时不得修改业务数据；验证成功后如果业务 mutation 失败，原能力不会重放，需重新创建操作。此 MVP 未实现分布式事务或补偿。

同 session 的 requestId 是幂等键：相同完整请求返回原 ClearActOperation，参数或 intent 改变返回 409。重复批准不会再次派发；被拒绝操作不能批准。动作定义在批准前变化会拒绝旧审批。页面断开时未完成操作失败，不自动重试。

审批等待默认 300 秒，批准后的执行默认 120 秒。到期主动转为 `failed` 并通知页面；查询、执行凭据验证和结果回传同样检查截止时间，迟到结果不能覆盖失败状态。执行超时或断线不代表业务已回滚：已开始的业务操作可能完成，重试前应独立读回业务状态。使用相同 requestId 只会得到原操作，不会再次派发。

嵌入式使用时可向 `new ClearActBroker(token, {approvalTimeoutMs, executionTimeoutMs})` 配置正整数毫秒超时，或通过 `createClearActServer({approvalToken, brokerOptions})` 传入。`close()` 使未完成操作失败并清理计时器；独立 ClearActBroker 使用者也应调用它。事件发送失败不改变权威状态，可查询操作或重新连接后重放最近 100 项状态。

状态与审计存于内存，重启全部失效；不是生产持久审计系统。MVP 防止受控模型自行批准，不声称防御本机恶意进程。全站不可绕过取决于所有等价业务入口是否落实后端验证；仅前端提示不构成此保证。

验证：`node --import tsx --test packages/server/test/*.test.ts`，使用临时 loopback 端口。

正式包根入口导出 `createClearActServer`、`ClearActBroker`、`ClearActBrokerError`、`canonical` 与 broker 公共类型。`@clearact/server/cli` 解析到已构建 `dist/cli.js`；外部 consumer 不需要引用源码。
