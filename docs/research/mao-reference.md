# Mao 设计参考

调研日期：2026-09-20；管理端复核日期：2026-09-26。用户提供地址：<https://github.com/yupengsheng/mao.git>。

最初的执行内核调研来自本地 checkout `f5e7ae47ceae047867255b97b88e9bdca3cee842`（2026-09-18）。管理端改版另行拉取并核对了用户仓库 `main` 的 `a57e8c273c9626062a69beca1ad100888e36626a`。下面的运行内核源码链接仍指向最初实际查看的固定提交。

这是设计与复用记录，不是完整代码审计、漏洞报告或生产验证。管理端壳层、导航、页签、间距和响应式行为按 Mao 的 MIT 许可改编，版权与许可全文见 `THIRD_PARTY_NOTICES.md`；Mao 后端、数据库和执行语义没有复制。

## 借鉴映射

| 参考能力             | 本仓库采用的思路                                   | 来源                                                                                                                                                                        |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLOUD / LOCAL        | 执行位置和模型调用位置分别配置，先做服务端 Runner  | [README](https://github.com/DC-ET/mao/blob/f5e7ae47ceae047867255b97b88e9bdca3cee842/README.md)                                                                              |
| Harness 分层         | 循环、上下文、工具分发、事件和持久化通过接口分离   | [agent-loop.ts](https://github.com/DC-ET/mao/blob/f5e7ae47ceae047867255b97b88e9bdca3cee842/backend-ts/src/harness/core/agent-loop.ts)                                       |
| Session 与执行上下文 | 将工作区、模型和权限显式传递；进一步独立出每次 Run | [agent-execution-context.ts](https://github.com/DC-ET/mao/blob/f5e7ae47ceae047867255b97b88e9bdca3cee842/backend-ts/src/harness/core/agent-execution-context.ts)             |
| 后台子 Agent         | 异步启动、等待、汇总和取消；独立子 Run 过程        | [tool-registry.ts](https://github.com/DC-ET/mao/blob/f5e7ae47ceae047867255b97b88e9bdca3cee842/backend-ts/src/harness/tool/tool-registry.ts)                                 |
| 子任务持久化         | 父子关系、执行状态与结果投递记录                   | [subagent-invocation.service.ts](https://github.com/DC-ET/mao/blob/f5e7ae47ceae047867255b97b88e9bdca3cee842/backend-ts/src/harness/delegate/subagent-invocation.service.ts) |
| 上下文压缩           | 摘要保留目标、边界和原始历史引用                   | [compaction-archive.service.ts](https://github.com/DC-ET/mao/blob/f5e7ae47ceae047867255b97b88e9bdca3cee842/backend-ts/src/harness/core/compaction-archive.service.ts)       |
| Skill / MCP          | 按需知识与统一外部工具契约，排在内置闭环之后       | [project.md](https://github.com/DC-ET/mao/blob/f5e7ae47ceae047867255b97b88e9bdca3cee842/skills/mao-cli/reference/project.md)                                                |

## 需要明确加强的边界

- 参考文档与当前源码存在时代差异：早期技术方案包含 Java 路径，现有后端为 TypeScript；注册表当前使用后台子 Agent 工具，不能仅凭旧 delegate 设计认定现行执行方式是同步。
- `best-agent-spec` 含教学式 Python/JSONL 示例。任务图、邮箱与 worktree 的思路可借鉴，不能据此宣称同等平台能力已落地。
- Agent 提示词版本不等于完整配置快照；本仓库计划固化工具、策略、模型配置和输入引用。
- 路径校验和命令危险分类不能替代操作系统隔离。模型返回未知格式不应按安全处理；所有调用应经过确定性策略。
- 已有管理 API 审计、调用流水与会话消息并不自动等于防篡改的全链路审计；需明确事件、身份和保留边界。
- 有工作目录或 Git worktree 不代表命令运行在安全沙箱；有本地执行能力不代表内容不会发送给远端模型。
- 历史轨迹回放与再次执行分开定义，不承诺随机模型/动态网页的确定性重现。

## 范围取舍

优先吸收运行内核、执行边界、子任务可见性、上下文恢复与扩展接口。暂缓多端、IM、市场和自动化画布，把首版投入集中在可观察、可控的真实任务闭环。

## 当前 Web 界面实现

2026-09-22 起，用户工作台采用 Mao 的任务工作流作为交互参考：顶部窄导航、左侧工作空间与会话列表、中间主工作区、右侧任务检查器。当前实现位于 `apps/web/src/features/layout/WorkbenchShell.vue` 和 `RunInspector.vue`，不引入 Mao 的桌面端依赖；现有认证、工作空间权限、模型配置、Chat、Jev 路由和 Run SSE 仍沿用本仓库 API。

2026-09-26 起，管理员控制台按 Mao 管理后台实现固定侧栏、56px 顶栏、36px 多页签栏、单模块内容区和移动端抽屉导航，代码位于 `apps/web/src/features/admin/AdminShell.vue`。实现复用了 Mao 的界面结构和视觉参数，并替换为本仓库的 Vue 组件、Lucide 图标、公开契约和权限逻辑。

用户工作台右侧检查器显示服务端 Runner 状态、实际路由模型、TAO 事件和密钥策略。会话列表使用持久化 Session 索引。两套界面都继续使用本仓库的认证、权限、模型密钥、Jev、审计和执行 API。
