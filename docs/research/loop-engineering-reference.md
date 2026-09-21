# Loop engineering 参考资料

## 资料信息

- **标题**：Loop engineering：把 agent 放进工程循环
- **资料类型**：用户提供的中文转载/整理稿，作为设计研究输入，不是本项目的规范或实现证明。
- **记录日期**：2026-09-21
- **原始文章链接**：[Loop Engineering](https://addyosmani.com/blog/loop-engineering/)
- **相关参考**：[Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html)、[Ralph loop 实验](https://amplitude.com/blog/ralph-loop)
- **版权与使用边界**：仓库只保存摘要、分析和项目映射，不复制文章全文、图片或未授权附件。链接失效时，以本文件中的项目决策和已验证实现为准。

## 核心观点摘要

文章把 loop engineering 定义为工程流程设计，而不是重复发送 prompt。一个可工作的 loop 至少需要：

1. 读取外部状态，例如 CI、Issue、PR、日志、反馈和代码差异。
2. 判断下一步，区分可以自动处理、需要提案和必须交给人的情况。
3. 执行任务，在隔离环境中读取、修改或调用工具。
4. 验证结果，通过测试、复现、浏览器检查、审查或安全扫描获得结构化证据。
5. 写入状态，把结论、失败原因、尝试记录和下一步放到对话之外。
6. 判断停止条件，继续、重试、改变策略、升级给人或结束。

文章进一步把支撑 loop 的能力归纳为六类：唤醒 loop 的 automation、隔离并行工作的 worktree、沉淀项目知识的 skills、连接外部系统的 plugins/connectors、分离实现与检查职责的 sub-agents，以及持久化上下文的 memory。

文章强调，自动化程度不是主要指标。适合自动化的任务应同时满足：输入稳定、输出可审阅、验证明确、权限可控、失败可恢复，并且失败或成功能够沉淀为可复用的规则、fixture、skill、脚本或 workflow。

## 与本项目的映射

| 文章概念               | 本项目对应设计                                                        | 当前状态                | 采用边界                                                               |
| ---------------------- | --------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| Automation / heartbeat | 后续的 Scheduler、Run 唤醒、Runner lease/heartbeat、生命周期 hooks    | 目标设计                | 唤醒不等于授权；每次唤醒都重新检查权限、预算和取消状态                 |
| Worktree / isolation   | Runner 的执行工作区、未来 Git worktree 与隔离沙箱                     | 目标设计                | worktree 解决文件冲突，不替代容器、资源限制、网络策略和路径授权        |
| Skills                 | 版本化 Skill 说明与资源包，按需注入 Harness                           | 架构已记录，待 M4+      | Skill 只能提供知识，不能扩大用户或 Run 的权限                          |
| Plugins / connectors   | `ToolPort`、MCP/外部连接器、Feishu `ChannelAdapter`                   | 接口边界已记录          | 插件是分发/接入机制；凭证、审批、审计和资源授权仍由平台控制            |
| Sub-agents             | `parentRunId`、独立子 Run、预算与权限交集                             | 数据模型已预留，M4 实现 | 子任务必须独立记录状态、事件、产物和结果投递，不能通过共享内存传递事实 |
| Memory / state         | Session、Run、Step、RunEvent、Artifact、未来 checkpoint 和 loop state | M2 已持久化基础闭环     | 对话历史不是唯一状态；数据库事件是事实来源，记忆内容必须可追溯和可清理 |
| Maker / checker        | 主执行 Harness 与 verifier/reviewer/security reviewer 分工            | M2/M3 设计约束          | 验证结果必须结构化落盘；实现者不能作为唯一验收者                       |
| Stop conditions        | 预算、步数、时长、取消、连续失败、风险升级和人工审批                  | M2-M3 待实现            | 停止条件由服务端确定性执行，不能只写在 prompt 中                       |

## 对现有技术架构的补充要求

### Loop 的持久化状态

Run 每次循环应记录至少以下信息：

- 输入状态快照和来源范围；
- 当前步骤、尝试次数、预算消耗和执行者；
- 调用的模型、工具、Skill 或 Connector 版本；
- 验证命令、退出码、失败用例和结构化结论；
- 重试、策略切换、人工接管和停止原因；
- 下一轮可读取的摘要，以及原始事件或产物引用。

`loop-state.md` 可以作为开发期的人类可读交接物，但生产事实应进入 Run/Event/Artifact 存储，并具备 workspace、用户和 Run 权限检查。状态文件不能绕过审计，也不能成为唯一事实来源。

### 权限分层

参考文章中的 `observe`、`propose`、`act with approval`、`autonomous` 四级能力，映射为本项目的工具风险策略：

- **observe**：读取允许的文件、日志、CI 和 Run 状态；不能产生外部副作用。
- **propose**：生成 patch、报告或 PR 草稿；需要保留 diff 和验证证据。
- **act with approval**：执行写文件、Shell、外部网络或第三方写操作前，持久化精确参数、资源范围和审批决定。
- **autonomous**：只用于低风险、可回滚、验证强且预算有限的动作，必须有明确 allowlist。

权限有效范围仍是用户授权、Workspace 策略、Agent 版本权限、Run 授权和 Runner 能力的交集。模型、Skill、Connector 或文章中的自动化规则都不能自行扩大这个交集。

### Maker/checker 与证据链

实现 Agent 负责提出和执行动作，Verifier 负责复现验收条件，Reviewer 负责审阅范围和回归风险，Security reviewer 只处理安全边界。小任务可以合并角色，但不能省略验证证据。验证器必须看到原始命令、退出码和失败输出摘要，不能把“部分通过”解释成成功。

## 分阶段落地

| 阶段                 | 从本文吸收的内容                                                    | 交付标准                                                                     |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| M2 单 Agent 只读闭环 | Session/Run/Step/Event、失败状态、基础停止条件、恢复最近状态        | 同步对话和失败结果可查询；刷新页面能恢复；密钥错误不会产生永久 running Run   |
| M3 受控动作          | observe/propose/approval 分层、验证证据、隔离工作区、hooks/策略护栏 | 拒绝审批无副作用；批准只作用于精确调用；Shell/写文件有资源和时长限制         |
| M4 多 Agent 长任务   | parent/child Run、maker/checker、预算树、取消传播、上下文压缩       | 子任务不能提权；父取消覆盖子 Run；失败不会被汇总成成功；重启不盲目重放副作用 |
| M5 私有化交付        | Scheduler、部署运维、备份恢复、loop 状态观测和固定样例              | 新环境可按文档部署；每个自动化 loop 有输入、输出、验证、权限、预算和停止条件 |

## 采用与暂缓的决定

本项目采用“先控制面、后自动化”的顺序：先让 Run、事件、权限、预算、验证和审计成为事实，再加入定时唤醒、并行 worktree、子 Agent 和外部连接器。首个自动化样例优先选择 CI triage 或只读代码分析，因为输入稳定、输出可审阅且容易停止。

暂缓以下做法：无边界的定时 prompt、自动合并任意 Agent 变更、把共享 worktree 当作安全隔离、把聊天记录当作长期记忆、让实现 Agent 自己宣布验收成功，以及在没有回滚和结果不明语义时自动重放外部写操作。

这些是项目约束的补充说明，具体实现仍以 [技术架构](../architecture/technical-architecture.md)、[执行引擎](../architecture/execution-engine.md)、[安全与权限](../architecture/security.md)、[阶段门槛](../roadmap/phase-gates.md) 和对应 ADR 为准。
