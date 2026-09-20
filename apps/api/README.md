# API 控制面

负责认证、Agent 配置、模型登记、任务提交、审批、审计查询与事件订阅。

当前仅实现 `GET /healthz` 与 `GET /api/v1/health`，均为公开的进程存活检查；未接入数据库、认证、模型或任务执行。未来增加 `/readyz` 检查必要依赖，不能将存活检查当成生产就绪检查。

业务按领域放进 `src/modules/<domain>/`。首批领域为 `identity`、`agents`、`models`、`runs`、`approvals`、`audit`，在实现对应需求时创建。每个领域按需要拆分 routes、schema、service、repository；禁止 route 直接运行 Shell 或拼接模型请求。

`app.ts` 创建实例，`main.ts` 加载环境并监听端口，便于后续使用 Fastify `inject` 验证接口。配置示例见 `.env.example`，复制为同目录 `.env` 即可；默认配置无需文件。
