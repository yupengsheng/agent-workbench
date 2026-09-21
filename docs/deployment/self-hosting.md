# 私有化部署规划

状态：规划。当前有本地开发骨架、可选 PostgreSQL Compose，以及面向测试 ECS 的 Workbench CLI 发布流程；没有完整生产部署包。

## 测试环境自动部署

`.github/workflows/deploy-test.yml` 在 `main` 每次 push 后运行。流程会先执行 `npm run check`，再按以下命令安装 Workbench CLI：

```bash
curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash
```

随后工作流创建当前 commit 的归档，通过 Workbench CLI 上传到测试 ECS，在 `/opt/agent-workbench-test`（可配置）创建版本目录，执行 `npm ci`、`npm run check`，启动 API、Runner 和 Web 预览服务，并检查：

- API：`http://127.0.0.1:4100/healthz`
- Web：`http://127.0.0.1:5173/`

部署脚本还会安装 [`nginx-agent-workbench-test.conf`](../../infra/deploy/nginx-agent-workbench-test.conf)，执行 `nginx -t` 后 reload Nginx，将 `139.224.103.34/` 转发到 Web，将 `/api/` 转发到 API。

M1 测试数据库由 [`setup-test-db.sh`](../../infra/deploy/setup-test-db.sh) 初始化。它只在部署根目录没有 `.env` 时生成随机数据库密码，使用 Docker Compose 启动 PostgreSQL 17，并将连接串保存在权限为 `0600` 的远程文件中；后续发布自动读取该文件并执行未应用的迁移。

这是测试环境进程管理脚本，不具备生产级高可用、滚动升级或外部反向代理能力。服务默认只绑定测试 ECS 本机回环地址，需要通过已有内网反向代理或 Workbench 连接访问。

### GitHub 配置

在 GitHub 的 `test` Environment 中配置以下 Secrets：

| 名称                          | 用途                    |
| ----------------------------- | ----------------------- |
| `WORKBENCH_ACCESS_KEY_ID`     | 阿里云 AccessKey ID     |
| `WORKBENCH_ACCESS_KEY_SECRET` | 阿里云 AccessKey Secret |
| `WORKBENCH_TEST_INSTANCE_ID`  | 测试 ECS 实例 ID        |

可选 Variable：

| 名称                  | 默认值                      | 用途               |
| --------------------- | --------------------------- | ------------------ |
| `WORKBENCH_TEST_ROOT` | `/opt/agent-workbench-test` | 测试环境部署根目录 |

当前目标实例固定使用 `cn-shanghai`；迁移地域时同步修改工作流中的 `WORKBENCH_REGION`。

ECS 需要预装 Node.js 22.12+（或 Node.js 24）、npm 和 curl，并允许当前 Workbench 身份通过实例管理通道执行命令。Node.js 22 是现有开发环境的临时兼容版本，生产目标仍为 Node.js 24。凭据只在 GitHub runner 的临时 `~/.workbench/config.json` 中生成，文件权限为 `0600`，不写入仓库或远程发布目录。

首次启用前，应先在 GitHub Actions 手动运行 `Deploy test environment`，确认实例权限、Node 版本、端口和内网访问策略；通过后，后续 `main` 提交会自动部署。

## 交付顺序

1. 开发：Node + npm 启动 Web/API；数据库接入时使用开发 Compose。
2. 单组织试点：打包 Web/API/Runner，数据库与产物目录持久化，反向代理统一入口。
3. 生产交付：验证身份、授权、隔离、备份恢复、升级迁移、监控与运行手册。
4. 有明确需求后增加 Kubernetes/Helm、多执行节点和外部对象存储。

开发数据库配置见 `infra/compose/README.md`。没有启动或接入数据库前，不将健康检查成功描述为整个业务系统就绪。

## 配置与存储

开发运行数据放仓库忽略的 `.data/` 与 `.runtime/`，生产使用独立挂载卷。数据库、工作区、产物、审计和密钥分别定义保留/备份策略。文件下载经授权接口或短时访问凭证，不直接公开整个上传目录。

初始化创建管理员并设置密码；禁止内置已知生产密码。模型和外部工具连接在服务端保存，密钥由环境或专门密钥系统提供，不写入镜像或前端构建。

## 离线条件

可私有化与完全离线是不同条件。离线交付必须准备应用镜像、依赖与模型文件的内网来源，配置内网模型推理服务，禁止外部模型/搜索/遥测调用，并提供工具不可用提示。

MVP 离线验收针对文件分析、受限命令和报告生成；外部网页搜索不属于离线可用能力。硬件容量在模型和并发选定后通过实测确定。

## 升级与故障恢复

升级前备份数据库与产物，确认迁移兼容性，排空或续租运行任务。恢复测试必须覆盖 Run、审批、工具执行结果和任务租约；恢复 API 服务不代表任务可以安全继续。

数据库迁移遵循 `database/migrations/README.md`。应用回滚不自动回滚已产生的数据变更，须单独定义版本兼容与数据恢复方案。

## Runner 增量升级

`0006_runner_leases.sql` 为追加字段/索引迁移。发布脚本先构建和迁移，再停止上一版 Runner/API/Web，启动三个进程并确认 Runner PID 存活。API 与 Runner 共用原有 `.env`，不更换 `MODEL_SECRET_ENCRYPTION_KEY`。

本次 `/chat` 改为 202 提交协议，必须同时发布 Web 并刷新旧页面。若回退到仅支持同步 200 的版本，应先停止新 Runner，核对未结束任务后再切换；应用回滚不会移除新数据库字段。旧版无租约 running 记录会在 Runner 启动后标记失败，不自动重新请求模型。

Runner 日志与 PID 在部署根目录 `runtime/runner.log`、`runtime/runner.pid`。进程崩溃后的过期任务由仍活跃或重启后的 Runner 收敛；系统重启的自动拉起与生产进程监管仍需 M5 交付。
