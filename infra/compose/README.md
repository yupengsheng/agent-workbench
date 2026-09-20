# 可选开发数据库

仅提供 PostgreSQL 17 开发环境；API 尚未接入数据库，当前 Web/API 启动无需此服务。不是完整生产部署方案。

需要时在根目录执行：

```bash
cp infra/compose/.env.example infra/compose/.env
```

编辑 `.env` 设置自己的本地密码，然后启动（需 Docker Engine 和 Compose v2）：

```bash
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps
```

默认仅暴露本机 5432；端口冲突时修改 POSTGRES_PORT。数据保存在命名卷中，不进入 Git。密码变更不会自动改变已初始化数据库的密码。

停止并保留数据：

```bash
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml down
```

不要在日常关闭时加 `--volumes`，它会删除数据库卷。API 数据库连接、迁移和应用服务容器会在对应里程碑中加入。
