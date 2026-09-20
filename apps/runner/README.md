# Runner 执行面（规划目录）

此目录目前只有边界说明，尚无可运行的执行器。

负责领取 Run、构建执行环境、调用 `packages/runtime`、上报事件与产物、处理取消与心跳。API 提交任务，Runner 执行任务，两者通过持久化状态交接。MVP 先提供服务端 Runner；LOCAL Runner 在后续阶段实现。

未来目录：`src/main.ts`（进程入口）、`src/jobs`（领取与租约）、`src/adapters`（模型/事件存储适配）、`src/execution`（沙箱生命周期）。接入时添加独立 package.json，沿用根 workspaces。

任何 Shell 都必须运行在受限执行环境中。API 主进程不得代替 Runner 执行用户命令。Runner 崩溃后不能无条件重试可能已经产生外部副作用的工具调用。
