# ClearAct stdio MCP

命令为 `clearact-mcp`；本仓先 `pnpm build` 再 `pnpm mcp`。可信 runner 可用 `import.meta.resolve('@clearact/mcp/cli')` 找到 `dist/cli.js` 并以 Node 启动，不要求 tsx 或源码。`CLEARACT_SERVER_URL` 默认 `http://127.0.0.1:4310`，只支持 loopback broker；`CLEARACT_SESSION_ID` 可绑定单个 session。

仅公开 `list_actions`、`get_context`、`invoke_action`、`get_operation` 四工具。参数由 AJV 验证，不提供审批、原始 HTTP、shell、DOM 或 JS eval。不要把审批凭据交给 MCP；进程会清除继承的 `CLEARACT_APPROVAL_TOKEN`。

高危操作返回 waiting_approval，普通操作在有限窗口内等候真实结果，之后用 get_operation 查询。页面终止后新的调用会被拒绝，`cancelled` 是取消终态；MCP 不提供恢复页面操作的工具。已发出的业务请求仍可能成功，取消不代表回滚。等待审批与正在执行都不代表完成；超时和断线不能证明业务回滚，重试前独立读回。

根 export 为 `operationContent`，用于转换有效页面媒体；导入根入口不启动服务。源码测试使用独立 localhost broker 与 stdio client，运行 `pnpm test`。模型 runner 与实验配置维护于 `WebWorkBench`（配套候选仓库，未保证已创建）。
