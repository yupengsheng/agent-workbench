# Runner 执行面

M2 已提供独立单模型执行器：领取 queued Run、续租、调用 ModelPort、持久化终态、响应取消和回收过期租约。每个进程一个执行槽；多个进程通过行锁竞争任务，不共享内存状态。

先从根目录构建，完成数据库迁移，再为 API 与 Runner 配置相同的 `DATABASE_URL` 和 `MODEL_SECRET_ENCRYPTION_KEY`。本地可让两个应用共享环境文件：

```bash
ln -s ../api/.env apps/runner/.env
npm run dev
```

已有 runner 环境文件时直接维护该文件，无需重建链接。没有数据库配置的开发启动会显示 idle；生产启动缺少配置会失败。单独启动：

```bash
npm run start --workspace @agent-workbench/runner
```

`src/worker.ts` 组装模型、身份检查和存储端口，`src/main.ts` 管理领取循环及 SIGTERM/SIGINT。租约 30 秒、心跳 2 秒、模型执行 60 秒；Token 上限由提交快照确定。租约过期记录失败，不自动重放请求。取消确认表示本地请求已结束，不承诺供应商取消计算或计费。

测试部署脚本同时启动 API、Web、Runner，Runner PID 与日志位于部署根目录 `runtime/runner.pid`、`runtime/runner.log`。仍使用试点进程管理，系统重启后的自动拉起和生产服务监管留待私有化交付。

TAO、文件工具、Shell、审批和长任务检查点尚未实现。设计和协议迁移说明见 [ADR-0006](../../docs/decisions/0006-background-chat-runner.md)。
