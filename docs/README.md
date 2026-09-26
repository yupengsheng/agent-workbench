# 文档索引

文档基线：2026-09-21。产品 v0.1、技术架构 v0.3 为目标设计；实现进度见根 README 和里程碑。外部文章的收录、核验与采纳按[研究资料管理](research/README.md)分别记录。

| 文档                                                            | 内容                                              |
| --------------------------------------------------------------- | ------------------------------------------------- |
| [产品需求](product/prd.md)                                      | 目标用户、核心场景、功能范围与验收                |
| [信息架构](product/information-architecture.md)                 | 页面、角色与关键操作路径                          |
| [设计系统](product/design-system.md)                            | Tokens、组件状态、视觉和可访问性基线              |
| [交互原型](product/prototype.md)                                | 页面地图、状态逻辑和评审脚本                      |
| [技术架构总设计](architecture/technical-architecture.md)        | 分层、部署拓扑、数据流和质量门槛                  |
| [架构总览](architecture/overview.md)                            | 控制面/执行面、依赖与演进                         |
| [领域模型](architecture/domain-model.md)                        | Agent、Session、Run、调用、审批、产物             |
| [模块边界](architecture/module-boundaries.md)                   | 控制面、执行面、Web 与组件职责                    |
| [执行引擎](architecture/execution-engine.md)                    | TAO 循环、状态机、子任务、恢复                    |
| [工具与扩展](architecture/tools-and-extensions.md)              | 工具契约、模型适配、Skill 与 MCP                  |
| [安全与权限](architecture/security.md)                          | 授权、沙箱、审批、数据边界                        |
| [事件与审计](architecture/events-and-audit.md)                  | 持久化、订阅、补齐、追溯                          |
| [技术决策 ADR-0001](decisions/0001-repository-and-stack.md)     | 仓库、技术栈与 MVP 取舍                           |
| [MVP 路线](roadmap/mvp.md)                                      | 依赖顺序、完成条件、首条任务闭环                  |
| [阶段门槛](roadmap/phase-gates.md)                              | 进入/退出标准、性能和恢复验收                     |
| [开发指南](development/local-development.md)                    | 命令、环境变量、模块新增、常见问题                |
| [长期维护](development/maintainability.md)                      | 版本、依赖、迁移、组件和测试治理                  |
| [部署规划](deployment/self-hosting.md)                          | 本地环境、生产交付与离线条件                      |
| [Mao 调研](research/mao-reference.md)                           | 可借鉴设计、源码证据与差距                        |
| [Agent 设计调研](research/agent-landscape.md)                   | LangGraph、MAF、AutoGen、CrewAI、OpenHands 等比较 |
| [Loop engineering 参考](research/loop-engineering-reference.md) | Loop、Harness、自动化、验证、状态与停止条件映射   |

[ADR-0006：后台对话 Runner](decisions/0006-background-chat-runner.md)记录本轮实际架构、202 提交协议、租约与取消语义。
[ADR-0011：文件变更审批](decisions/0011-file-change-review.md)记录提案、持久化审批和“批准不写盘”的边界。
[ADR-0012：受控 Shell](decisions/0012-sandbox-shell.md)记录命令提案、审批、非特权执行、资源限制与结果不明语义。
[ADR-0013：受控网页获取](decisions/0013-restricted-web-fetch.md)记录域名白名单、固定 DNS 解析地址、跳转校验和内容边界。

业务模块的使用说明放模块 README；架构理由放 ADR；一次性调查记录放 research。避免在不同位置复制同一套部署步骤。
