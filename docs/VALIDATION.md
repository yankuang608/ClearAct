# 验证范围

`pnpm test` 包含 SDK 单元、HTTP/WebSocket、MCP stdio 与浏览器 fixture 测试。`pnpm typecheck` 检查源码与脚本；`pnpm build` 生成八包；`pnpm check:packages` 验证仓库外消费者入口与类型。

发布 guard 可用 `node --test scripts/release-policy.test.mjs scripts/release-publish.test.mjs` 做完全离线模拟，不访问 registry。打包成功、模拟成功都不等于实际发布或 OIDC 已配置。

此源码快照不包含旧实验成绩、轨迹、storageState 或私人验收日志。运行本地 fixture 产生的 work/ 输出默认忽略。真实应用验收、生产权限、持久审计、任意模型成功率和浏览器版本兼容性需要独立验证；不能从合成测试推出这些结论。
