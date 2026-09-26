# ADR-0008：使用 TypeSafe Jev 进行多模型选择

- 状态：已实现（M2 增量）
- 日期：2026-09-22

## 背景

工作台允许管理员配置多个 DeepSeek 或 OpenAI-compatible 模型。固定选择适合调试，但无法根据请求类型、工具能力和模型配置自动选择。路由必须运行在服务端，且不能把权限、候选范围或低置信度判断交给模型。

## 决策

1. 聊天请求保留 `fixed` 模式，并新增 `routing.mode=jev`。Jev 模式可以带候选连接白名单；省略时使用当前工作空间全部 active 且已配置密钥的连接。
2. API 只校验访问权、密钥可用性并把候选的 ID、provider、model、baseUrl、capabilities、updatedAt 快照写入 Run；API 不调用 Jev。
3. Runner 重新校验候选仍属于工作空间、处于 active 且快照未变化，然后使用 `@typesafe-ai/sdk` 的 `jev-latest` Choice 请求选择一个候选。
4. Runner 只接受候选快照中的 ID，要求置信度达到 `TYPESAFE_ROUTER_MIN_CONFIDENCE`（默认 `0.65`），并在 fencing lease 下写入 `model.routed` 事件和实际 `runs.model_connection_id`。Jev 失败、返回未知候选或低置信度时不调用任何业务模型。
5. TypeSafe API Key 只存在 Runner 环境变量 `TYPESAFE_API_KEY`，不写数据库、不写事件 payload、不返回浏览器。路由超时由 `TYPESAFE_ROUTER_TIMEOUT_MS` 控制，默认 5 秒。
6. 每次 Jev 请求在审计表记录 started 和 completed/failed/cancelled 终态。成功记录候选、概率、选择、置信度和耗时；失败记录错误码和耗时。提示词、回复正文和 TypeSafe API Key 不进入审计。管理端通过模型范围分页查询独立展示 Jev 与下游模型调用。

## 取舍

Jev 能把自然语言请求和候选能力转成结构化 Choice，并提供概率与置信度，适合有限候选路由。它会增加一次外部调用、延迟和成本，因此单候选直接确定选择；固定模式始终保留用于人工控制和 Jev 故障时的恢复。程序继续负责候选授权、阈值、预算和停止条件。

## 验证

- 契约测试覆盖固定模式兼容、Jev 无固定模型、重复候选拒绝。
- Runtime 单测使用注入 fetch 验证 `jev-latest` Choice、概率解析和未知候选拒绝。
- Runner 路径在运行时重新检查候选连接配置，防止入队后管理员修改模型导致越权或调用旧配置。
- PostgreSQL 集成测试验证路由生命周期、模型范围查询及敏感输入不进入审计；浏览器测试验证候选概率和模型请求摘要。
