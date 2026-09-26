# ADR-0012：Shell 只在非特权沙箱中显式启用

- 状态：已实现基础执行边界、持久化审批和结果核对
- 日期：2026-09-25

## 背景

模型需要运行测试、查看构建结果和执行项目脚本，但让 API 进程或 Runner 直接调用宿主 `/bin/sh` 会暴露数据库、模型密钥和部署环境。工作区路径检查也不能阻止命令通过 `/proc`、环境变量或子进程接触宿主资源。

## 决策

1. `propose_shell_command` 只有在 Runner 环境 `AGENT_WORKBENCH_ENABLE_SHELL=true` 且模型连接声明 `shell=true` 时注册；模型提示不能自行打开能力。该工具只生成精确命令、原因和沙箱预算，不执行命令。
2. 执行器只接受 bubblewrap。命令在 UID/GID `65532`、独立 PID/网络/IPC/UTS/cgroup namespace 中运行，宿主系统目录只读挂载，工作区单独读写挂载，`HOME`、`PATH` 和 `LANG` 使用固定值，平台环境变量不透传。
3. 工作区中的 `.env`、`.aws`、`.ssh`、`.npmrc` 等常见凭证路径覆盖为空的 tmpfs；缺少 bubblewrap 时 fail closed，不回退到主机 Shell。
4. 提案以摘要绑定 Run、Step、命令全文、沙箱预算、策略版本和有效期。只有 Run 成功后，Session 所有者且非 viewer 才能批准。Runner 重新检查环境开关、模型连接状态和 `shell` 能力，再一次性领取执行。
5. 每次调用限制墙钟时长、CPU 秒数、虚拟内存、进程数和输出字节数。取消会终止整个进程组；超时、非零退出和输出超限以结构化结果返回。
6. 执行状态为 `not_started/executing/succeeded/failed/unknown`。Runner 在确认结果前失联时转为 `unknown`，不自动重试；stdout/stderr 受限保存，审计元数据不保存命令和输出。cgroup 级精确资源计量和工作区磁盘配额仍需后续完成。

## 验证

- 单元测试验证审批前不执行、缺少 bubblewrap 时不降级、UID 65532、工作区写入、取消和输出上限。
- PostgreSQL 集成测试覆盖摘要校验、幂等批准、一次性执行、结果回显、崩溃恢复为 `unknown`，以及审计不包含命令文本。
- 本地测试使用 `/usr/bin/bwrap`；部署环境若没有同等能力，Shell 会保持关闭并记录拒绝结果。
