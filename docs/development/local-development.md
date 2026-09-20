# 本地开发

## 环境与启动

使用 Node.js 22.12+ 的 22 LTS 版本、npm 9+。装依赖、执行命令均在仓库根目录：

```bash
npm ci
npm run dev
```

开发命令先构建 contracts，再同时启动共享包监听、API 和 Web；任一长期进程退出时停止其余进程。访问 `http://127.0.0.1:5173`，页面会请求 API 的健康检查。

开发启动默认不强制数据库；需要验证 M1 持久化时再启动 PostgreSQL 并执行迁移。首次安装需要网络；如已有锁文件，使用 npm ci 保持一致。不要在其他项目或用户全局环境中安装本项目依赖。

## 配置

API 从进程环境和 `apps/api/.env` 加载配置，默认值可直接启动。需要覆盖时：

```bash
cp apps/api/.env.example apps/api/.env
```

| 变量         | 默认值    | 说明                                    |
| ------------ | --------- | --------------------------------------- |
| HOST         | 127.0.0.1 | 开发仅监听本机                          |
| PORT         | 4100      | API 端口，必须为 1～65535 整数          |
| LOG_LEVEL    | info      | Fastify 日志级别                        |
| DATABASE_URL | 空        | PostgreSQL 连接串；配置后启用 `/readyz` |
| DB_POOL_MAX  | 10        | API 数据库连接池上限                    |

Web 使用 Vite 5173 端口和 `/api` 同域代理。端口冲突时会显式失败。API 改端口后同步修改 `apps/web/vite.config.ts` 的 proxy。任何 `VITE_` 变量都会进入浏览器构建，不得放真实密钥。

## 常用命令

```bash
npm run check
npm run format
npm run typecheck
npm run build
npm run start --workspace @agent-workbench/api
npm run db:migrate --workspace @agent-workbench/api
```

首次创建本地管理员和默认工作空间时，使用临时环境变量运行一次：

```bash
export ADMIN_EMAIL=admin@example.com
read -r -s ADMIN_PASSWORD
export ADMIN_PASSWORD
npm run admin:init --workspace @agent-workbench/api
unset ADMIN_PASSWORD
```

初始化命令只接受空用户库，密码使用 Argon2id 哈希保存；已有用户时会拒绝执行。登录后可通过 `GET /api/v1/workspaces` 查询成员关系，使用 `POST /api/v1/workspaces` 创建并自动成为新空间 owner。

单独开发应用时先执行 `npm run build --workspace @agent-workbench/contracts`。构建输出位于各 workspace 的 `dist/`，不提交到 Git。

## 新增业务模块

API 按 `src/modules/<domain>` 放路由、输入 Schema、服务和仓储；Web 按 `src/features/<domain>` 放页面与领域交互。先在 contracts 中定义公开边界及运行时校验方案，再实现消费者。

Runner、runtime 和 tools 当前只有 README。在对应里程碑加入 package.json 和源码，沿用根工作区；同时更新根 build/typecheck/dev 命令、CI 和架构依赖图。不要为了预留目录手动创建空启动进程。

## 验证策略

当前检查包含格式、TypeScript 和生产构建。初始化时另外验证健康接口、404、Web/API 代理、进程启动和关闭。尚未引入业务测试框架；首次状态/权限逻辑进入仓库时增加有价值的模块测试。

重要场景优先测试真实行为：拒绝时没有副作用、重复消息不重复执行、取消传播、越权访问被拒、恢复时外部结果不明。跨服务测试放 `tests/`，模块测试与源码相邻。

## 常见问题

- `Cannot find module @agent-workbench/contracts`：先运行根 `npm ci` 和 contracts 构建，或使用根 `npm run dev`。
- 页面显示 API 不可用：确认 4100 端口的 API 已启动，检查代理配置和控制台日志。
- `EADDRINUSE`：确认现有监听进程归属，使用其他端口或关闭自己的进程；不要终止未知项目。
- Docker 不可用：不影响无数据库的 Web/API 开发；要验证 M1 迁移和 `/readyz`，需要可连接的 PostgreSQL 17。
