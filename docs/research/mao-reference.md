# Mao 设计参考

调研日期：2026-09-20。用户提供地址：<https://github.com/yupengsheng/mao.git>。

本次参考来自已有本地 checkout：`/home/yupengsheng/workspace/mao`，remote 为 `https://github.com/DC-ET/mao.git`，提交 `f5e7ae47ceae047867255b97b88e9bdca3cee842`（2026-09-18）。未确认两个远端的关系或 GitHub 最新状态；下面的源码链接指向实际查看的提交。

这是设计借鉴记录，不是完整代码审计、漏洞报告或生产验证。没有把 Mao 代码复制进本仓库。

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
