# 数据库迁移

目标数据库 PostgreSQL 17。M1 已加入首个身份与配置迁移，API 连接和领域 CRUD 仍按阶段实现。

在配置 `DATABASE_URL` 后运行：

```bash
npm run db:migrate --workspace @agent-workbench/api
```

迁移器使用 `schema_migrations` 表和 PostgreSQL advisory lock 保证单次应用；每个 SQL 文件在独立事务中执行。迁移文件只允许新增，不能修改已经应用的文件。

在 M1 确定迁移工具后，按 `0001_<description>.sql` 递增命名。已发布的迁移不可修改，修正用新迁移。初始迁移包含身份、工作空间和 Agent 版本，`0002_sessions.sql` 增加仅保存哈希令牌的会话表；Run、事件与审批跟随对应功能添加。

每个迁移需验证空库初始化和上一版本升级；涉及数据回填或删除时说明备份、锁表与恢复方案。`0011_shell_resource_usage.sql` 只增加可空 JSONB 列和对象类型约束，不回填历史执行结果。开发种子数据与结构迁移分开，不将固定生产账号或密钥写入迁移。

领域草案见 `docs/architecture/domain-model.md`。未明确的数据结构不要为了补目录提前创建空表。
