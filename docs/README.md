# 文档索引

文档基线：2026-09-20。产品与架构均为 v0.1 草案；当前代码只完成开发骨架。修改实现范围时同步更新根 README 和里程碑。

| 文档                                                        | 内容                                  |
| ----------------------------------------------------------- | ------------------------------------- |
| [产品需求](product/prd.md)                                  | 目标用户、核心场景、功能范围与验收    |
| [信息架构](product/information-architecture.md)             | 页面、角色与关键操作路径              |
| [架构总览](architecture/overview.md)                        | 控制面/执行面、依赖与演进             |
| [领域模型](architecture/domain-model.md)                    | Agent、Session、Run、调用、审批、产物 |
| [执行引擎](architecture/execution-engine.md)                | TAO 循环、状态机、子任务、恢复        |
| [工具与扩展](architecture/tools-and-extensions.md)          | 工具契约、模型适配、Skill 与 MCP      |
| [安全与权限](architecture/security.md)                      | 授权、沙箱、审批、数据边界            |
| [事件与审计](architecture/events-and-audit.md)              | 持久化、订阅、补齐、追溯              |
| [技术决策 ADR-0001](decisions/0001-repository-and-stack.md) | 仓库、技术栈与 MVP 取舍               |
| [MVP 路线](roadmap/mvp.md)                                  | 依赖顺序、完成条件、首条任务闭环      |
| [开发指南](development/local-development.md)                | 命令、环境变量、模块新增、常见问题    |
| [部署规划](deployment/self-hosting.md)                      | 本地环境、生产交付与离线条件          |
| [Mao 调研](research/mao-reference.md)                       | 可借鉴设计、源码证据与差距            |

业务模块的使用说明放模块 README；架构理由放 ADR；一次性调查记录放 research。避免在不同位置复制同一套部署步骤。
