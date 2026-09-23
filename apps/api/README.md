# API 控制面

负责认证、Agent 配置、模型登记、任务提交、审批、审计查询与事件订阅。

当前实现 `GET /healthz` 与 `GET /api/v1/health` 进程存活检查，以及检查数据库依赖的 `GET /readyz` 与 `GET /api/v1/ready`。配置 `DATABASE_URL` 后先执行 `npm run db:migrate --workspace @agent-workbench/api`。

C 端对话通过 `POST /api/v1/workspaces/:workspaceId/chat` 提交，接收当前模型连接、最多 40 条消息和可选 `sessionId`。本次预发布协议从同步 `200` 改为 `202`，返回 `sessionId/runId/stepId/status`；API 只验证配置并持久化排队，模型调用在独立 Runner 中执行，前端应刷新到同版本。

`GET /api/v1/workspaces/:workspaceId/runs/:runId` 返回运行快照、步骤和事件；`POST /.../runs/:runId/cancel` 提交取消。排队可直接取消，执行中先写 `cancelRequestedAt`，等待 Runner 结束本地请求后确认终态。查询和取消均验证工作空间成员与会话所有者；同一 Session 不能提交多个活动 Run，冲突返回 409。

Session 列表和详情仍在 `/api/v1/workspaces/:workspaceId/sessions` 与 `/sessions/:sessionId`；认证使用 `sessions`，聊天使用 `chat_sessions`。API 与 Runner 共用 `packages/persistence`，避免重复 Schema/密钥逻辑。Run SSE、TAO 只读工具和文件变更提案审阅已接入；批准后由 Runner 负责受控应用，API 不直接写入工作区。详细决策见 [ADR-0006](../../docs/decisions/0006-background-chat-runner.md) 和 [ADR-0011](../../docs/decisions/0011-file-change-review.md)。

M1 提供本地账号和 Workspace 基础接口：`POST /api/v1/auth/login`、`POST /api/v1/auth/logout`、`GET /api/v1/auth/me`、`GET /api/v1/workspaces` 与 `POST /api/v1/workspaces`。登录会话只以哈希形式保存到数据库，浏览器使用 HttpOnly Cookie；密码使用标准 Argon2id 编码格式，通过 `hash-wasm` 的 WASM 实现计算，避免部署时依赖原生编译工具链；服务端不会向前端返回密码或模型密钥。

模型连接按工作空间隔离：`GET /api/v1/workspaces/:workspaceId/model-connections` 对成员提供脱敏列表，`POST` 和 `PATCH` 只允许 owner/admin。管理员可以通过 `secret` 字段提交模型 API Key；服务端使用 `MODEL_SECRET_ENCRYPTION_KEY` 配置的 AES-256-GCM 主密钥加密保存，密钥只在服务端测试或 Runner 调用时解密，永不通过 API 返回。部署也可以继续使用 `secretRef` 的 `none`、`env:VARIABLE_NAME` 或 `secret:PATH` 引用模式；响应只返回 `secretConfigured` 布尔值。连接还保存无凭据的 `baseUrl` 和测试状态；`POST /api/v1/workspaces/:workspaceId/model-connections/:connectionId/test` 由 owner/admin 触发服务端测试，失败原因截断后落库并审计。模型连接的创建、修改会与管理审计在同一数据库事务中写入。

启用管理后台录入密钥前，必须为 API 配置一个持久的 32 字节 `MODEL_SECRET_ENCRYPTION_KEY`（十六进制 64 字符或 Base64）。密钥丢失后，已保存的托管模型密钥无法解密；更换主密钥前需要完成密钥迁移方案。

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
