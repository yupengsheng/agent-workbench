# API 控制面

负责认证、Agent 配置、模型登记、任务提交、审批、审计查询与事件订阅。

当前实现 `GET /healthz` 与 `GET /api/v1/health` 进程存活检查，以及检查数据库依赖的 `GET /readyz` 与 `GET /api/v1/ready`。配置 `DATABASE_URL` 后先执行 `npm run db:migrate --workspace @agent-workbench/api`。

M1 提供本地账号和 Workspace 基础接口：`POST /api/v1/auth/login`、`POST /api/v1/auth/logout`、`GET /api/v1/auth/me`、`GET /api/v1/workspaces` 与 `POST /api/v1/workspaces`。登录会话只以哈希形式保存到数据库，浏览器使用 HttpOnly Cookie；服务端不会向前端返回密码或模型密钥。

首次初始化管理员时，先完成迁移，再通过环境变量运行一次：

```bash
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD='use-a-random-password-with-12-or-more-characters' \
npm run admin:init --workspace @agent-workbench/api
```

命令要求数据库中尚无用户，成功后创建管理员、默认 Workspace 及 owner membership；不会覆盖已有账号，也不接受命令行密码参数。密码应通过临时环境注入，使用后立即从 shell 历史和 CI 日志中清除。

业务按领域放进 `src/modules/<domain>/`。首批领域为 `identity`、`agents`、`models`、`runs`、`approvals`、`audit`，在实现对应需求时创建。每个领域按需要拆分 routes、schema、service、repository；禁止 route 直接运行 Shell 或拼接模型请求。

`app.ts` 创建实例，`main.ts` 加载环境并监听端口，便于后续使用 Fastify `inject` 验证接口。配置示例见 `.env.example`，复制为同目录 `.env` 即可；默认配置无需文件。
