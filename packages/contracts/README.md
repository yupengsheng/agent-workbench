# 共享契约

前端、API、Runner 共用的 HTTP DTO、运行事件与工具调用协议。当前仅有健康检查响应；领域模型草案见 `docs/architecture/domain-model.md`，在对应功能开发时将已确认部分转为类型与运行时 Schema。

本包保持纯 TypeScript，不依赖 Vue、Fastify、数据库或运行时引擎。禁止将数据库实体直接导出给客户端。TypeScript 类型不替代接口边界上的运行时校验。

先构建本包，再构建消费者；根目录 `npm run dev`、`typecheck`、`build` 已安排顺序。消费者通过包名导入，禁止跨包相对路径导入源码。
