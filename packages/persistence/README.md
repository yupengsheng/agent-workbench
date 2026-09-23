# 服务端持久化

API 与 Runner 共用的 PostgreSQL Schema、连接工厂、Run 事务和托管模型密钥解析。公开子路径：`client`、`schema`、`secrets`、`runs`。只允许服务端应用导入；Web 使用 contracts DTO，runtime 不依赖本包。

`runs` 协调领取、续租、完成、取消和过期回收。追加事件前持有 Run 行锁；完成与对应事件原子提交。租约采用数据库时间和随机 token，旧执行者不能续租或写回。

Schema 移自 API，原 API 文件仅保留兼容导出。没有复制第二套表。Runner 租约使用 `database/migrations/0006_runner_leases.sql`，文件变更审阅使用 `database/migrations/0007_file_change_reviews.sql`，受控应用状态使用 `database/migrations/0008_file_change_application.sql`。`file-changes` 持久化层负责提案查询、摘要校验、审批状态迁移、应用领取/确认、审计和 Run 事件；真正的文件读写仍只在 Runner 的工具执行面进行。

参数和策略见 [ADR-0006](../../docs/decisions/0006-background-chat-runner.md)。密钥加密格式保持 v1/AES-256-GCM，升级不轮换 `MODEL_SECRET_ENCRYPTION_KEY`。
