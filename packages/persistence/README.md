# 服务端持久化

API 与 Runner 共用的 PostgreSQL Schema、连接工厂、Run 事务和托管模型密钥解析。公开子路径：`client`、`schema`、`secrets`、`runs`。只允许服务端应用导入；Web 使用 contracts DTO，runtime 不依赖本包。

`runs` 协调领取、续租、完成、取消和过期回收。追加事件前持有 Run 行锁；完成与对应事件原子提交。租约采用数据库时间和随机 token，旧执行者不能续租或写回。模型、Jev 路由和工具调用审计也在有效租约下写入；工具终态与 Step 在同一事务提交。审计使用字段白名单，不保存提示词、模型输出、工具参数、命令或密钥。

Schema 移自 API，原 API 文件仅保留兼容导出。没有复制第二套表。Runner 租约使用 `database/migrations/0006_runner_leases.sql`，文件变更审阅与应用使用 `0007`/`0008`，Shell 命令审阅与执行状态使用 `0009_shell_command_reviews.sql`，`0011_shell_resource_usage.sql` 增加 cgroup 与工作区资源用量。`file-changes` 和 `shell-commands` 持久化层负责提案查询、摘要校验、审批状态迁移、一次性领取/确认、审计和 Run 事件；真实文件写入和命令执行仍只在 Runner 执行面进行。

参数和策略见 [ADR-0006](../../docs/decisions/0006-background-chat-runner.md)。密钥加密格式保持 v1/AES-256-GCM，升级不轮换 `MODEL_SECRET_ENCRYPTION_KEY`。
