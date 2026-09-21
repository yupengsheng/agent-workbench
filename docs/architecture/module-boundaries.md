# 组件化与模块边界

状态：目标设计；当前已实现包见根 README。组件是可测试的职责边界，目录数不是成熟度指标。

## 控制面领域

| 模块      | 拥有的数据/职责              | 公开能力                        | 禁止依赖                     |
| --------- | ---------------------------- | ------------------------------- | ---------------------------- |
| identity  | 身份、会话、成员关系         | principal、workspace membership | 工具执行器                   |
| agents    | 草稿、完整配置版本           | 发布、读取不可变版本            | 供应商模型内部对象           |
| models    | 连接、能力、密钥引用         | 授权模型配置                    | 前端保存密钥                 |
| runs      | Run、租约、状态、工具台账    | 提交/取消/恢复/事件查询         | 直接运行命令                 |
| approvals | 参数摘要、截止时间、审批人   | 一次性决策                      | 独自启动任务、修改被批准参数 |
| artifacts | 元数据、授权访问             | 上传/下载引用                   | 任意宿主路径直出             |
| audit     | 操作记录、策略原因、版本关联 | 只读查询/授权导出               | 反向修改执行状态             |

模块对外通过显式 service/port，repository 只在所属模块内使用。跨模块变化通过应用服务和事务边界协调，不循环调用 repository。M1 建立 dependency-cruiser 等可执行边界检查；初期无需把每个领域拆成 npm 包。

## 执行面

`runner` 组装端口并管理租约/资源；`runtime` 推进执行；`tools` 校验和执行具体动作。模型、存储、沙箱适配器只在执行端启用。`contracts` 是公开边界，不携带数据库实体或供应商类。`packages/ui` 在第二个可复用生产组件出现时引入，不先生成空组件库。

## 当前服务端共享存储

`packages/persistence` 提供 Schema、数据库连接、托管密钥和 Run 事务，供 API 与 Runner 导入。runtime 只处理模型协议，不反向依赖该包；Web 只导入 contracts。原 API 存储文件保留重导出，数据库迁移仍在 database 统一管理，见 [ADR-0006](../decisions/0006-background-chat-runner.md)。

## Web 分层

```text
src/
  app/                  # 路由、权限装配、应用布局
  features/
    runs/               # 页面、请求、事件 reducer、领域组件
    agents/
    approvals/
    models/
    audit/
  components/           # 无领域副作用的组合组件
  lib/                  # API、SSE、缓存、错误映射
```

Vue Query 只管理服务端快照与失效，Run reducer 按序号处理事件；Pinia 只放筛选、面板和未提交草稿。禁止把同一个 Run 状态同时当作多个可写数据源。

## 设计组件到代码

| Figma 组件                | 生产职责                   | 变化维度                                           | 状态所有者       |
| ------------------------- | -------------------------- | -------------------------------------------------- | ---------------- |
| Button                    | 统一动作与加载/禁用表现    | primary/secondary/danger，default/disabled/loading | 调用页面         |
| StatusBadge               | 表达运行状态               | queued/running/waiting/succeeded/failed/cancelled  | Run/审批数据     |
| AppShell / Navigation     | 工作空间、主导航、面包屑   | desktop/compact                                    | 路由与 UI 偏好   |
| AgentCard                 | 角色、版本、工具范围       | enabled/draft/archived                             | agents           |
| RunTable / RunRow         | 列表、筛选、打开详情       | loading/empty/error/populated                      | runs query       |
| Timeline / ToolInvocation | 过程、参数、结果、来源     | pending/executing/result/denied/unknown            | 有序事件 reducer |
| ApprovalCard              | 精确操作、风险、决定与原因 | pending/approved/denied/expired                    | approvals        |
| ArtifactCard              | 产物与来源、预览/下载      | pending/ready/error                                | artifacts        |
| ModelConnectionCard       | 供应商、能力、连通状态     | ready/disconnected/disabled                        | models           |

Figma 组件变体不能替代服务端状态机；前端按钮禁用不能替代授权。共享 tokens 管颜色、字体、间距与圆角，不能在每页复制硬编码值。
