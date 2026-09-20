# 执行事件、审计与回放

状态：协议草案，尚未实现事件存储与 WebSocket。

## 事件信封

每个持久化事件包含 eventId、workspaceId、sessionId、runId、parentRunId、sequence、type、timestamp、payload 和必要的 stepId/toolInvocationId。sequence 在单个 Run 内单调递增，唯一约束支持去重。

首批事件：run.created、run.started、run.status_changed、model.started、model.completed、tool.requested、tool.completed、approval.requested、approval.decided、artifact.created、run.finished。前端短文本增量可以合并传输，但最终文本/工具轮次必须持久化。

## 状态交接

Run 状态变更与对应事件尽量在同一数据库事务写入，持久化成功再通知订阅者。Runner 通过租约领取任务，数据库是状态事实来源。客户端网络连接不拥有任务生命周期。

MVP 计划用 WebSocket 做增量通知，REST 查询快照与历史事件；WebSocket 首帧或安全 Cookie 鉴权，不将访问 Token 放在 URL。主/子任务共用事件类型，以 runId 区分。

客户端保存最后消费的 sequence，重连时按游标补齐并去重。先拉快照再订阅时须处理竞态窗口，不能仅展示内存中尚在的事件。执行工具调用从已持久化状态协调，不能因重复订阅而再次执行。

## 审计与用量

管理审计、执行事件与模型用量语义不同：

- 管理审计回答谁修改了配置、权限和密钥引用。
- 执行事件回答某次 Run 做了什么、为什么被策略允许/拒绝、产生何种结果。
- 模型用量记录每次调用，包括重试、摘要、子任务等后台调用；费用只在有明确价格配置时计算，缺失价格显示未知。

三者通过用户、工作空间、Run、调用 ID 和配置版本关联。敏感参数按字段脱敏，原始产物受独立授权与保留策略控制。

## 回放边界

历史回放只展示已记录的轨迹，不再次执行工具。需要重新执行时创建新 Run 并重新校验权限。模型随机性、外部网页变化、工具版本和工作区变化意味着不能保证同输入得到同输出。
