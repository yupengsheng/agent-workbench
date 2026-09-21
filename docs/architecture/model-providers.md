# 模型提供商与自研模型路线

状态：DeepSeek 适配器已在 `packages/runtime` 完成协议级 smoke 验证；API 模型连接管理、管理员配置页面和服务端测试接口已实现。真实联网测试需要在部署环境配置对应的 `env:NAME` 密钥引用；Runner 调用尚未接入。

## 选择比较

| 方案                                          | 优点                                                | 代价                                       | 本项目决定                          |
| --------------------------------------------- | --------------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| 每个供应商使用官方 SDK                        | 参数和错误语义更完整                                | 依赖多、供应商对象进入业务边界、替换成本高 | 暂不作为第一层抽象                  |
| LiteLLM 等统一网关                            | 供应商覆盖广、路由和预算能力成熟                    | 增加部署组件，密钥、日志和故障边界外移     | 供应商超过 3 个或需要复杂路由时评估 |
| 自建窄 `ModelPort` + OpenAI-compatible 适配器 | 依赖少，DeepSeek 和自研 HTTP 服务可共用，适合私有化 | 需要自己处理协议差异、能力探测和错误恢复   | 当前选择                            |
| 直接在 API 路由中请求模型                     | 起步快                                              | 绕过 Runner/预算/审计，无法可靠恢复        | 明确禁止                            |

## 第一阶段：DeepSeek

`createDeepSeekClient` 默认使用 `https://api.deepseek.com/chat/completions` 和 `deepseek-chat`，支持消息、工具描述、温度、最大输出 Token、工具调用解析、用量和可重试错误。真实 API Key 只通过服务端 `env:VARIABLE` 引用解析，不能进入浏览器、事件或审计 metadata。

连接记录中的 `provider=deepseek`、模型标识和能力声明由管理员配置；Runner 在创建 ModelPort 时重新解析 secretRef，并把调用用量和响应状态写入执行事件。能力声明不能代替真实测试结果。

## 第二阶段：自研/私有模型

自研模型优先实现 OpenAI-compatible `/chat/completions`，通过同一个 `OpenAICompatibleModelClient` 配置：

```text
provider       = self-hosted 或组织定义的标识
baseUrl        = 内网 HTTPS 地址
model          = 模型服务标识
secretRef      = none 或 env:/secret: 引用
capabilities   = 经测试确认的能力集合
```

如果自研模型协议不是 OpenAI-compatible，新增独立适配器实现 `ModelPort`，不修改 Agent、Run、审批和事件协议。适配器必须提供超时、取消、响应结构校验、错误可重试性和能力探测；流式输出作为同一接口的后续扩展。

## 能力测试门槛

模型连接标记为可用前，至少验证：普通文本、超时取消、无效响应、工具调用（若声明支持）和 Token 用量。测试失败只更新连接测试状态，不修改 Agent 已发布版本，也不会自动重试可能产生外部副作用的动作。
