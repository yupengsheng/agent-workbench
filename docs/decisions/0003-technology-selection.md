# ADR-0003：技术栈比较与选择

日期：2026-09-20。状态：作为 v0.2 设计基线采用；表中的验证门槛尚未通过即不得标为业务已实现。优先级：正确性/隔离、维护性、现有能力匹配、部署负担、生态；不凭未经测量的性能数字选型。

替代 ADR-0001 的运行版本、事件传输和未定技术选型。当前应用代码仍为 Vue/Fastify 骨架，下面大部分依赖要按阶段引入。

| 决策       | 比较方案                                               | 当前选择与理由                                                        | 代价/迁移触发条件                                                                                     |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 开源许可   | MIT / Apache-2.0 / MPL / AGPL                          | Apache-2.0，商业集成与专利授权较清晰                                  | 不能阻止商业 fork；见 ADR-0002                                                                        |
| 仓库与构建 | npm workspaces / pnpm+Turbo / Nx                       | npm workspaces；已有锁文件与少量包，降低认知负担                      | CI 构建 P95 超 5 分钟或重复构建显著时评估 Turbo；不要为了架构图提前上缓存系统                         |
| 服务语言   | TypeScript+Node / Python+FastAPI / C#+ASP.NET          | TypeScript+Node 24 LTS，契约与前端一致                                | Python/.NET 作为独立可选 Runner 时必须走协议；保留 Node 22 临时兼容并在 M1 退出                       |
| 前端       | Vue 3 / React / Angular                                | Vue 3+Vite，延续现有代码；团队复杂度低                                | React 图编辑生态较强，但工作流画布是后续能力；不为远期画布重写当前应用                                |
| UI 基础    | Naive UI / Element Plus / Reka+Tailwind                | Naive UI 为生产基础候选，主题 tokens 封装；数据表/表单减少自维护      | 自定义外观与可访问性需 PoC；主题/键盘验收失败再复评 Element Plus 或 Reka                              |
| 前端状态   | Pinia 全包 / Vue Query+Pinia / 自建请求缓存            | Vue Query 管服务端缓存，Pinia 只管 UI/草稿，Vue Router 管导航         | 两套状态边界必须清楚，Run 事件不能同时重复维护三份真相                                                |
| API 框架   | Fastify / NestJS / FastAPI                             | Fastify 模块化单体，沿用现有实例工厂与插件结构                        | NestJS DI/模块规范更完整；领域插件和依赖约束先补足，非纯性能取舍                                      |
| 契约与校验 | Zod / TypeBox / JSON Schema 手写                       | Zod 4 作为运行时领域 Schema，导出 JSON Schema/OpenAPI                 | Fastify JSON Schema 集成需验证；不得允许转换丢失策略校验，必要时 API 边界用原生 JSON Schema           |
| Agent 编排 | LangGraph JS / 完全自研循环 / MAF / CrewAI             | LangGraph JS 通过 EnginePort 接入，避免自己维护完整恢复引擎           | 框架对象隔离在适配层；中断/重启/副作用 PoC 是硬门槛，失败时复评薄循环方案                             |
| 模型接入   | 官方 SDK 适配器 / 窄 ModelPort+兼容协议 / LiteLLM 网关 | 先用窄 ModelPort 接 DeepSeek OpenAI-compatible 接口，再接自研兼容服务 | 先实现工具调用、取消、错误分类和能力测试；供应商超过 3 个或路由复杂时评估网关；禁止“兼容”即假设全支持 |
| 关系数据库 | PostgreSQL / MySQL / SQLite                            | PostgreSQL 17，JSONB、事务与任务交接统一                              | 比 SQLite 部署重；支持周期与升级演练纳入维护，不捆绑向量能力                                          |
| 数据访问   | Drizzle / Prisma / Kysely                              | Drizzle+审阅过的 SQL 迁移，SQL 显式可见                               | 框架迁移生成并非安全证明；已有库升级、索引锁和回填必须测试                                            |
| 调度       | pg-boss / BullMQ+Redis / Temporal / 自建 SQL 轮询      | pg-boss，沿用 PostgreSQL；Run 是业务事实，队列仅触发工作              | 不信任重复投递可以完全消失；业务幂等与 fencing 自己定义；大量跨天流程时评估 Temporal                  |
| 浏览器事件 | SSE+REST / WebSocket / 轮询                            | REST 命令+SSE 订阅，单向事件恢复更简单                                | 同域 Cookie 鉴权、游标补齐、代理缓冲验证；LOCAL 双向工具通道后续用 WebSocket                          |
| 产物存储   | 本地目录 / S3兼容存储 / 数据库大对象                   | ArtifactStore：试点本地，生产按规模接 S3                              | 不把某个 S3 服务当必须依赖；下载授权、散列校验、备份都必须一致                                        |
| 身份       | 自建所有 SSO / OIDC库+可选IdP / 强制Keycloak           | 本地账号起步，标准 OIDC 适配；企业可配现有 IdP                        | Argon2id、会话Cookie、CSRF、限速是本地账号门槛；不维护自研 OAuth/OIDC 协议                            |
| 工具授权   | 小型确定性规则 / Casbin / OPA-Cedar                    | 明确有限规则集与 PolicyPort；业务 RBAC+资源归属，与工具授权分层       | 禁止成长为自创脚本语言；出现跨服务共享复杂策略时迁移 OPA/Cedar                                        |
| 执行隔离   | 普通容器 / gVisor / Firecracker                        | OCI容器+gVisor 作为不可信 Shell 目标；只读工具先落地                  | gVisor兼容/资源测试不过不得开放任意Shell；worktree/路径检查不能替代隔离                               |
| 观测       | OpenTelemetry / 平台自定义日志 / 强绑定Langfuse        | OTel语义+结构化日志，兼容组织已有后端                                 | 模型正文默认不导出；Langfuse/Phoenix按数据策略可选，审计存储独立                                      |
| 测试评测   | Vitest+Playwright+固定评测 / 纯E2E / LangSmith托管     | 业务单测+数据库集成+浏览器关键路径+离线样例                           | 测试按风险分层；模型评测单独预算，不能把外网模型纳入每次CI必需条件                                    |
| 部署       | Compose / Kubernetes / 一开始全套微服务                | Compose试点，模块化单体API+独立Runner                                 | 多节点调度/可用性要求出现后提供Helm；避免给首批用户额外运维集群                                       |
| 原型交付   | Figma原生组件 / 图片稿 / 直接业务实现                  | 原生 Figma 插件生成 + 同源浏览器交互预览                              | 当前无Figma写入连接，不能宣称文件已写入；导入后仍需人工验收布局/连线                                  |

## 引入顺序

本次只加入许可、设计资产、Figma 插件构建与验证工具。业务依赖按 [建设标准](../roadmap/phase-gates.md) 引入；每次锁定稳定版本、记录许可证与退出成本。不批量安装尚未使用的生产框架。

## 生命周期依据

[Node 官方发布计划](https://github.com/nodejs/Release/blob/main/schedule.json) 记录 22 的支持结束为 2027-04-30，24 为 2028-04-30；采用 24 目标基线，22 仅给现有开发环境过渡。CI 同时检查过渡版本，发布镜像目标版本固定到经过验证的 patch/digest。

[PostgreSQL 版本政策](https://www.postgresql.org/support/versioning/)、[pg-boss](https://github.com/timgit/pg-boss)、[Drizzle](https://orm.drizzle.team/docs/overview)、[SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)、[gVisor](https://gvisor.dev/docs/)。Agent 框架证据见 [调研](../research/agent-landscape.md)。UI/ORM/身份相关选型是架构判断，不声称已经完成生产验证。
