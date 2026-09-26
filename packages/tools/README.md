# 工具与策略

首版提供 `read_file`、`glob`、`grep` 和 `analyze_workspace` 四个服务端只读工具。另有 `propose_file_change`，只生成需要审阅的精确文件变更预览。它们由 Runner 通过明确的工具注册表调用，工具自身不读取数据库、不使用模型。`propose_shell_command` 是显式双开关的受控工具：Runner 环境和模型连接都必须启用；它只生成审批目标，批准后由 Runner 通过 bubblewrap 非特权沙箱执行。`fetch_web_page` 也默认关闭，只有部署开关、模型能力和非空域名白名单同时满足才注册。

工具统一遵守以下边界：工作区路径由服务端根据 workspace ID 映射；绝对路径、路径穿越和解析后逃出工作区的符号链接都会被拒绝；文件、遍历数量和模型可见输出都有上限；参数错误、权限拒绝、取消和执行错误使用结构化状态。

工具定义和执行接口来自本包。Shell 的工作区、固定环境、网络隔离、进程组/cgroup 取消和资源上限由本包确定；生产调用方要求 systemd cgroup，缺少任一隔离能力时拒绝执行，不降级为宿主 Shell。工作区总逻辑字节在执行前、执行中和执行后扫描，并配合单文件上限；当前不依赖文件系统 project quota。网页工具只允许白名单 HTTP/HTTPS 主机与 80/443 端口，拒绝任一非公网 DNS 结果，并直接连接已校验 IP；跳转、总时长、响应字节和文本类型均受限。命令审批、领取和结果持久化位于 persistence/Runner；后续 MCP 工具应继续加入确定性策略和持久化审计，不应绕过此注册表。

`propose_file_change` 会读取工作区内已有的 UTF-8 文本文件，返回完整 unified diff、修改前后 SHA-256、字节数和 `approvalRequired` 标记。它不会创建文件、写盘或执行命令；批准后的实际应用由 Runner 单独领取并重新校验。256 KiB 文件上限和 32,000 字符预览上限用于避免把大内容直接送入模型上下文。

实现参考了 Mao 的工具注册/描述思路（Mao MIT License，见 `docs/research/mao-reference.md`），本包保留独立实现与本项目 Apache-2.0 许可证，不复制 Mao 源文件。工具结果区分 success、error、denied、cancelled。真正写入需要 Runner 审批执行阶段重新校验前置 SHA，并在非特权沙箱中执行。
