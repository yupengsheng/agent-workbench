# 测试规划

`npm run check` 执行格式、类型与构建检查。CI 随后运行 PostgreSQL 集成测试和浏览器回归测试；API 实例通过 Fastify inject 验证。

## 对话持久化回归

先执行 `npm run build`，准备测试 PostgreSQL，再运行：

```bash
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/test_db \
  node --test tests/integration/chat-history.test.mjs
npx playwright install chromium
npx playwright test --config tests/e2e/playwright.config.mjs
```

数据库测试创建随机 `chat_test_*` schema，执行全部迁移，结束时删除该 schema。连接账号需具备创建 schema 权限；仅用于测试数据库。没有 `TEST_DATABASE_URL` 时会显示跳过，不能计为验收通过。

文件变更审批集成测试：

```bash
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/test_db \
  node --test tests/integration/file-change-review.test.mjs
```

该测试使用独立 `review_test_*` schema，覆盖提案和审批状态的持久化、摘要/角色/资源隔离、重复决定、过期处理，以及 Runner 重新校验摘要后的原子应用。

Shell 命令审批集成测试：

```bash
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/test_db \
  node --test tests/integration/shell-command-review.test.mjs
```

该测试使用独立 `shell_review_test_*` schema，覆盖精确命令摘要、批准后一次性执行、结构化结果、失联后 `unknown` 终态，以及审计元数据不保存命令正文。

`chat-history.test.mjs` 还覆盖每轮模型调用、工具调用与 Jev 路由的结构化审计，验证失败/取消终态、Workspace 查询权限，以及审计元数据不包含提示词、模型输出、工具参数或密钥。

集成测试覆盖未登录、模型不存在、缺少密钥/加密主密钥、后台提交、成功与失败终态、事件顺序、用量、用户/工作空间隔离，以及 API 实例重建后的读取与续聊。使用本机模型模拟服务，不请求真实供应商；临时密钥和测试进程不会改变运行中 API 的配置。

浏览器测试使用接口夹具和真实 Vue 页面，覆盖刷新恢复期间禁止发送、恢复后续聊、清空后创建新会话、切换工作空间。还覆盖后台任务跨刷新继续查询、取消确认，以及 Shell 精确命令/沙箱边界的审批和执行结果展示。它不等同于真实模型端到端验收。

## 后续覆盖

后续目录随真实用例建立：

- `integration/`：数据库迁移、任务领取、审批恢复、执行事件投递。
- `e2e/`：用户创建任务、审批、查看子 Agent、下载产物的完整流程。
- `fixtures/`：最小代码仓库、网页和模型响应样例，不放真实用户数据。

模块单测与源码相邻，例如 `packages/runtime/src/loop.test.ts`。为状态、授权、取消、预算、失败与恢复等实际行为编写测试；不要为目录存在或静态常量重复写实现镜像测试。

真实模型质量测试单独按需运行，不作为每次 CI 的无界外网依赖。固定模型版本、样例和预算，报告结果变化而非只断言模型请求成功。

`web-fetch.test.mjs` 使用注入的 DNS 和传输响应验证网页策略，不依赖真实互联网。覆盖私网、环回、链路本地、元数据地址、IPv4 映射 IPv6、混合 DNS、跳转复检、HTTPS 降级、超时、取消、文本类型和工具默认关闭。

Runner 回归还验证竞争领取一次、同 Session 并发返回 409、重复取消幂等、运行中取消、过期 lease token 拒绝写回、配置变化、超时和 SIGTERM 对应的中止路径。

管理端审计浏览器回归同时覆盖模型日志范围查询、Jev 选择摘要、候选概率展开，以及原始提示内容不渲染。
