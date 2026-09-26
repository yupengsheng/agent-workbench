# 主流 Agent 设计调研

调研日期：2026-09-20。证据分为“实际读取的官方材料”和“未成功读取的候选”；不把项目宣传的性能或成熟度当成本项目测量结果。

## 方案比较

| 项目                      | 观察到的设计                                                                     | 可借鉴部分                                     | 集成代价/边界                                                      | 决定                                                    |
| ------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| LangGraph JS              | 长任务状态图、checkpoint、持久执行、人工中断、流式事件；不要求同时使用 LangChain | 显式状态、恢复点、确定性步骤与模型决策混合     | checkpoint 与业务 Run 的职责需分开；副作用仍要幂等                 | **首选引擎适配器**，M2 PoC 通过才进入生产路径           |
| Microsoft Agent Framework | Agent 与 workflow 分层、会话状态、中间件、遥测、多 Agent 显式路径                | 协议化协作、上下文服务、生命周期边界           | 与当前 TS 控制面存在运行语言与运维成本差异；需核对选用语言的稳定性 | 有 .NET/Python 团队时优先复评，当前不引入第二种运行语言 |
| AutoGen                   | Core 消息/事件层、AgentChat、扩展层                                              | 分层通信与角色协作                             | 官方 README 已声明维护模式，不再新增功能并建议新项目用 MAF         | 保留思想参考，不作为新平台主依赖                        |
| CrewAI                    | Crew 角色任务与 Flow 状态/事件/条件控制结合                                      | 业务职责与可控流程分离                         | Python 运行栈，抽象更偏业务任务；安全沙箱仍需自行治理              | 适合流程型连接器 PoC，当前不作为内核                    |
| OpenHands                 | Agent Server/SDK、前端客户端和自动化服务分离，提供沙箱执行选项                   | 工具执行环境与控制 UI 分离、任务轨迹与代码产物 | 产品/SDK/客户端分别迭代，不能把完整产品等价为轻量通用库            | 学习编码任务产品模型，避免整体 fork 绑定                |
| Claude Agent SDK          | 复用 Claude Code 的工具、上下文和授权能力，支持 SDK 方式驱动任务                 | 工具生命周期、权限钩子、长任务控制             | 供应商运行时/模型耦合，认证、使用条款需独立核实                    | 未来作为可选编码 Runner，平台不能依赖其存在             |
| Mao                       | 自托管管理面、CLOUD/LOCAL、子任务可见性、Skill/MCP、恢复                         | 本地执行通道、运行视图、Agent 管理             | 代码与历史设计文档有差异，平台级治理仍需独立验证                   | 管理端按 MIT 复用；控制面与执行内核独立实现             |
| OpenAI Agents SDK / Codex | 本次官方文档入口返回 403，未取得可审阅正文                                       | 保留候选项                                     | 不依据记忆宣称当前供应商支持范围、授权或持久化能力                 | **待核验**，不用于本次决定的硬性依据                    |

## 跨项目提炼

1. 对话只是入口。AgentDefinition、Session、Run、ToolInvocation、Artifact 分开，避免把执行状态藏在聊天消息中。
2. 编排框架管理执行推进，平台管理身份、资源、授权、租约、用量与审计。不要让框架私有对象泄漏到公开 API。
3. 显式中断优于“模型自己记得停”；审批与输入等待持久化，恢复时核对准确操作。
4. 并行委派必须带权限交集、预算、取消、文件归属与结果投递语义。
5. checkpoint 不等于外部副作用 exactly-once。工具需要幂等键或状态查询；结果不明时不能重放。
6. Skill/MCP 扩展通过统一工具管线；模型和外部内容不能改写平台权限。
7. 自动化评测与故障场景比框架流行度更能决定长期可维护性。

## 原始来源

- [LangGraph JS overview](https://docs.langchain.com/oss/javascript/langgraph/overview)、[durable execution](https://docs.langchain.com/oss/javascript/langgraph/durable-execution)。
- [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/)、[AutoGen README](https://github.com/microsoft/autogen/blob/main/README.md)。
- [CrewAI Flows](https://docs.crewai.com/en/concepts/flows)。
- [OpenHands README](https://github.com/OpenHands/OpenHands/blob/main/README.md)。
- [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)。
- [Mao 固定提交调研](mao-reference.md)。
- 未成功读取：[OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents-sdk)、[Codex security](https://developers.openai.com/codex/security)。

动态官方页面可能改变，实际抓取的 URL、状态与正文摘要哈希见 [sources.json](sources.json)。框架能力、许可证和具体版本在引入依赖时再核对并锁定。没有进行跨框架性能基准，不对速度/成本给出伪精确排名。
