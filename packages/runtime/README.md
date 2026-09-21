# Harness 运行内核

当前已实现 `ModelPort`、DeepSeek OpenAI-compatible 适配器、通用 OpenAI-compatible 适配器和环境变量 secretRef 解析；Think-Act-Observe 引擎仍按 M2 实现。

计划模块：

- `loop`：Think-Act-Observe 循环、完成判定、取消、超时与预算。
- `context`：提示组装、历史边界、压缩摘要与原文引用。
- `model`：模型适配接口与能力检查；当前首个实现为 `createDeepSeekClient`，自研兼容服务使用 `OpenAICompatibleModelClient`。
- `events`：结构化执行事件；不记录或要求模型的私有思维链。
- `subagents`：委派、等待、结果交付、取消传播与子任务配额。

允许依赖共享契约；通过接口注入模型、工具执行、策略、检查点和事件存储。不得依赖 Fastify、Vue、具体数据库或客户端连接。主循环不直接使用 child_process 或访问外网。

适配器只接受服务端传入的密钥，不把 secretRef 或密钥写入请求事件。当前通过注入 fetch 的协议 smoke test 验证请求地址、响应解析和环境密钥引用；真实 DeepSeek 连通性需在配置密钥后运行。

先验证单 Agent + 只读工具闭环，再增加受控写入和一层子任务。具体实施顺序见 `docs/roadmap/mvp.md`。
