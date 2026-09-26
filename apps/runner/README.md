# Runner 执行面

M2 已提供独立执行器：领取 queued Run、续租、调用 ModelPort、执行受限的 Think-Act-Observe 只读工具循环、持久化 Tool Step/事件、响应取消和回收过期租约。每个进程一个执行槽；多个进程通过行锁竞争任务，不共享内存状态。

先从根目录构建，完成数据库迁移，再为 API 与 Runner 配置相同的 `DATABASE_URL` 和 `MODEL_SECRET_ENCRYPTION_KEY`。本地可让两个应用共享环境文件：

```bash
ln -s ../api/.env apps/runner/.env
npm run dev
```

Runner 支持在聊天请求中使用 `routing.mode=jev` 自动选择模型。配置 `TYPESAFE_API_KEY`、`TYPESAFE_ROUTER_TIMEOUT_MS`（默认 5000）和 `TYPESAFE_ROUTER_MIN_CONFIDENCE`（默认 0.65）后，Runner 会把用户请求和已授权的模型候选交给 TypeSafe Jev。低于阈值、候选变更或路由服务不可用都会结束任务并要求用户手动选择模型；不会静默调用任意候选。TypeSafe 密钥只存在 Runner 环境，不会写入数据库或返回浏览器。

Runner 为每轮模型请求、Jev 选择和工具调用写入结构化审计。调用开始和完成、失败或取消分别记录；元数据只包含 Run/Step 关联、模型或工具标识、状态与数值用量，不包含提示词、模型回复、工具参数、文件内容、Shell 命令或密钥。审计写入受 Run 租约 fencing 保护，写入失败时当前 Run 不会继续执行。

已有 runner 环境文件时直接维护该文件，无需重建链接。没有数据库配置的开发启动会显示 idle；生产启动缺少配置会失败。单独启动：

```bash
npm run start --workspace @agent-workbench/runner
```

`src/worker.ts` 组装模型、身份检查和存储端口，`src/main.ts` 管理领取循环及 SIGTERM/SIGINT。租约 30 秒、心跳 2 秒、模型执行 60 秒；Token 上限由提交快照确定。租约过期记录失败，不自动重放请求。取消确认表示本地请求已结束，不承诺供应商取消计算或计费。

测试部署脚本同时启动 API、Web、Runner，Runner PID 与日志位于部署根目录 `runtime/runner.pid`、`runtime/runner.log`。仍使用试点进程管理，系统重启后的自动拉起和生产服务监管留待私有化交付。

工作区只读工具使用 `AGENT_WORKBENCH_WORKSPACE_ROOT/<workspaceId>` 映射目录；不存在的目录会返回结构化拒绝结果。单次运行最多 8 轮、16 次工具调用和 16,384 个累计 Token。`propose_file_change` 会持久化精确内容和审阅提案；批准后由 Runner 领取，重新校验前置 SHA，再用同目录临时文件和原子替换应用。应用状态为 `not_started/applying/applied/failed/unknown`，写入结果不明时不会自动重试。Shell 使用相同的持久化审批和一次性领取语义；长任务检查点尚未实现。设计和协议迁移说明见 [ADR-0006](../../docs/decisions/0006-background-chat-runner.md)、[ADR-0007](../../docs/decisions/0007-tao-readonly-tools.md)、[ADR-0011](../../docs/decisions/0011-file-change-review.md) 和 [ADR-0012](../../docs/decisions/0012-sandbox-shell.md)。

受控网页获取默认关闭。只有 `AGENT_WORKBENCH_ENABLE_WEB_FETCH=true`、`AGENT_WORKBENCH_WEB_FETCH_ALLOWLIST=docs.example.com,*.example.org`、模型连接 `tools=true` 和 `web=true` 同时满足时，才向模型注册 `fetch_web_page`。白名单只允许主机名；工具固定连接已检查的公网 DNS 地址，每次跳转重新检查，默认总时限 10 秒、响应体 64 KiB，仅接收未压缩 UTF-8/ASCII 文本。它不执行 JavaScript、不携带登录态，也不用于内部系统。详见 [ADR-0013](../../docs/decisions/0013-restricted-web-fetch.md)。

受控 Shell 默认关闭。只有同时满足 `AGENT_WORKBENCH_ENABLE_SHELL=true` 和模型连接能力中的 `shell=true` 才会向模型注册 `propose_shell_command`；该工具只落库命令、原因和沙箱预算，不执行命令。用户审阅精确命令并批准后，Runner 才领取一次并执行。Runner 找不到 `/usr/bin/bwrap`（或 `AGENT_WORKBENCH_BWRAP_PATH` 指定的可执行文件）时会拒绝执行，不会回退到主机 Shell。命令在 UID/GID `65532`、独立 PID/网络命名空间和工作区挂载内运行，环境变量只保留固定的 `PATH`/`LANG`，并隐藏常见 `.env`、`.ssh`、`.aws` 等凭证路径。默认上限为 30 秒、20 CPU 秒、512 MiB、64 个进程和 64 KiB 输出；取消会终止进程组。Runner 在执行中失联时记录 `unknown` 且不自动重试；生产级 cgroup 和磁盘配额仍是后续 M3 工作。

仓库内的测试环境发布脚本默认设置 `AGENT_WORKBENCH_ENABLE_SHELL=true`，便于验收审批链路；模型连接仍需管理员显式启用 `shell` 能力。其他部署不继承这个测试默认值。
