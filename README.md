# Agent Workbench

可私有化部署的多 Agent 工作台。目标是统一管理 Agent、模型、用户与审计，通过 Think-Act-Observe 引擎执行文件、命令、网页和子任务操作。

**当前阶段：M3 受控动作增量建设中。** 已提供可运行的 Vue Web 用户/管理员界面、Fastify API、PostgreSQL 迁移、认证与资源权限、模型连接配置、DeepSeek/OpenAI-compatible 对话、Session/Run/Step/Event 持久化及页面刷新恢复。独立 Runner 已支持后台执行、租约、取消和异常终态；首版 TAO 循环、受限文件工具、结构化调用审计、白名单网页获取、SSE、文件变更审阅、单文件应用及审批后非特权 Shell 执行已落地。生产级磁盘/cgroup 隔离和多 Agent 委派仍按路线建设。

## 快速开始

环境：Node.js 24 LTS、npm 9+。现有开发环境也可暂时使用 Node.js 22.12+；生产目标是 24 LTS。在本仓库根目录执行：

```bash
npm ci
npm run dev
```

- Web 工作台：http://127.0.0.1:5173
- API 存活检查：http://127.0.0.1:4100/healthz
- 共享接口：http://127.0.0.1:4100/api/v1/health
- API 就绪检查：http://127.0.0.1:4100/readyz（配置数据库后才会返回 200）

默认开发启动仍不强制数据库；依赖首次安装需要访问 npm。`Ctrl+C` 停止开发进程。API 默认只监听本机；更改 API 端口时需同步修改 Web 的 Vite 代理。

```bash
npm run check       # 格式、类型和生产构建
npm run figma:build # 生成 Figma 插件 dist/code.js
npm run design:sync # 同步浏览器原型和架构图资产
npm run format      # 格式化
npm run build       # 构建共享包、API 和 Web
npm run start --workspace @agent-workbench/api
npm run db:migrate --workspace @agent-workbench/api # DATABASE_URL 已配置时执行迁移
```

当前是单机测试版本。用户对话提交返回任务 ID，API 与 Runner 通过数据库交接，页面轮询进度；只读工具受工作区根目录和预算限制。接口变化、运行参数与依赖图见 [ADR-0006](docs/decisions/0006-background-chat-runner.md) 和 [ADR-0007](docs/decisions/0007-tao-readonly-tools.md)。

## 目录

```text
agent-workbench/
├── apps/
│   ├── web/                   # Vue 用户工作台与管理员页面
│   ├── api/                   # Fastify 控制面，按领域组织模块
│   └── runner/                # 独立模型执行、租约、取消
├── packages/
│   ├── contracts/             # HTTP、事件与工具协议的共享契约
│   ├── runtime/               # 模型适配与 Think-Act-Observe 循环
│   ├── persistence/           # API/Runner 共用数据库与 Run 事务
│   └── tools/                 # 文件、受控 Shell 与白名单网页工具
├── docs/
│   ├── product/               # 定位、需求、页面与角色
│   ├── architecture/          # 数据模型、执行、事件、安全、扩展
│   ├── decisions/             # ADR：重要技术决策及原因
│   ├── roadmap/               # MVP 里程碑与验收清单
│   ├── development/           # 本地开发与模块约定
│   ├── deployment/            # 部署、升级、备份规划
│   └── research/              # Mao 借鉴与已核实边界
├── design/                    # tokens、浏览器原型、架构图和 Figma 插件
├── infra/compose/             # 本地 PostgreSQL
├── database/migrations/       # 版本化 SQL 迁移
├── tests/                     # 跨服务验收用例的放置约定
└── .github/workflows/ci.yml   # 推送后的构建检查
```

只有 README 的目录表示预留边界，不是已实现的包。首次实现时再添加代码、依赖和测试，避免提前建立大量空服务。

## 从哪里开始

1. 阅读 [产品需求](docs/product/prd.md)，确认用户、主场景和 MVP 范围。
2. 阅读 [技术架构总设计](docs/architecture/technical-architecture.md)、[架构总览](docs/architecture/overview.md) 和 [领域模型](docs/architecture/domain-model.md)，确定模块边界。
3. 按 [MVP 里程碑](docs/roadmap/mvp.md) 实现第一条任务闭环。
4. 遵循 [开发指南](docs/development/local-development.md)、[贡献约定](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

完整文档索引见 [docs/README.md](docs/README.md)。

## 项目约定

- 使用单仓库，先维护模块边界，按负载需求再拆服务。
- 单组织私有化部署起步，工作空间数据与权限从第一天明确归属。
- Agent 配置、会话和每次 Run 分开建模；已启动 Run 使用不可变配置快照。
- 服务端执行先落地，LOCAL Runner、MCP 和更多客户端后续扩展。
- Mao 的管理端布局与交互按 MIT 许可复用并二次开发，来源和版权声明见 `THIRD_PARTY_NOTICES.md`；业务 API、权限与执行内核保持本仓库独立实现。
- 所有 npm 包仍为 private；仓库采用 Apache-2.0，第三方依赖按各自许可证履行通知义务。
