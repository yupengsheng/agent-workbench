# Web 工作台

Vue 3 + Vite，当前包含 `/app` 用户工作台、`/admin` 管理员控制台基础壳、登录会话和真实 API 健康检查。Vite 将 `/api` 代理到 `http://127.0.0.1:4100`，访问默认入口 `http://127.0.0.1:5173`。

后续按业务建立 `src/features/agents`、`runs`、`approvals`、`settings`；公共展示组件放 `src/components`，HTTP / 事件客户端放 `src/lib`。路由、状态管理和 UI 组件库按首个业务需求引入。

MVP 将用户工作台 `/app` 与管理员控制台 `/admin` 放在同一 Web 应用，以路由和服务端权限区分；权限最终由 API 执行。浏览器不存模型密钥、不直接调用模型、不直接执行本地命令。飞书等第三方通道通过 API 适配器接入，不复用浏览器页面权限。

生产构建输出到 `dist/`；需反向代理将同域 `/api` 转发给 API。`vite preview` 只用于预览静态构建，不代表生产部署方案。
