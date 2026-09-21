# API 控制面

负责认证、Agent 配置、模型登记、任务提交、审批、审计查询与事件订阅。

当前实现 `GET /healthz` 与 `GET /api/v1/health` 进程存活检查，以及检查数据库依赖的 `GET /readyz` 与 `GET /api/v1/ready`。配置 `DATABASE_URL` 后先执行 `npm run db:migrate --workspace @agent-workbench/api`。

M1 提供本地账号和 Workspace 基础接口：`POST /api/v1/auth/login`、`POST /api/v1/auth/logout`、`GET /api/v1/auth/me`、`GET /api/v1/workspaces` 与 `POST /api/v1/workspaces`。登录会话只以哈希形式保存到数据库，浏览器使用 HttpOnly Cookie；密码使用标准 Argon2id 编码格式，通过 `hash-wasm` 的 WASM 实现计算，避免部署时依赖原生编译工具链；服务端不会向前端返回密码或模型密钥。

模型连接按工作空间隔离：`GET /api/v1/workspaces/:workspaceId/model-connections` 对成员提供脱敏列表，`POST` 和 `PATCH` 只允许 owner/admin。请求中的 `secretRef` 仅接受 `none`、`env:VARIABLE_NAME` 或 `secret:PATH` 引用，平台不接受原始模型密钥；响应只返回 `secretConfigured` 布尔值。连接还保存无凭据的 `baseUrl` 和测试状态；`POST /api/v1/workspaces/:workspaceId/model-connections/:connectionId/test` 由 owner/admin 触发服务端测试，失败原因截断后落库并审计。模型连接的创建、修改会与管理审计在同一数据库事务中写入。

owner/admin 可通过 `GET /api/v1/workspaces/:workspaceId/audit-records?limit=50&offset=0` 查询管理审计。接口使用分页快照并对可能出现的 secret、token、password、credential 和 API key 字段脱敏；审计历史没有修改或删除接口。

Agent 配置按版本保存：`GET /api/v1/workspaces/:workspaceId/agents` 查询列表，`POST /api/v1/workspaces/:workspaceId/agents` 创建带 draft v1 的 Agent，`POST /api/v1/workspaces/:workspaceId/agents/:agentId/versions` 创建后续草稿，`POST /api/v1/workspaces/:workspaceId/agents/:agentId/versions/:versionId/publish` 发布版本。只有 owner/admin 可以写入；发布会归档原 published 版本并更新 Agent 当前版本。配置限制为最多 64 KiB 的 JSON 对象，拒绝 secret、token、password、credential 和 API key 字段，并校验 `modelConnectionId` 必须属于当前工作空间且处于 active 状态。

首次初始化管理员时，先完成迁移，再通过环境变量运行一次：

```bash
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD='use-a-random-password-with-12-or-more-characters' \
npm run admin:init --workspace @agent-workbench/api
```

开发测试环境可以显式启用临时账号 `admin / admin`。这组弱凭据只在 `NODE_ENV=development` 且设置 `ALLOW_WEAK_ADMIN_PASSWORD=true` 时被初始化命令接受；生产环境不要设置该开关：

```bash
NODE_ENV=development \
ALLOW_WEAK_ADMIN_PASSWORD=true \
ADMIN_EMAIL=admin \
ADMIN_PASSWORD=admin \
npm run admin:init --workspace @agent-workbench/api
```

命令要求数据库中尚无用户，成功后创建管理员、默认 Workspace 及 owner membership；不会覆盖已有账号，也不接受命令行密码参数。密码应通过临时环境注入，使用后立即从 shell 历史和 CI 日志中清除。

业务按领域放进 `src/modules/<domain>/`。首批领域为 `identity`、`agents`、`models`、`runs`、`approvals`、`audit`，在实现对应需求时创建。每个领域按需要拆分 routes、schema、service、repository；禁止 route 直接运行 Shell 或拼接模型请求。

`app.ts` 创建实例，`main.ts` 加载环境并监听端口，便于后续使用 Fastify `inject` 验证接口。配置示例见 `.env.example`，复制为同目录 `.env` 即可；默认配置无需文件。
