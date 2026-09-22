# 工具与策略

首版提供 `read_file`、`glob` 和 `grep` 三个服务端只读工具。它们由 Runner 通过明确的工具注册表调用，工具自身不读取数据库、不使用模型，也不执行 Shell。

工具统一遵守以下边界：工作区路径由服务端根据 workspace ID 映射；绝对路径、路径穿越和解析后逃出工作区的符号链接都会被拒绝；文件、遍历数量和模型可见输出都有上限；参数错误、权限拒绝、取消和执行错误使用结构化状态。

工具定义和执行接口来自本包。后续写入、Shell、网页和 MCP 工具应在独立模块中加入确定性策略和审批，不应绕过此注册表。

实现参考了 Mao 的工具注册/描述思路（Mao MIT License，见 `docs/research/mao-reference.md`），本包保留独立实现与本项目 Apache-2.0 许可证，不复制 Mao 源文件。工具结果区分 success、error、denied、cancelled。
